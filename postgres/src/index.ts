/**
 * @absolutejs/errors-postgres — Postgres-backed, Effect-native `IssueStore`
 * for `@absolutejs/errors`. Durable grouped issues + an event timeline, with
 * **new vs. regression** detection resolved in a single atomic CTE upsert
 * (one round-trip, no transaction — so it works over Neon's HTTP driver too).
 *
 * Accepts any `postgres`-style tag-template client. Verified shapes:
 *   - `porsager/postgres` (`postgres('postgres://…')`).
 *   - `@neondatabase/serverless` (`neon('postgres://…')`).
 *
 * Effect-native: every method returns `Effect<_, IssueStoreError>`, mirroring
 * the in-memory reference store's semantics exactly (severity escalation,
 * resolved→unresolved regression flip, first/last release tracking).
 *
 * Schema (lazy — created on first call; idempotent). `<p>` = `tablePrefix`
 * (default `error`):
 *
 *   <p>_issues  (PK (project, fingerprint))  — one row per grouped issue
 *   <p>_events  (bigserial id)               — append-only occurrence log
 */
import {
  IssueStoreQueryError,
  IssueStoreSchemaError,
  IssueStoreSerializationError,
  issueCulprit,
  issueTitle,
  type CoalescedGroup,
  type IssueFilter,
  type IssueLevel,
  type IssueRecord,
  type IssueState,
  type IssueStore,
  type IssueStoreError,
  type IssueUpsertResult,
  type StoredEvent,
} from "@absolutejs/errors";
import { Effect, Option } from "effect";

/**
 * A `postgres-js` (`postgres('…')`) or Neon serverless (`neon('…')`)
 * tag-template client. Declared locally (rather than `import type { Sql } from
 * 'postgres'`) so `postgres` stays a truly optional peer.
 *
 * The PUBLIC surface is intentionally permissive: postgres-js's real `Sql` type
 * has heavily-overloaded call signatures (the `sql(array)` insert-helper form
 * returns a non-Promise `Helper`), so no precise hand-rolled structural type
 * cleanly subtypes it. A zero-extra-arg call returning `Promise<unknown[]>`
 * binds only to the tagged-template overload, which real drivers satisfy — so
 * consumers pass their client with NO cast. The adapter narrows to the precise
 * `SqlTag` once, internally (the one place a cast is justified: a third-party
 * driver boundary), keeping all query code fully typed.
 */
export type PostgresTag = {
  (strings: TemplateStringsArray, ...values: never[]): Promise<unknown[]>;
  unsafe: (sql: string, ...args: never[]) => Promise<unknown[]>;
};

/** The precise tag the adapter's own query code uses (T = row shape). */
type SqlTag = {
  <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  unsafe: (sql: string) => Promise<unknown[]>;
};

/** Strict identifier validation for the table prefix interpolated into DDL. */
const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type CreatePostgresIssueStoreOptions = {
  /** `postgres('…')` or `neon('…')` — both implement the same tag shape. */
  sql: PostgresTag;
  /**
   * Table-name prefix. Defaults to `'error'` → `error_issues` + `error_events`.
   * Validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (interpolated into DDL, not
   * a bind, so it must be sanitized).
   */
  tablePrefix?: string;
  /**
   * Run `CREATE TABLE IF NOT EXISTS` on first use. Default `true`. Set `false`
   * if you own the schema via migrations.
   */
  ensureSchema?: boolean;
};

/** Row shape returned by the issues queries. bigints arrive as strings. */
type IssueRow = {
  project: string;
  fingerprint: string;
  title: string;
  culprit: string | null;
  level: string;
  state: string;
  environment: string | null;
  first_seen: string | number;
  last_seen: string | number;
  times_seen: string | number;
  first_release: string | null;
  last_release: string | null;
  assignee: string | null;
};

type EventRow = {
  fingerprint: string;
  project: string;
  at: string | number;
  level: string;
  name: string;
  message: string;
  stack: string | null;
  release: string | null;
  environment: string | null;
  trace_id: string | null;
  span_id: string | null;
  replay_id: string | null;
  tags: unknown;
  extra: unknown;
};

const num = (v: string | number): number =>
  typeof v === "string" ? Number(v) : v;

