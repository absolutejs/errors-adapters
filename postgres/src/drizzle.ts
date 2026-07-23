import {
  IssueStoreQueryError,
  IssueStoreSerializationError,
  issueCulprit,
  issueTitle,
  type CoalescedGroup,
  type IssueFilter,
  type IssueRecord,
  type IssueState,
  type IssueStore,
  type IssueStoreError,
  type IssueUpsertResult,
  type StoredEvent,
} from "@absolutejs/errors";
import { Effect, Option } from "effect";
import {
  and,
  desc,
  eq,
  getTableColumns,
  ilike,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  bigint,
  bigserial,
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";

const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});

export const errorIssues = pgTable(
  "error_issues",
  {
    assignee: text(),
    culprit: text(),
    environment: text(),
    fingerprint: text().notNull(),
    first_release: text(),
    first_seen: bigint({ mode: "number" }).notNull(),
    last_release: text(),
    last_seen: bigint({ mode: "number" }).notNull(),
    level: text().$type<StoredEvent["level"]>().notNull(),
    project: text().notNull(),
    state: text().$type<IssueState>().notNull().default("unresolved"),
    times_seen: bigint({ mode: "number" }).notNull().default(1),
    title: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.project, table.fingerprint] }),
    index("error_issues_last_seen_idx").on(
      table.project,
      table.last_seen.desc(),
    ),
    index("error_issues_state_idx").on(table.project, table.state),
  ],
);

export const errorEvents = pgTable(
  "error_events",
  {
    at: bigint({ mode: "number" }).notNull(),
    environment: text(),
    extra: portableJsonb().$type<Record<string, unknown>>(),
    fingerprint: text().notNull(),
    id: bigserial({ mode: "number" }).primaryKey(),
    level: text().$type<StoredEvent["level"]>().notNull(),
    message: text().notNull(),
    name: text().notNull(),
    project: text().notNull(),
    release: text(),
    replay_id: text(),
    span_id: text(),
    stack: text(),
    tags: portableJsonb().$type<Record<string, string>>(),
    trace_id: text(),
  },
  (table) => [
    index("error_events_issue_idx").on(
      table.project,
      table.fingerprint,
      table.at.desc(),
    ),
  ],
);

export const errorDrizzleSchema = { errorEvents, errorIssues };

type AnyPgDatabase = PgAsyncDatabase<any, any>;
export type CreateDrizzleIssueStoreOptions<DB extends AnyPgDatabase> = {
  db: DB;
};

const issueFrom = (row: typeof errorIssues.$inferSelect): IssueRecord => ({
  ...(row.assignee === null ? {} : { assignee: row.assignee }),
  ...(row.culprit === null ? {} : { culprit: row.culprit }),
  ...(row.environment === null ? {} : { environment: row.environment }),
  fingerprint: row.fingerprint,
  ...(row.first_release === null ? {} : { firstRelease: row.first_release }),
  firstSeen: row.first_seen,
  ...(row.last_release === null ? {} : { lastRelease: row.last_release }),
  lastSeen: row.last_seen,
  level: row.level,
  project: row.project,
  state: row.state,
  timesSeen: row.times_seen,
  title: row.title,
});

const eventFrom = (row: typeof errorEvents.$inferSelect): StoredEvent => ({
  at: row.at,
  ...(row.environment === null ? {} : { environment: row.environment }),
  ...(row.extra === null ? {} : { extra: row.extra }),
  fingerprint: row.fingerprint,
  level: row.level,
  message: row.message,
  name: row.name,
  project: row.project,
  ...(row.release === null ? {} : { release: row.release }),
  ...(row.replay_id === null ? {} : { replayId: row.replay_id }),
  ...(row.span_id === null ? {} : { spanId: row.span_id }),
  ...(row.stack === null ? {} : { stack: row.stack }),
  ...(row.tags === null ? {} : { tags: row.tags }),
  ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
});

const query = <Value>(
  op: string,
  operation: () => Promise<Value>,
): Effect.Effect<Value, IssueStoreQueryError> =>
  Effect.tryPromise({
    catch: (cause) => new IssueStoreQueryError({ cause, op }),
    try: operation,
  });

const serializable = <Value extends Record<string, unknown>>(
  value: Value | undefined,
  fingerprint: string,
): Effect.Effect<Value | undefined, IssueStoreSerializationError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Effect.try({
        catch: (cause) =>
          new IssueStoreSerializationError({ cause, fingerprint }),
        try: () => {
          JSON.stringify(value);
          return value;
        },
      });

const rank = (level: SQL | typeof errorIssues.level) =>
  sql`CASE ${level}
    WHEN 'fatal' THEN 3
    WHEN 'error' THEN 2
    WHEN 'warning' THEN 1
    ELSE 0
  END`;

const eventValue = (
  event: StoredEvent,
  tags: Record<string, string> | undefined,
  extra: Record<string, unknown> | undefined,
) => ({
  at: event.at,
  environment: event.environment,
  extra,
  fingerprint: event.fingerprint,
  level: event.level,
  message: event.message,
  name: event.name,
  project: event.project,
  release: event.release,
  replay_id: event.replayId,
  span_id: event.spanId,
  stack: event.stack,
  tags,
  trace_id: event.traceId,
});

