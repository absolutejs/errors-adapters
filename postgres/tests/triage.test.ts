/**
 * Triage tests against real Postgres (PGlite, in-process).
 *
 * The regression derivation and the release rollup are both read off column
 * comparisons rather than a stored flag, so they are only correct if the SQL
 * and the ordering are — which a mock would not catch.
 */
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { createIssueTriage, errorEvents, errorIssues } from "../src/index";

const DAY_MS = 86_400_000;

type IssueSeed = Partial<typeof errorIssues.$inferInsert> & {
  fingerprint: string;
};

let db: ReturnType<typeof drizzle>;
let triage: ReturnType<typeof createIssueTriage>;

const seedIssue = (over: IssueSeed) =>
  db.insert(errorIssues).values({
    first_seen: 1_000,
    last_release: "r1",
    last_seen: 2_000,
    level: "error",
    project: "acme",
    title: `issue ${over.fingerprint}`,
    ...over,
  });

beforeEach(async () => {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE error_issues (
      project text NOT NULL, fingerprint text NOT NULL, title text NOT NULL,
      culprit text, level text NOT NULL, state text NOT NULL DEFAULT 'unresolved',
      environment text, first_seen bigint NOT NULL, last_seen bigint NOT NULL,
      times_seen bigint NOT NULL DEFAULT 1, first_release text, last_release text,
      assignee text, resolved_at bigint, resolved_by text,
      resolved_release text, resolution_note text,
      PRIMARY KEY (project, fingerprint)
    );
    CREATE TABLE error_events (
      id bigserial PRIMARY KEY, project text NOT NULL, fingerprint text NOT NULL,
      at bigint NOT NULL, level text NOT NULL, name text NOT NULL,
      message text NOT NULL, stack text, release text, environment text,
      trace_id text, span_id text, replay_id text, tags jsonb, extra jsonb
    );
  `);
  db = drizzle({ client });
  triage = createIssueTriage({ db, project: "acme" });
});

describe("regression detection", () => {
  test("a resolution stamp with later activity is a regression", async () => {
    await seedIssue({
      fingerprint: "fp-regressed",
      last_release: "r3",
      last_seen: 5_000,
      resolved_at: 4_000,
      resolved_release: "r2",
      state: "unresolved",
    });
    const { issues } = await triage.list();

    expect(issues[0]?.isRegression).toBe(true);
    expect(issues[0]?.regressedRelease).toBe("r3");
    expect(issues[0]?.resolvedRelease).toBe("r2");
  });

  test("activity before the fix is not a regression", async () => {
    await seedIssue({
      fingerprint: "fp-fixed",
      last_seen: 3_000,
      resolved_at: 4_000,
      state: "unresolved",
    });
    const { issues } = await triage.list();

    expect(issues[0]?.isRegression).toBe(false);
    expect(issues[0]?.regressedRelease).toBeNull();
  });

  test("a still-resolved issue is not a regression whatever its timestamps", async () => {
    await seedIssue({
      fingerprint: "fp-closed",
      last_seen: 9_000,
      resolved_at: 1_000,
      state: "resolved",
    });
    const { issues } = await triage.list({ state: "resolved" });

    expect(issues[0]?.isRegression).toBe(false);
  });
});

describe("list", () => {
  test("orders by newest activity and reports a total", async () => {
    await seedIssue({ fingerprint: "old", last_seen: 1_000 });
    await seedIssue({ fingerprint: "new", last_seen: 9_000 });
    const { issues, total } = await triage.list();

    expect(issues.map((issue) => issue.fingerprint)).toEqual(["new", "old"]);
    expect(total).toBe(2);
  });

  test("severity groups fatal with error and info with warning", async () => {
    await seedIssue({ fingerprint: "fatal", level: "fatal" });
    await seedIssue({ fingerprint: "warn", level: "warning" });
    await seedIssue({ fingerprint: "info", level: "info" });
    const errors = await triage.list({ severity: "error" });
    const warnings = await triage.list({ severity: "warning" });

    expect(errors.issues.map((issue) => issue.fingerprint)).toEqual(["fatal"]);
    expect(warnings.issues.map((issue) => issue.fingerprint).sort()).toEqual([
      "info",
      "warn",
    ]);
  });

  test("a release filter matches introduced, ongoing and fixed alike", async () => {
    await seedIssue({
      fingerprint: "born",
      first_release: "r7",
      last_release: "r9",
    });
    await seedIssue({ fingerprint: "here", last_release: "r7" });
    await seedIssue({
      fingerprint: "fixed",
      last_release: "r8",
      resolved_release: "r7",
      state: "resolved",
    });
    await seedIssue({ fingerprint: "elsewhere", last_release: "r8" });
    const { issues } = await triage.list({ release: "r7" });

    expect(issues.map((issue) => issue.fingerprint).sort()).toEqual([
      "born",
      "fixed",
      "here",
    ]);
  });

  test("issues without a release stamp stay off a deployed-only board", async () => {
    await seedIssue({ fingerprint: "local", last_release: null });
    await seedIssue({ fingerprint: "shipped" });

    expect(
      (await triage.list()).issues.map((issue) => issue.fingerprint),
    ).toEqual(["shipped"]);
    const all = createIssueTriage({ db, deployedOnly: false, project: "acme" });
    expect((await all.list()).total).toBe(2);
  });

  test("another project's issues are never listed", async () => {
    await seedIssue({ fingerprint: "ours" });
    await seedIssue({ fingerprint: "theirs", project: "other" });

    expect(
      (await triage.list()).issues.map((issue) => issue.fingerprint),
    ).toEqual(["ours"]);
  });

  test("excluded rows are dropped from every read", async () => {
    await seedIssue({ fingerprint: "keep", title: "TypeError" });
    await seedIssue({ fingerprint: "drop", title: "perf: LCP" });
    const filtered = createIssueTriage({
      db,
      exclude: (row) => row.title.startsWith("perf:"),
      project: "acme",
    });

    expect(
      (await filtered.list()).issues.map((issue) => issue.fingerprint),
    ).toEqual(["keep"]);
  });
});

describe("setState", () => {
  test("closing stamps the trail and reopening clears it", async () => {
    await seedIssue({ fingerprint: "fp-1" });
    const resolved = await triage.setState("fp-1", "resolved", {
      by: "alex",
      note: "guarded the null",
      release: "r5",
    });

    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolvedBy).toBe("alex");
    expect(resolved?.resolutionNote).toBe("guarded the null");
    expect(resolved?.resolvedRelease).toBe("r5");
    expect(resolved?.resolvedAt).toBeGreaterThan(0);

    const reopened = await triage.setState("fp-1", "unresolved");
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.resolvedBy).toBeNull();
    expect(reopened?.resolvedRelease).toBeNull();
    // A manual reopen is a decision, not a failed fix.
    expect(reopened?.isRegression).toBe(false);
  });

  test("an unknown fingerprint returns null rather than throwing", async () => {
    expect(await triage.setState("missing", "resolved")).toBeNull();
    expect(await triage.assign("missing", "alex")).toBeNull();
  });
});

describe("occurrences", () => {
  test("fills quiet days with zero", async () => {
    const today = Math.floor(Date.now() / DAY_MS);
    await db.insert(errorEvents).values([
      {
        at: today * DAY_MS + 1_000,
        fingerprint: "fp-1",
        level: "error",
        message: "boom",
        name: "Error",
        project: "acme",
      },
      {
        at: today * DAY_MS + 2_000,
        fingerprint: "fp-1",
        level: "error",
        message: "boom",
        name: "Error",
        project: "acme",
      },
    ]);
    const series = await triage.occurrences("fp-1", 5);

    expect(series).toHaveLength(5);
    expect(series.at(-1)).toEqual({ count: 2, day: today });
    expect(series.slice(0, 4).every((point) => point.count === 0)).toBe(true);
  });
});

describe("stateCounts", () => {
  test("counts each state once", async () => {
    await seedIssue({ fingerprint: "a" });
    await seedIssue({ fingerprint: "b" });
    await seedIssue({ fingerprint: "c", state: "resolved" });
    const counts = await triage.stateCounts();

    expect(counts.find((entry) => entry.state === "unresolved")?.count).toBe(2);
    expect(counts.find((entry) => entry.state === "resolved")?.count).toBe(1);
  });
});

describe("releaseStats", () => {
  test("splits introduced, ongoing, regressed and fixed by severity", async () => {
    // Introduced in r2.
    await seedIssue({
      fingerprint: "new",
      first_release: "r2",
      last_release: "r2",
    });
    // Carried in from r1 and still occurring in r2.
    await seedIssue({
      fingerprint: "ongoing",
      first_release: "r1",
      last_release: "r2",
    });
    // Closed in r1, back in r2.
    await seedIssue({
      fingerprint: "regressed",
      first_release: "r1",
      last_release: "r2",
      last_seen: 9_000,
      resolved_at: 5_000,
      resolved_release: "r1",
      state: "unresolved",
    });
    // Declared fixed in r2.
    await seedIssue({
      fingerprint: "fixed",
      first_release: "r1",
      last_release: "r1",
      level: "warning",
      resolved_at: 8_000,
      resolved_release: "r2",
      state: "resolved",
    });
    const stats = await triage.releaseStats(["r1", "r2"]);
    const r2 = stats.get("r2");

    expect(r2?.newIssues).toBe(1);
    // The regressed issue is counted as a regression and not also as ongoing:
    // each issue lands in exactly one bucket per release, so the four columns
    // of a deployment row add up to the issues that touched it.
    expect(r2?.ongoing).toBe(1);
    expect(r2?.regressions).toBe(1);
    expect(r2?.fixed).toBe(1);
    // The one fixed issue was a warning; nothing should paint it as an error.
    expect(r2?.byCategory.error.fixed).toBe(0);
    expect(r2?.byCategory.warning.fixed).toBe(1);
  });

  test("no releases asked about means no queries and an empty map", async () => {
    expect((await triage.releaseStats([])).size).toBe(0);
  });
});
