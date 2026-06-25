# @absolutejs/errors-postgres

Postgres-backed, **Effect-native** `IssueStore` for
[`@absolutejs/errors`](https://www.npmjs.com/package/@absolutejs/errors) —
the durable "Issues" surface (Sentry's product core), self-hosted on your
own Postgres.

Durable grouped **issues** + an append-only **event timeline**, with
**new vs. regression** detection resolved in a single atomic CTE upsert —
one round-trip, no transaction, so it works over Neon's HTTP driver too.

## Install

```sh
bun add @absolutejs/errors-postgres
# plus your driver + peers:
bun add @absolutejs/errors effect postgres   # or @neondatabase/serverless
```

`postgres` and `@neondatabase/serverless` are **optional** peers — install
whichever driver you use.

## Usage

```ts
import postgres from "postgres";
import { createErrorTracker } from "@absolutejs/errors";
import { createPostgresIssueStore } from "@absolutejs/errors-postgres";

const sql = postgres(process.env.DATABASE_URL!);

const errors = createErrorTracker({
  project: "acme",
  release: process.env.RELEASE,
  store: createPostgresIssueStore({ sql }), // schema auto-created, lazy
  onIssue: (r) => alert(r.issue), // only on new / regression
});

await errors.captureException(err, { traceId, replayId });
```

Works identically with `@neondatabase/serverless`:

```ts
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL!);
createPostgresIssueStore({ sql });
```

## What it implements

Every method returns an `Effect` with a typed `IssueStoreError` channel
(`IssueStoreSchemaError` / `IssueStoreQueryError` /
`IssueStoreSerializationError`) — failures are values, not throws.

| Method                                      | Effect                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `record(event)`                             | atomic upsert (one event) → `{ issue, isNew, isRegression }`               |
| `recordCoalesced(group)`                    | count-aware upsert + bulk `unnest` insert — one round-trip per herd        |
| `listIssues(filter?)`                       | dashboard list (project / environment / state / ILIKE title), newest-first |
| `getIssue(project, fingerprint)`            | `Option<IssueRecord>`                                                      |
| `setState(project, fingerprint, state)`     | resolve / ignore / unresolve                                               |
| `assign(project, fingerprint, who \| null)` | triage                                                                     |
| `listEvents(project, fingerprint, limit?)`  | occurrence timeline, newest-first                                          |

### Grouping semantics (mirrors `createMemoryIssueStore` exactly)

- **new vs. regression** — detected in one statement: `xmax = 0` ⇒ the row
  was inserted (new); a CTE captures the pre-update `state`, so a
  `resolved` issue seen again is a **regression** and flips back to
  `unresolved`. `ignored` issues stay muted.
- **severity escalates, never de-escalates** — `fatal > error > warning > info`.
- **first/last release** tracked across captures (`first_release` backfills).
- **`lastSeen` uses `GREATEST`** — out-of-order events never rewind the clock.

## Schema (lazy, idempotent)

Created on first use (set `ensureSchema: false` to manage it via migrations).
`tablePrefix` defaults to `error` → `error_issues` + `error_events`.

```
error_issues  PK (project, fingerprint)   -- one row per grouped issue
error_events  bigserial id                -- append-only occurrences (jsonb tags/extra)
```

Indexes: `(project, last_seen DESC)` and `(project, state)` on issues;
`(project, fingerprint, at DESC)` on events.

`trace_id` / `span_id` (→ `@absolutejs/telemetry`) and `replay_id`
(→ `@absolutejs/replay`) are stored per event so a dashboard can cross-link
an issue to its exact trace and DOM replay.

No ORM — one raw tagged-template module against any postgres-js-compatible
client.

## License

Apache-2.0.
