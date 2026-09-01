/**
 * Issue triage — what an application does with grouped errors once it has them.
 *
 * The issue store answers "what broke and how often". A triage board answers
 * the questions a person actually asks in front of it: what is breaking now,
 * who is on it, did the fix hold, and which release introduced this. Every
 * application that puts a board on top of the store writes the same queries
 * for that — the same regression derivation, the same zero-filled sparkline,
 * the same severity grouping, the same per-release rollup for a deployments
 * ledger — so they live here, over the tables the store already owns.
 *
 * Reads and writes go through Drizzle directly rather than the Effect store:
 * these are dashboard queries with filters, paging and grouping, not the
 * capture path, and nothing here is on a request's critical path.
 */
import type { IssueState, StoredEvent } from "@absolutejs/errors";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgAsyncDatabase } from "drizzle-orm/pg-core";
import { errorEvents, errorIssues } from "./drizzle";

type AnyPgDatabase = PgAsyncDatabase<any, any>;

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_LIMIT = 200;
const DEFAULT_EVENT_SAMPLES = 50;
const DEFAULT_OCCURRENCE_DAYS = 14;

/** Levels grouped so that "errors" and "warnings" together cover every issue
 *  and none is unreachable from the filter chips. */
type IssueLevel = StoredEvent["level"];
const ERROR_LEVELS: IssueLevel[] = ["error", "fatal"];
const WARNING_LEVELS: IssueLevel[] = ["warning", "info"];

export type IssueSeverity = "error" | "warning";

/** The dashboard shape: the stored row, camel-cased, plus the two things only
 *  a comparison of its columns can tell you. */
export type TriageIssue = {
  assignee: string | null;
  culprit: string | null;
  environment: string | null;
  fingerprint: string;
  firstRelease: string | null;
  firstSeen: number;
  /** Unresolved, previously resolved, and seen again since — the fix did not
   *  hold. A different problem from "this is broken", and usually a sign the
   *  fix addressed a symptom. */
  isRegression: boolean;
  lastRelease: string | null;
  lastSeen: number;
  level: IssueLevel;
  /** For a regression: the release it came back in. */
  regressedRelease: string | null;
  resolutionNote: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  /** The release it was declared fixed in — for a regression, what broke. */
  resolvedRelease: string | null;
  state: IssueState;
  timesSeen: number;
  title: string;
};

const asIssueState = (state: string): IssueState =>
  state === "resolved" || state === "ignored" ? state : "unresolved";

/**
 * Derive the view a board renders.
 *
 * The ingest upsert flips a resolved issue back to `unresolved` when it recurs,
 * but leaves `resolved_at` in place. That surviving stamp is the entire basis
 * of regression detection: unresolved + a resolution stamp + activity after it
 * means somebody closed this and it came back.
 */
export const toTriageIssue = (
  row: typeof errorIssues.$inferSelect,
): TriageIssue => {
  const isRegression =
    row.state === "unresolved" &&
    row.resolved_at !== null &&
    row.last_seen > row.resolved_at;

  return {
    assignee: row.assignee,
    culprit: row.culprit,
    environment: row.environment,
    fingerprint: row.fingerprint,
    firstRelease: row.first_release,
    firstSeen: row.first_seen,
    isRegression,
    lastRelease: row.last_release,
    lastSeen: row.last_seen,
    level: row.level,
    regressedRelease: isRegression ? row.last_release : null,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedRelease: row.resolved_release,
    state: asIssueState(row.state),
    timesSeen: Number(row.times_seen),
    title: row.title,
  };
};

export type IssueListQuery = {
  limit?: number;
  offset?: number;
  /** Substring match on the title. */
  query?: string;
  /** Issues touching this release: first seen, last seen, or declared fixed
   *  under it — the deep link from a deployments page. */
  release?: string;
  severity?: IssueSeverity;
  state?: IssueState;
};

export type IssueOccurrence = {
  /** Whole days since the epoch, so a client can render without a timezone. */
  day: number;
  count: number;
};

export type SetIssueStateOptions = {
  /** Who closed it. */
  by?: string | null;
  /** Why. */
  note?: string | null;
  /** The release it is being declared fixed in. */
  release?: string | null;
};

export type ReleaseIssueStats = {
  /** Declared fixed in this release. */
  fixed: number;
  /** First seen under this release. */
  newIssues: number;
  /** Carried in from an earlier release and still occurring. */
  ongoing: number;
  /** Closed before this release and back in it. */
  regressions: number;
};

export type ReleaseIssueReport = ReleaseIssueStats & {
  byCategory: Record<IssueSeverity, ReleaseIssueStats>;
};

const EMPTY_STATS: ReleaseIssueStats = {
  fixed: 0,
  newIssues: 0,
  ongoing: 0,
  regressions: 0,
};

