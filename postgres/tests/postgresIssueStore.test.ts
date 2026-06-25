/**
 * Tests for @absolutejs/errors-postgres against PGlite (real Postgres / WASM).
 * Validates the atomic CTE upsert (new vs. regression via xmax + prev-state),
 * severity escalation, release tracking, and the query surface.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  createErrorTracker,
  type CoalescedGroup,
  type IssueStoreError,
  type StoredEvent,
} from "@absolutejs/errors";
import {
  createDrainer,
  createInMemoryEventBuffer,
} from "@absolutejs/errors/ingest";
import { Effect, Option } from "effect";
import { createPostgresIssueStore } from "../src/index";
import { makePgliteTag } from "./pglite";

const run = <A>(eff: Effect.Effect<A, IssueStoreError>): Promise<A> =>
  Effect.runPromise(eff);

const evt = (
  over: Partial<
    Parameters<ReturnType<typeof createPostgresIssueStore>["record"]>[0]
  >,
) => ({
  at: 1000,
  fingerprint: "fp-1",
  level: "error" as const,
  message: "boom",
  name: "Error",
  project: "acme",
  ...over,
});

// Fresh in-process Postgres per test — full isolation, real SQL.
let store: ReturnType<typeof createPostgresIssueStore>;
beforeEach(() => {
  const { sql } = makePgliteTag();
  store = createPostgresIssueStore({ sql });
});

describe("record — atomic upsert", () => {
  test("first capture → isNew, persisted issue + event", async () => {
    const result = await run(
      store.record(evt({ message: "kaboom", name: "TypeError" })),
    );
    expect(result.isNew).toBe(true);
    expect(result.isRegression).toBe(false);
    expect(result.issue.state).toBe("unresolved");
    expect(result.issue.timesSeen).toBe(1);
    expect(result.issue.title).toBe("TypeError: kaboom");
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toBe("kaboom");
  });

  test("repeat → not new, timesSeen increments, lastSeen advances, 2 events", async () => {
    await run(store.record(evt({ at: 1000 })));
    const second = await run(store.record(evt({ at: 2000 })));
    expect(second.isNew).toBe(false);
    expect(second.issue.timesSeen).toBe(2);
    expect(second.issue.firstSeen).toBe(1000);
    expect(second.issue.lastSeen).toBe(2000);
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events).toHaveLength(2);
  });

  test("lastSeen uses GREATEST (out-of-order events do not regress the clock)", async () => {
    await run(store.record(evt({ at: 5000 })));
    const older = await run(store.record(evt({ at: 1000 })));
    expect(older.issue.lastSeen).toBe(5000);
  });

  test("resolved → seen again → regression flips to unresolved", async () => {
    await run(store.record(evt({ at: 1000 })));
    await run(store.setState!("acme", "fp-1", "resolved"));
    const regressed = await run(store.record(evt({ at: 3000 })));
    expect(regressed.isRegression).toBe(true);
    expect(regressed.isNew).toBe(false);
    expect(regressed.issue.state).toBe("unresolved");
  });

  test("ignored → seen again stays ignored, no regression", async () => {
    await run(store.record(evt({ at: 1000 })));
    await run(store.setState!("acme", "fp-1", "ignored"));
    const again = await run(store.record(evt({ at: 2000 })));
    expect(again.isRegression).toBe(false);
    expect(again.issue.state).toBe("ignored");
  });

  test("severity escalates but never de-escalates", async () => {
    await run(store.record(evt({ at: 1, level: "warning" })));
    const up = await run(store.record(evt({ at: 2, level: "fatal" })));
    expect(up.issue.level).toBe("fatal");
    const down = await run(store.record(evt({ at: 3, level: "info" })));
    expect(down.issue.level).toBe("fatal");
  });

  test("first/last release tracked across captures", async () => {
    await run(store.record(evt({ at: 1, release: "v1.0.0" })));
    const later = await run(store.record(evt({ at: 2, release: "v1.1.0" })));
    expect(later.issue.firstRelease).toBe("v1.0.0");
    expect(later.issue.lastRelease).toBe("v1.1.0");
  });

  test("first_release backfills when the first capture had none", async () => {
    await run(store.record(evt({ at: 1 }))); // no release
    const later = await run(store.record(evt({ at: 2, release: "v2.0.0" })));
    expect(later.issue.firstRelease).toBe("v2.0.0");
    expect(later.issue.lastRelease).toBe("v2.0.0");
  });

  test("project scoping isolates the same fingerprint", async () => {
    await run(store.record(evt({ project: "acme" })));
    await run(store.record(evt({ project: "globex" })));
    const acme = await run(store.getIssue!("acme", "fp-1"));
    const globex = await run(store.getIssue!("globex", "fp-1"));
    expect(Option.getOrThrow(acme).timesSeen).toBe(1);
    expect(Option.getOrThrow(globex).timesSeen).toBe(1);
  });

  test("round-trips trace/span/replay ids + jsonb tags/extra", async () => {
    await run(
      store.record(
        evt({
          extra: { route: "/api/x" },
          replayId: "rep-9",
          spanId: "span-2",
          tags: { component: "http" },
          traceId: "trace-1",
        }),
      ),
    );
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events[0]?.traceId).toBe("trace-1");
    expect(events[0]?.spanId).toBe("span-2");
    expect(events[0]?.replayId).toBe("rep-9");
    expect(events[0]?.tags).toEqual({ component: "http" });
    expect(events[0]?.extra).toEqual({ route: "/api/x" });
  });
});

describe("query surface", () => {
  test("listIssues filters by state + ILIKE query, newest-first", async () => {
    await run(
      store.record(
        evt({ at: 1, fingerprint: "a", message: "database timeout" }),
      ),
    );
    await run(
      store.record(
        evt({
          at: 2,
          fingerprint: "b",
          message: "null pointer",
          name: "TypeError",
        }),
      ),
    );
    await run(store.setState!("acme", "a", "resolved"));
    const unresolved = await run(
      store.listIssues!({ project: "acme", state: "unresolved" }),
    );
    expect(unresolved.map((i) => i.fingerprint)).toEqual(["b"]);
    const dbHits = await run(store.listIssues!({ query: "DATABASE" }));
    expect(dbHits.map((i) => i.fingerprint)).toEqual(["a"]);
  });

  test("listIssues orders by last_seen DESC and honors limit", async () => {
    await run(store.record(evt({ at: 100, fingerprint: "old" })));
    await run(store.record(evt({ at: 300, fingerprint: "new" })));
    await run(store.record(evt({ at: 200, fingerprint: "mid" })));
    const all = await run(store.listIssues!({ project: "acme" }));
    expect(all.map((i) => i.fingerprint)).toEqual(["new", "mid", "old"]);
    const top = await run(store.listIssues!({ limit: 1 }));
    expect(top.map((i) => i.fingerprint)).toEqual(["new"]);
  });

  test("getIssue → none for unknown fingerprint", async () => {
    const missing = await run(store.getIssue!("acme", "nope"));
    expect(Option.isNone(missing)).toBe(true);
  });

  test("listEvents newest-first, capped by limit", async () => {
    await run(store.record(evt({ at: 1, message: "a" })));
    await run(store.record(evt({ at: 2, message: "b" })));
    await run(store.record(evt({ at: 3, message: "c" })));
    const evts = await run(store.listEvents!("acme", "fp-1", 2));
    expect(evts.map((e) => e.message)).toEqual(["c", "b"]);
  });

  test("assign + unassign", async () => {
    await run(store.record(evt({})));
    await run(store.assign!("acme", "fp-1", "alice"));
    expect(
      Option.getOrThrow(await run(store.getIssue!("acme", "fp-1"))).assignee,
    ).toBe("alice");
    await run(store.assign!("acme", "fp-1", null));
    expect(
      Option.getOrThrow(await run(store.getIssue!("acme", "fp-1"))).assignee,
    ).toBeUndefined();
  });
});

describe("schema + integration", () => {
  test("ensureSchema is idempotent (many records, one schema)", async () => {
    await run(store.record(evt({ at: 1 })));
    await run(store.record(evt({ at: 2, fingerprint: "other" })));
    const issues = await run(store.listIssues!());
    expect(issues).toHaveLength(2);
  });

  test("drives a real tracker end-to-end", async () => {
    const tracker = createErrorTracker({
      environment: "production",
      project: "acme",
      release: "v3.0.0",
      store,
    });
    const out = await tracker.captureException(new Error("integration boom"), {
      replayId: "rep-int",
    });
    expect(out.delivered.store).toBe("ok");
    expect(out.issue?.isNew).toBe(true);
    const issues = await run(store.listIssues!({ project: "acme" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.lastRelease).toBe("v3.0.0");
    expect(issues[0]?.environment).toBe("production");
    const events = await run(store.listEvents!("acme", out.fingerprint));
    expect(events[0]?.replayId).toBe("rep-int");
  });
});

describe("recordCoalesced — count-aware upsert + bulk unnest insert", () => {
  const group = (over: Partial<CoalescedGroup> = {}): CoalescedGroup => {
    const rep = evt({}) as StoredEvent;
    return {
      firstSeen: 1000,
      lastSeen: 2000,
      occurrences: 50,
      representative: rep,
      samples: [rep],
      ...over,
    };
  };

  test("new issue: times_seen = occurrences, samples bulk-inserted", async () => {
    const s1 = evt({ at: 1000, message: "a" }) as StoredEvent;
    const s2 = evt({ at: 1500, message: "b" }) as StoredEvent;
    const s3 = evt({ at: 2000, message: "c" }) as StoredEvent;
    const result = await run(
      store.recordCoalesced!(
        group({ occurrences: 250, samples: [s1, s2, s3] }),
      ),
    );
    expect(result.isNew).toBe(true);
    expect(result.issue.timesSeen).toBe(250); // 250 occurrences, ONE upsert
    expect(result.issue.firstSeen).toBe(1000);
    expect(result.issue.lastSeen).toBe(2000);
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events).toHaveLength(3); // only the sampled events persisted
    expect(events.map((e) => e.message).sort()).toEqual(["a", "b", "c"]);
  });

  test("repeat coalesced batch accumulates occurrences", async () => {
    await run(store.recordCoalesced!(group({ occurrences: 100 })));
    const second = await run(
      store.recordCoalesced!(group({ occurrences: 40 })),
    );
    expect(second.isNew).toBe(false);
    expect(second.issue.timesSeen).toBe(140);
  });

  test("regression: resolved then coalesced batch flips to unresolved", async () => {
    await run(store.recordCoalesced!(group({ occurrences: 10 })));
    await run(store.setState!("acme", "fp-1", "resolved"));
    const regressed = await run(
      store.recordCoalesced!(group({ occurrences: 5 })),
    );
    expect(regressed.isRegression).toBe(true);
    expect(regressed.issue.state).toBe("unresolved");
    expect(regressed.issue.timesSeen).toBe(15);
  });

  test("representative.level escalates the issue level", async () => {
    const warn = { ...(evt({}) as StoredEvent), level: "warning" as const };
    await run(
      store.recordCoalesced!(
        group({ occurrences: 1, representative: warn, samples: [warn] }),
      ),
    );
    const fatal = { ...(evt({}) as StoredEvent), level: "fatal" as const };
    const up = await run(
      store.recordCoalesced!(
        group({ occurrences: 1, representative: fatal, samples: [fatal] }),
      ),
    );
    expect(up.issue.level).toBe("fatal");
  });

  test("round-trips jsonb tags/extra + ids through the bulk insert", async () => {
    const rep = {
      ...(evt({}) as StoredEvent),
      extra: { route: "/x" },
      replayId: "rep-7",
      tags: { component: "http" },
      traceId: "trace-7",
    };
    await run(
      store.recordCoalesced!(
        group({ occurrences: 3, representative: rep, samples: [rep] }),
      ),
    );
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events[0]?.tags).toEqual({ component: "http" });
    expect(events[0]?.extra).toEqual({ route: "/x" });
    expect(events[0]?.traceId).toBe("trace-7");
    expect(events[0]?.replayId).toBe("rep-7");
  });

  test("ingest buffer + drainer → ONE coalesced upsert per herd", async () => {
    const buffer = createInMemoryEventBuffer();
    const drainer = createDrainer({ buffer, intervalMs: 1_000_000, store });
    const event: StoredEvent = evt({}) as StoredEvent;
    for (let i = 0; i < 500; i += 1) buffer.push({ ...event, at: 1000 + i });
    const flush = await Effect.runPromise(drainer.flush());
    expect(flush.groups).toBe(1);
    expect(flush.occurrences).toBe(500);
    const issues = await run(store.listIssues!({ project: "acme" }));
    expect(issues[0]?.timesSeen).toBe(500); // 500 events collapsed to one upsert
    await drainer.stop();
  });
});
