import {
  type CoalescedGroup,
  type IssueStoreError,
  type StoredEvent,
} from "@absolutejs/errors";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Option } from "effect";
import { createDrizzleIssueStore } from "../src/drizzle";

const run = <Value>(
  effect: Effect.Effect<Value, IssueStoreError>,
): Promise<Value> => Effect.runPromise(effect);
const event = (over: Partial<StoredEvent> = {}): StoredEvent => ({
  at: 1_000,
  fingerprint: "fp-1",
  level: "error",
  message: "boom",
  name: "Error",
  project: "acme",
  ...over,
});

let store: ReturnType<typeof createDrizzleIssueStore>;
beforeEach(async () => {
  const client = new PGlite();
  await client.exec(`
    CREATE TABLE error_issues (
      project text NOT NULL, fingerprint text NOT NULL, title text NOT NULL,
      culprit text, level text NOT NULL, state text NOT NULL DEFAULT 'unresolved',
      environment text, first_seen bigint NOT NULL, last_seen bigint NOT NULL,
      times_seen bigint NOT NULL DEFAULT 1, first_release text, last_release text,
      assignee text, PRIMARY KEY (project, fingerprint)
    );
    CREATE TABLE error_events (
      id bigserial PRIMARY KEY, project text NOT NULL, fingerprint text NOT NULL,
      at bigint NOT NULL, level text NOT NULL, name text NOT NULL,
      message text NOT NULL, stack text, release text, environment text,
      trace_id text, span_id text, replay_id text, tags jsonb, extra jsonb
    );
  `);
  store = createDrizzleIssueStore({ db: drizzle({ client }) });
});

describe("createDrizzleIssueStore", () => {
  test("groups, escalates, and detects resolved regressions atomically", async () => {
    expect((await run(store.record(event()))).isNew).toBe(true);
    await run(store.record(event({ at: 2_000, level: "fatal" })));
    await run(store.setState!("acme", "fp-1", "resolved"));
    const regressed = await run(store.record(event({ at: 3_000 })));
    expect(regressed.isRegression).toBe(true);
    expect(regressed.issue).toMatchObject({
      level: "fatal",
      state: "unresolved",
      timesSeen: 3,
    });
  });

  test("retains portable JSONB event context and newest-first history", async () => {
    await run(
      store.record(
        event({
          extra: { route: "/api/x" },
          replayId: "replay-1",
          tags: { component: "http" },
          traceId: "trace-1",
        }),
      ),
    );
    const events = await run(store.listEvents!("acme", "fp-1"));
    expect(events[0]).toMatchObject({
      extra: { route: "/api/x" },
      replayId: "replay-1",
      tags: { component: "http" },
      traceId: "trace-1",
    });
  });

  test("persists sampled coalesced herds with their full occurrence count", async () => {
    const representative = event();
    const group: CoalescedGroup = {
      firstSeen: 1_000,
      lastSeen: 2_000,
      occurrences: 500,
      representative,
      samples: [representative, event({ at: 2_000, message: "latest sample" })],
    };
    const result = await run(store.recordCoalesced!(group));
    expect(result.issue.timesSeen).toBe(500);
    expect(await run(store.listEvents!("acme", "fp-1"))).toHaveLength(2);
  });

  test("filters, assigns, resolves, and reads one project-scoped issue", async () => {
    await run(store.record(event({ message: "database timeout" })));
    await run(store.assign!("acme", "fp-1", "alice"));
    const assigned = Option.getOrThrow(
      await run(store.getIssue!("acme", "fp-1")),
    );
    expect(assigned.assignee).toBe("alice");
    const matches = await run(
      store.listIssues!({ project: "acme", query: "DATABASE" }),
    );
    expect(matches.map(({ fingerprint }) => fingerprint)).toEqual(["fp-1"]);
  });
});