const toIssueRecord = (row: IssueRow): IssueRecord => {
  const record: IssueRecord = {
    fingerprint: row.fingerprint,
    firstSeen: num(row.first_seen),
    lastSeen: num(row.last_seen),
    level: row.level as IssueLevel,
    project: row.project,
    state: row.state as IssueState,
    timesSeen: num(row.times_seen),
    title: row.title,
  };
  if (row.culprit !== null) record.culprit = row.culprit;
  if (row.environment !== null) record.environment = row.environment;
  if (row.first_release !== null) record.firstRelease = row.first_release;
  if (row.last_release !== null) record.lastRelease = row.last_release;
  if (row.assignee !== null) record.assignee = row.assignee;
  return record;
};

const parseJson = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
};

const toStoredEvent = (row: EventRow): StoredEvent => {
  const event: StoredEvent = {
    at: num(row.at),
    fingerprint: row.fingerprint,
    level: row.level as IssueLevel,
    message: row.message,
    name: row.name,
    project: row.project,
  };
  if (row.stack !== null) event.stack = row.stack;
  if (row.release !== null) event.release = row.release;
  if (row.environment !== null) event.environment = row.environment;
  if (row.trace_id !== null) event.traceId = row.trace_id;
  if (row.span_id !== null) event.spanId = row.span_id;
  if (row.replay_id !== null) event.replayId = row.replay_id;
  const tags = parseJson(row.tags);
  if (tags !== undefined) event.tags = tags as Record<string, string>;
  const extra = parseJson(row.extra);
  if (extra !== undefined) event.extra = extra;
  return event;
};

/** Severity rank as a SQL expression over a level-column reference. */
const rankOf = (col: string): string =>
  `CASE ${col} WHEN 'fatal' THEN 3 WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END`;