export const emptyReleaseIssueReport = (): ReleaseIssueReport => ({
  byCategory: {
    error: { ...EMPTY_STATS },
    warning: { ...EMPTY_STATS },
  },
  ...EMPTY_STATS,
});

const severityOf = (level: IssueLevel): IssueSeverity =>
  ERROR_LEVELS.includes(level) ? "error" : "warning";

export type CreateIssueTriageOptions<DB extends AnyPgDatabase> = {
  db: DB;
  /** Issue scope. One application's board never shows another's. */
  project: string;
  /**
   * Only count issues carrying a release stamp. Applications that persist
   * issues from deployed builds only use this to keep anything a local run
   * left behind out of the board. Default true.
   */
  deployedOnly?: boolean;
  /** Issues per page when a query does not say. Default 100. */
  defaultLimit?: number;
  /** Ceiling on a caller-supplied limit. Default 200. */
  maxLimit?: number;
  /** Sample events kept with an issue detail. Default 50. */
  eventSamples?: number;
  /**
   * Rows this board does not triage — a title pattern for telemetry an older
   * release wrote into the issues table, say. Applied to every read.
   */
  exclude?: (row: typeof errorIssues.$inferSelect) => boolean;
};

/**
 * The queries behind an issue board, bound to one project.
 *
 * Returned as an object rather than loose functions so `project` and the paging
 * limits are stated once: every call in an application otherwise repeats them,
 * and a single missed `project` filter shows one deployment's issues on
 * another's board.
 */