export const createDrizzleIssueStore = <DB extends AnyPgDatabase>({
  db,
}: CreateDrizzleIssueStoreOptions<DB>): IssueStore => {
  const upsert = (
    representative: StoredEvent,
    occurrences: number,
    firstSeen: number,
    lastSeen: number,
    samples: StoredEvent[],
    op: string,
  ): Effect.Effect<IssueUpsertResult, IssueStoreError> =>
    Effect.gen(function* () {
      const encoded: ReturnType<typeof eventValue>[] = [];
      for (const sample of samples) {
        const tags = yield* serializable(sample.tags, sample.fingerprint);
        const extra = yield* serializable(sample.extra, sample.fingerprint);
        encoded.push(eventValue(sample, tags, extra));
      }
      return yield* query(op, () =>
        db.transaction(async (transaction) => {
          const [existing] = await transaction
            .select({ state: errorIssues.state })
            .from(errorIssues)
            .where(
              and(
                eq(errorIssues.project, representative.project),
                eq(errorIssues.fingerprint, representative.fingerprint),
              ),
            )
            .for("update");
          if (encoded.length > 0)
            await transaction.insert(errorEvents).values(encoded);
          const culprit = issueCulprit(representative.stack);
          const [stored] = await transaction
            .insert(errorIssues)
            .values({
              culprit: culprit === "" ? null : culprit,
              environment: representative.environment,
              fingerprint: representative.fingerprint,
              first_release: representative.release,
              first_seen: firstSeen,
              last_release: representative.release,
              last_seen: lastSeen,
              level: representative.level,
              project: representative.project,
              times_seen: occurrences,
              title: issueTitle(representative.name, representative.message),
            })
            .onConflictDoUpdate({
              set: {
                first_release: sql`coalesce(${errorIssues.first_release}, excluded.first_release)`,
                last_release: sql`coalesce(excluded.last_release, ${errorIssues.last_release})`,
                last_seen: sql`greatest(${errorIssues.last_seen}, excluded.last_seen)`,
                level: sql`case when ${rank(sql`excluded.level`)} > ${rank(errorIssues.level)}
                  then excluded.level else ${errorIssues.level} end`,
                state: sql`case when ${errorIssues.state} = 'resolved'
                  then 'unresolved' else ${errorIssues.state} end`,
                times_seen: sql`${errorIssues.times_seen} + ${occurrences}`,
              },
              target: [errorIssues.project, errorIssues.fingerprint],
            })
            .returning({
              ...getTableColumns(errorIssues),
              inserted: sql<boolean>`xmax = 0`,
            });
          if (!stored) throw new Error("Issue upsert returned no row");
          return {
            isNew: stored.inserted,
            isRegression: !stored.inserted && existing?.state === "resolved",
            issue: issueFrom(stored),
          };
        }),
      );
    });

  return {
    assign: (project, fingerprint, assignee) =>
      query(`assign:${fingerprint}`, async () => {
        await db
          .update(errorIssues)
          .set({ assignee })
          .where(
            and(
              eq(errorIssues.project, project),
              eq(errorIssues.fingerprint, fingerprint),
            ),
          );
      }),
    getIssue: (project, fingerprint) =>
      Effect.map(
        query(`getIssue:${fingerprint}`, () =>
          db
            .select()
            .from(errorIssues)
            .where(
              and(
                eq(errorIssues.project, project),
                eq(errorIssues.fingerprint, fingerprint),
              ),
            )
            .limit(1),
        ),
        ([row]) => (row ? Option.some(issueFrom(row)) : Option.none()),
      ),
    listEvents: (project, fingerprint, limit = 50) =>
      Effect.map(
        query(`listEvents:${fingerprint}`, () =>
          db
            .select()
            .from(errorEvents)
            .where(
              and(
                eq(errorEvents.project, project),
                eq(errorEvents.fingerprint, fingerprint),
              ),
            )
            .orderBy(desc(errorEvents.at), desc(errorEvents.id))
            .limit(limit),
        ),
        (rows) => rows.map(eventFrom),
      ),
    listIssues: (filter: IssueFilter = {}) => {
      const conditions = [
        filter.project ? eq(errorIssues.project, filter.project) : undefined,
        filter.environment
          ? eq(errorIssues.environment, filter.environment)
          : undefined,
        filter.state ? eq(errorIssues.state, filter.state) : undefined,
        filter.query
          ? ilike(errorIssues.title, `%${filter.query}%`)
          : undefined,
      ];
      return Effect.map(
        query("listIssues", () =>
          db
            .select()
            .from(errorIssues)
            .where(and(...conditions))
            .orderBy(desc(errorIssues.last_seen))
            .limit(filter.limit ?? 100),
        ),
        (rows) => rows.map(issueFrom),
      );
    },
    record: (event) =>
      upsert(
        event,
        1,
        event.at,
        event.at,
        [event],
        `record:${event.fingerprint}`,
      ),
    recordCoalesced: (group: CoalescedGroup) =>
      upsert(
        group.representative,
        group.occurrences,
        group.firstSeen,
        group.lastSeen,
        group.samples,
        `recordCoalesced:${group.representative.fingerprint}`,
      ),
    setState: (project, fingerprint, state) =>
      query(`setState:${fingerprint}`, async () => {
        await db
          .update(errorIssues)
          .set({ state })
          .where(
            and(
              eq(errorIssues.project, project),
              eq(errorIssues.fingerprint, fingerprint),
            ),
          );
      }),
  };
};