export const createPostgresIssueStore = (
  options: CreatePostgresIssueStoreOptions,
): IssueStore => {
  const prefix = options.tablePrefix ?? "error";
  if (!IDENTIFIER.test(prefix)) {
    throw new Error(
      `[errors-postgres] invalid tablePrefix "${prefix}"; must match ${IDENTIFIER.source}`,
    );
  }
  // Narrow the permissive public client to the precise tag the query code uses.
  // The only cast in the adapter — bridging postgres-js's un-subtypeable
  // overloaded `Sql` to a clean generic tag at the driver boundary.
  const sql = options.sql as unknown as SqlTag;
  const issues = `${prefix}_issues`;
  const events = `${prefix}_events`;
  const shouldEnsureSchema = options.ensureSchema ?? true;

  // --- lazy, memoized schema -------------------------------------------------
  let schemaPromise: Promise<void> | undefined;
  const ensureSchema: Effect.Effect<void, IssueStoreSchemaError> =
    Effect.tryPromise({
      catch: (cause) =>
        new IssueStoreSchemaError({ cause, op: "ensureSchema" }),
      try: () => {
        if (!shouldEnsureSchema) return Promise.resolve();
        if (schemaPromise !== undefined) return schemaPromise;
        const ddl = `
					CREATE TABLE IF NOT EXISTS ${issues} (
						project       text   NOT NULL,
						fingerprint   text   NOT NULL,
						title         text   NOT NULL,
						culprit       text,
						level         text   NOT NULL,
						state         text   NOT NULL DEFAULT 'unresolved',
						environment   text,
						first_seen    bigint NOT NULL,
						last_seen     bigint NOT NULL,
						times_seen    bigint NOT NULL DEFAULT 1,
						first_release text,
						last_release  text,
						assignee      text,
						PRIMARY KEY (project, fingerprint)
					);
					CREATE INDEX IF NOT EXISTS ${issues}_last_seen_idx ON ${issues} (project, last_seen DESC);
					CREATE INDEX IF NOT EXISTS ${issues}_state_idx     ON ${issues} (project, state);
					CREATE TABLE IF NOT EXISTS ${events} (
						id          bigserial PRIMARY KEY,
						project     text   NOT NULL,
						fingerprint text   NOT NULL,
						at          bigint NOT NULL,
						level       text   NOT NULL,
						name        text   NOT NULL,
						message     text   NOT NULL,
						stack       text,
						release     text,
						environment text,
						trace_id    text,
						span_id     text,
						replay_id   text,
						tags        jsonb,
						extra       jsonb
					);
					CREATE INDEX IF NOT EXISTS ${events}_issue_idx ON ${events} (project, fingerprint, at DESC);
				`;
        schemaPromise = sql.unsafe(ddl).then(() => undefined);
        return schemaPromise;
      },
    });

  const serialize = (
    value: Record<string, unknown> | undefined,
    fingerprint: string,
  ): Effect.Effect<string | null, IssueStoreSerializationError> =>
    value === undefined
      ? Effect.succeed(null)
      : Effect.try({
          catch: (cause) =>
            new IssueStoreSerializationError({ cause, fingerprint }),
          try: () => JSON.stringify(value),
        });

  // --- record: atomic read-prev + upsert-issue + insert-event ----------------
  const record = (
    event: StoredEvent,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      const title = issueTitle(event.name, event.message);
      const culprit = issueCulprit(event.stack);
      const culpritValue = culprit === "" ? null : culprit;
      const tagsJson = yield* serialize(event.tags, event.fingerprint);
      const extraJson = yield* serialize(event.extra, event.fingerprint);
      const release = event.release ?? null;
      const environment = event.environment ?? null;

      // Data-modifying CTEs all execute exactly once regardless of whether
      // the final SELECT reads them — so `ev` inserts the event, `up`
      // upserts the issue, `existing` captures the pre-update state (for
      // regression), all in one statement. `xmax = 0` ⇒ row was inserted.
      const rows = yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({
            cause,
            op: `record:${event.fingerprint}`,
          }),
        try: () =>
          sql<IssueRow & { is_new: boolean; prev_state: string | null }>`
						WITH existing AS (
							SELECT state AS prev_state
							FROM ${sql.unsafe(issues)}
							WHERE project = ${event.project} AND fingerprint = ${event.fingerprint}
						),
						ev AS (
							INSERT INTO ${sql.unsafe(events)} (
								project, fingerprint, at, level, name, message,
								stack, release, environment, trace_id, span_id, replay_id, tags, extra
							) VALUES (
								${event.project}, ${event.fingerprint}, ${event.at}, ${event.level},
								${event.name}, ${event.message}, ${event.stack ?? null},
								${release}, ${environment}, ${event.traceId ?? null},
								${event.spanId ?? null}, ${event.replayId ?? null},
								${tagsJson}::jsonb, ${extraJson}::jsonb
							)
						),
						up AS (
							INSERT INTO ${sql.unsafe(issues)} (
								project, fingerprint, title, culprit, level, state,
								environment, first_seen, last_seen, times_seen, first_release, last_release
							) VALUES (
								${event.project}, ${event.fingerprint}, ${title}, ${culpritValue},
								${event.level}, 'unresolved', ${environment},
								${event.at}, ${event.at}, 1, ${release}, ${release}
							)
							ON CONFLICT (project, fingerprint) DO UPDATE SET
								last_seen     = GREATEST(${sql.unsafe(issues)}.last_seen, EXCLUDED.last_seen),
								times_seen    = ${sql.unsafe(issues)}.times_seen + 1,
								level         = CASE WHEN ${sql.unsafe(rankOf("EXCLUDED.level"))}
								                        > ${sql.unsafe(rankOf(`${issues}.level`))}
								                     THEN EXCLUDED.level ELSE ${sql.unsafe(issues)}.level END,
								last_release  = COALESCE(EXCLUDED.last_release, ${sql.unsafe(issues)}.last_release),
								first_release = COALESCE(${sql.unsafe(issues)}.first_release, EXCLUDED.first_release),
								state         = CASE WHEN ${sql.unsafe(issues)}.state = 'resolved'
								                     THEN 'unresolved' ELSE ${sql.unsafe(issues)}.state END
							RETURNING
								project, fingerprint, title, culprit, level, state, environment,
								first_seen, last_seen, times_seen, first_release, last_release, assignee,
								(xmax = 0) AS is_new
						)
						SELECT up.*, existing.prev_state
						FROM up LEFT JOIN existing ON true
					`,
      });

      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(
          new IssueStoreQueryError({
            cause: new Error("upsert returned no row"),
            op: `record:${event.fingerprint}`,
          }),
        );
      }
      return {
        isNew: row.is_new === true,
        isRegression: row.is_new !== true && row.prev_state === "resolved",
        issue: toIssueRecord(row),
      };
    });

  // --- recordCoalesced: count-aware upsert + bulk sample insert, one statement.
  // Mirrors `record` exactly except the issue upsert adds `occurrences` to
  // times_seen and the `ev` CTE bulk-inserts the sample set via `unnest`. The
  // efficient path for the ingest buffer — one round-trip per fingerprint herd.
  const recordCoalesced = (
    group: CoalescedGroup,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      const rep = group.representative;
      const title = issueTitle(rep.name, rep.message);
      const culprit = issueCulprit(rep.stack);
      const culpritValue = culprit === "" ? null : culprit;
      const release = rep.release ?? null;
      const environment = rep.environment ?? null;

      // Column-oriented arrays for the `unnest` bulk insert.
      const projects: string[] = [];
      const fingerprints: string[] = [];
      const ats: number[] = [];
      const levels: string[] = [];
      const names: string[] = [];
      const messages: string[] = [];
      const stacks: (string | null)[] = [];
      const releases: (string | null)[] = [];
      const environments: (string | null)[] = [];
      const traceIds: (string | null)[] = [];
      const spanIds: (string | null)[] = [];
      const replayIds: (string | null)[] = [];
      const tagsArr: (string | null)[] = [];
      const extraArr: (string | null)[] = [];
      for (const sample of group.samples) {
        projects.push(sample.project);
        fingerprints.push(sample.fingerprint);
        ats.push(sample.at);
        levels.push(sample.level);
        names.push(sample.name);
        messages.push(sample.message);
        stacks.push(sample.stack ?? null);
        releases.push(sample.release ?? null);
        environments.push(sample.environment ?? null);
        traceIds.push(sample.traceId ?? null);
        spanIds.push(sample.spanId ?? null);
        replayIds.push(sample.replayId ?? null);
        tagsArr.push(yield* serialize(sample.tags, sample.fingerprint));
        extraArr.push(yield* serialize(sample.extra, sample.fingerprint));
      }

      const rows = yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({
            cause,
            op: `recordCoalesced:${rep.fingerprint}`,
          }),
        try: () =>
          sql<IssueRow & { is_new: boolean; prev_state: string | null }>`
						WITH existing AS (
							SELECT state AS prev_state
							FROM ${sql.unsafe(issues)}
							WHERE project = ${rep.project} AND fingerprint = ${rep.fingerprint}
						),
						ev AS (
							INSERT INTO ${sql.unsafe(events)} (
								project, fingerprint, at, level, name, message,
								stack, release, environment, trace_id, span_id, replay_id, tags, extra
							)
							SELECT * FROM unnest(
								${projects}::text[], ${fingerprints}::text[], ${ats}::bigint[], ${levels}::text[],
								${names}::text[], ${messages}::text[], ${stacks}::text[], ${releases}::text[],
								${environments}::text[], ${traceIds}::text[], ${spanIds}::text[], ${replayIds}::text[],
								${tagsArr}::jsonb[], ${extraArr}::jsonb[]
							)
						),
						up AS (
							INSERT INTO ${sql.unsafe(issues)} (
								project, fingerprint, title, culprit, level, state,
								environment, first_seen, last_seen, times_seen, first_release, last_release
							) VALUES (
								${rep.project}, ${rep.fingerprint}, ${title}, ${culpritValue},
								${rep.level}, 'unresolved', ${environment},
								${group.firstSeen}, ${group.lastSeen}, ${group.occurrences}, ${release}, ${release}
							)
							ON CONFLICT (project, fingerprint) DO UPDATE SET
								last_seen     = GREATEST(${sql.unsafe(issues)}.last_seen, EXCLUDED.last_seen),
								times_seen    = ${sql.unsafe(issues)}.times_seen + ${group.occurrences},
								level         = CASE WHEN ${sql.unsafe(rankOf("EXCLUDED.level"))}
								                        > ${sql.unsafe(rankOf(`${issues}.level`))}
								                     THEN EXCLUDED.level ELSE ${sql.unsafe(issues)}.level END,
								last_release  = COALESCE(EXCLUDED.last_release, ${sql.unsafe(issues)}.last_release),
								first_release = COALESCE(${sql.unsafe(issues)}.first_release, EXCLUDED.first_release),
								state         = CASE WHEN ${sql.unsafe(issues)}.state = 'resolved'
								                     THEN 'unresolved' ELSE ${sql.unsafe(issues)}.state END
							RETURNING
								project, fingerprint, title, culprit, level, state, environment,
								first_seen, last_seen, times_seen, first_release, last_release, assignee,
								(xmax = 0) AS is_new
						)
						SELECT up.*, existing.prev_state
						FROM up LEFT JOIN existing ON true
					`,
      });

      const row = rows[0];
      if (row === undefined) {
        return yield* Effect.fail(
          new IssueStoreQueryError({
            cause: new Error("upsert returned no row"),
            op: `recordCoalesced:${rep.fingerprint}`,
          }),
        );
      }
      return {
        isNew: row.is_new === true,
        isRegression: row.is_new !== true && row.prev_state === "resolved",
        issue: toIssueRecord(row),
      };
    });

  const listIssues = (
    filter: IssueFilter = {},
  ): Effect.Effect<IssueRecord[], IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      const limit = filter.limit ?? 100;
      const project = filter.project ?? null;
      const environment = filter.environment ?? null;
      const state = filter.state ?? null;
      const query = filter.query ?? null;
      const rows = yield* Effect.tryPromise({
        catch: (cause) => new IssueStoreQueryError({ cause, op: "listIssues" }),
        try: () =>
          sql<IssueRow>`
						SELECT project, fingerprint, title, culprit, level, state, environment,
							first_seen, last_seen, times_seen, first_release, last_release, assignee
						FROM ${sql.unsafe(issues)}
						WHERE
							(${project}::text IS NULL OR project = ${project})
							AND (${environment}::text IS NULL OR environment = ${environment})
							AND (${state}::text IS NULL OR state = ${state})
							AND (${query}::text IS NULL OR title ILIKE '%' || ${query ?? ""} || '%')
						ORDER BY last_seen DESC
						LIMIT ${limit}
					`,
      });
      return rows.map(toIssueRecord);
    });

  const getIssue = (
    project: string,
    fingerprint: string,
  ): Effect.Effect<Option.Option<IssueRecord>, IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      const rows = yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({ cause, op: `getIssue:${fingerprint}` }),
        try: () =>
          sql<IssueRow>`
						SELECT project, fingerprint, title, culprit, level, state, environment,
							first_seen, last_seen, times_seen, first_release, last_release, assignee
						FROM ${sql.unsafe(issues)}
						WHERE project = ${project} AND fingerprint = ${fingerprint}
						LIMIT 1
					`,
      });
      const row = rows[0];
      return row === undefined
        ? Option.none()
        : Option.some(toIssueRecord(row));
    });

  const setState = (
    project: string,
    fingerprint: string,
    state: IssueState,
  ): Effect.Effect<void, IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({
            cause,
            op: `setState:${fingerprint}`,
          }),
        try: () =>
          sql`
						UPDATE ${sql.unsafe(issues)}
						SET state = ${state}
						WHERE project = ${project} AND fingerprint = ${fingerprint}
					`,
      });
    });

  const assign = (
    project: string,
    fingerprint: string,
    assignee: string | null,
  ): Effect.Effect<void, IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({ cause, op: `assign:${fingerprint}` }),
        try: () =>
          sql`
						UPDATE ${sql.unsafe(issues)}
						SET assignee = ${assignee}
						WHERE project = ${project} AND fingerprint = ${fingerprint}
					`,
      });
    });

  const listEvents = (
    project: string,
    fingerprint: string,
    limit = 50,
  ): Effect.Effect<StoredEvent[], IssueStoreError> =>
    Effect.gen(function* () {
      yield* ensureSchema;
      const rows = yield* Effect.tryPromise({
        catch: (cause) =>
          new IssueStoreQueryError({
            cause,
            op: `listEvents:${fingerprint}`,
          }),
        try: () =>
          sql<EventRow>`
						SELECT project, fingerprint, at, level, name, message, stack,
							release, environment, trace_id, span_id, replay_id, tags, extra
						FROM ${sql.unsafe(events)}
						WHERE project = ${project} AND fingerprint = ${fingerprint}
						ORDER BY at DESC
						LIMIT ${limit}
					`,
      });
      return rows.map(toStoredEvent);
    });

  return {
    assign,
    getIssue,
    listEvents,
    listIssues,
    record,
    recordCoalesced,
    setState,
  };
};