export const createIssueTriage = <DB extends AnyPgDatabase>(
  options: CreateIssueTriageOptions<DB>,
) => {
  const {
    db,
    defaultLimit = DEFAULT_LIMIT,
    deployedOnly = true,
    eventSamples = DEFAULT_EVENT_SAMPLES,
    exclude,
    maxLimit = DEFAULT_MAX_LIMIT,
    project,
  } = options;

  const scope = (): SQL[] => {
    const filters: SQL[] = [eq(errorIssues.project, project)];
    if (deployedOnly) filters.push(isNotNull(errorIssues.last_release));

    return filters;
  };

  const kept = (rows: (typeof errorIssues.$inferSelect)[]) =>
    exclude === undefined ? rows : rows.filter((row) => !exclude(row));

  /** Newest activity first, because a board is read top-down and the thing
   *  happening right now is the thing worth seeing first. */
  const list = async (query: IssueListQuery = {}) => {
    const limit = Math.min(query.limit ?? defaultLimit, maxLimit);
    const offset = Math.max(query.offset ?? 0, 0);
    const filters = scope();
    if (query.state !== undefined)
      filters.push(eq(errorIssues.state, query.state));
    if (query.query !== undefined && query.query !== "")
      filters.push(ilike(errorIssues.title, `%${query.query}%`));
    if (query.release !== undefined && query.release !== "") {
      const releaseMatch = or(
        eq(errorIssues.first_release, query.release),
        eq(errorIssues.last_release, query.release),
        eq(errorIssues.resolved_release, query.release),
      );
      if (releaseMatch !== undefined) filters.push(releaseMatch);
    }
    if (query.severity === "error")
      filters.push(inArray(errorIssues.level, ERROR_LEVELS));
    else if (query.severity === "warning")
      filters.push(inArray(errorIssues.level, WARNING_LEVELS));

    const where = and(...filters);
    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(errorIssues)
        .where(where)
        .orderBy(desc(errorIssues.last_seen))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(errorIssues).where(where),
    ]);

    return {
      issues: kept(rows).map(toTriageIssue),
      total: Number(totalRow?.value ?? 0),
    };
  };

  /** Counts per state, so filter chips can carry numbers without a round trip
   *  each. */
  const stateCounts = async () => {
    const rows = await db
      .select({
        count: sql<number>`count(*)::int`,
        state: errorIssues.state,
      })
      .from(errorIssues)
      .where(and(...scope()))
      .groupBy(errorIssues.state);

    return rows.map((row) => ({
      count: Number(row.count),
      state: asIssueState(row.state),
    }));
  };

  const get = async (fingerprint: string) => {
    const [row] = await db
      .select()
      .from(errorIssues)
      .where(
        and(
          eq(errorIssues.project, project),
          eq(errorIssues.fingerprint, fingerprint),
        ),
      )
      .limit(1);
    if (row === undefined) return null;

    const events = await db
      .select()
      .from(errorEvents)
      .where(
        and(
          eq(errorEvents.project, project),
          eq(errorEvents.fingerprint, fingerprint),
        ),
      )
      .orderBy(desc(errorEvents.at))
      .limit(eventSamples);

    return { events, issue: toTriageIssue(row) };
  };

  /**
   * Daily counts for a sparkline, zero-filled.
   *
   * Dense on purpose: without the fill, a quiet week reads as a flat line at
   * whatever the last busy day was — the opposite of the truth.
   */
  const occurrences = async (
    fingerprint: string,
    days = DEFAULT_OCCURRENCE_DAYS,
  ): Promise<IssueOccurrence[]> => {
    const since = Date.now() - days * DAY_MS;
    const rows = await db
      .select({
        bucket: sql<number>`floor(${errorEvents.at} / ${DAY_MS})`.as("bucket"),
        count: sql<number>`count(*)::int`,
      })
      .from(errorEvents)
      .where(
        and(
          eq(errorEvents.project, project),
          eq(errorEvents.fingerprint, fingerprint),
          gte(errorEvents.at, since),
        ),
      )
      // Group by the first select item. Naming the expression again would emit
      // a second parameter placeholder that does not match the first.
      .groupBy(sql`1`);

    const counts = new Map(rows.map((row) => [Number(row.bucket), row.count]));
    const start = Math.floor(Date.now() / DAY_MS) - days + 1;

    return Array.from({ length: days }, (_unused, index) => ({
      count: Number(counts.get(start + index) ?? 0),
      day: start + index,
    }));
  };

  /**
   * Close, mute, or reopen an issue.
   *
   * Closing stamps the trail — who, when, why, which release. Reopening clears
   * it, because a manual reopen is a decision rather than a regression, and a
   * surviving `resolved_at` would make the next recurrence look like a fix
   * that failed.
   */
  const setState = async (
    fingerprint: string,
    state: IssueState,
    stateOptions: SetIssueStateOptions = {},
  ) => {
    const closing = state === "resolved" || state === "ignored";
    const resolution = closing
      ? {
          resolution_note: stateOptions.note ?? null,
          resolved_at: Date.now(),
          resolved_by: stateOptions.by ?? null,
          resolved_release: stateOptions.release ?? null,
        }
      : {
          resolution_note: null,
          resolved_at: null,
          resolved_by: null,
          resolved_release: null,
        };
    const [saved] = await db
      .update(errorIssues)
      .set({ state, ...resolution })
      .where(
        and(
          eq(errorIssues.project, project),
          eq(errorIssues.fingerprint, fingerprint),
        ),
      )
      .returning();

    return saved === undefined ? null : toTriageIssue(saved);
  };

  const assign = async (fingerprint: string, assignee: string | null) => {
    const [saved] = await db
      .update(errorIssues)
      .set({ assignee })
      .where(
        and(
          eq(errorIssues.project, project),
          eq(errorIssues.fingerprint, fingerprint),
        ),
      )
      .returning();

    return saved === undefined ? null : toTriageIssue(saved);
  };

  /**
   * Per-release rollup for a deployments ledger: for each release, how many
   * issues were introduced under it, carried in from before it, came back in
   * it, or were declared fixed in it.
   *
   * One query rather than one per column, and split by severity — a deployment
   * that introduced three warnings is not the same news as one that introduced
   * three errors, and a ledger that paints both red gets ignored.
   */
  const releaseStats = async (releases: readonly string[]) => {
    const stats = new Map<string, ReleaseIssueReport>();
    const unique = [...new Set(releases)];
    if (unique.length === 0) return stats;
    const wanted = new Set(unique);

    const ensure = (release: string) => {
      const existing = stats.get(release);
      if (existing !== undefined) return existing;
      const created = emptyReleaseIssueReport();
      stats.set(release, created);

      return created;
    };

    const releaseMatch = or(
      inArray(errorIssues.first_release, unique),
      inArray(errorIssues.last_release, unique),
      inArray(errorIssues.resolved_release, unique),
    );
    const rows = await db
      .select()
      .from(errorIssues)
      .where(
        releaseMatch === undefined
          ? eq(errorIssues.project, project)
          : and(eq(errorIssues.project, project), releaseMatch),
      );

    const increment = (
      release: string | null,
      severity: IssueSeverity,
      field: keyof ReleaseIssueStats,
    ) => {
      if (release === null || !wanted.has(release)) return;
      const report = ensure(release);
      report[field] += 1;
      report.byCategory[severity][field] += 1;
    };

    for (const row of kept(rows)) {
      const severity = severityOf(row.level);
      increment(row.first_release, severity, "newIssues");
      // Ongoing means carried in: still open, never resolved, and last seen
      // under a different release than the one it appeared in.
      increment(
        row.state === "unresolved" &&
          row.resolved_at === null &&
          row.first_release !== row.last_release
          ? row.last_release
          : null,
        severity,
        "ongoing",
      );
      increment(
        row.state === "unresolved" &&
          row.resolved_at !== null &&
          row.last_seen > row.resolved_at
          ? row.last_release
          : null,
        severity,
        "regressions",
      );
      increment(
        row.state === "resolved" ? row.resolved_release : null,
        severity,
        "fixed",
      );
    }

    return stats;
  };

  return {
    assign,
    get,
    list,
    occurrences,
    releaseStats,
    setState,
    stateCounts,
  };
};

export type IssueTriage = ReturnType<typeof createIssueTriage>;
