import { SQL } from "bun";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql";
import { Effect } from "effect";
import { createDrizzleIssueStore } from "../src/drizzle";

const databaseUrl = process.env.ERRORS_POSTGRES_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
  "Bun SQL stores Drizzle event context as native JSONB objects",
  async () => {
    const client = new SQL({ max: 1, prepare: false, url: databaseUrl! });
    try {
      await client.unsafe(`
        CREATE TEMP TABLE error_issues (
          project text NOT NULL, fingerprint text NOT NULL, title text NOT NULL,
          culprit text, level text NOT NULL,
          state text NOT NULL DEFAULT 'unresolved', environment text,
          first_seen bigint NOT NULL, last_seen bigint NOT NULL,
          times_seen bigint NOT NULL DEFAULT 1, first_release text,
          last_release text, assignee text,
          PRIMARY KEY (project, fingerprint)
        );
        CREATE TEMP TABLE error_events (
          id bigserial PRIMARY KEY, project text NOT NULL,
          fingerprint text NOT NULL, at bigint NOT NULL, level text NOT NULL,
          name text NOT NULL, message text NOT NULL, stack text, release text,
          environment text, trace_id text, span_id text, replay_id text,
          tags jsonb, extra jsonb
        );
      `);
      const store = createDrizzleIssueStore({ db: drizzle({ client }) });
      await Effect.runPromise(
        store.record({
          at: 1_000,
          extra: { route: "/synthetic" },
          fingerprint: "jsonb-conformance",
          level: "error",
          message: "synthetic canary",
          name: "Error",
          project: "absolute-test",
          tags: { component: "test" },
        }),
      );

      const [stored] = await client<
        { extra_type: string; tags_type: string }[]
      >`
        SELECT jsonb_typeof(extra) AS extra_type,
               jsonb_typeof(tags) AS tags_type
        FROM error_events
        WHERE fingerprint = 'jsonb-conformance'
      `;
      expect(stored).toEqual({
        extra_type: "object",
        tags_type: "object",
      });
    } finally {
      await client.close();
    }
  },
);
