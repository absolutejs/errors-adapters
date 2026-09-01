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

### Drizzle

Re-export the package tables from your application schema and manage them with
your normal migration workflow:

```ts
export { errorEvents, errorIssues } from "@absolutejs/errors-postgres";
```

```ts
import { createDrizzleIssueStore } from "@absolutejs/errors-postgres";

const store = createDrizzleIssueStore({ db });
```

The Drizzle store uses transactions for atomic event/group updates, portable
native JSONB for tags and extra context, row locking for regression detection,
and the same Effect error channel as the tagged-template adapter.
JSONB values are passed to Drizzle drivers as native objects (rather than
pre-serialized strings), preventing Bun SQL from storing them as JSON strings.

### Tagged-template compatibility

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

`error_issues` also carries the resolution trail — `resolved_at`,
`resolved_by`, `resolved_release`, `resolution_note` — which the triage board
writes when an issue is closed. `ensureSchema` adds them to an existing table;
an application that owns its schema through migrations must add them itself
before upgrading, because the store writes every column it knows about.

Choose the schema-derived Drizzle store for application-managed databases or
the raw tagged-template compatibility store for lightweight and Neon HTTP
integrations.

## Triage

The store answers "what broke and how often". A board on top of it has to
answer what a person actually asks in front of it: what is breaking now, who is
on it, did the fix hold, which release introduced this. `createIssueTriage`
is those queries, bound to one project.

```ts
import { createIssueTriage } from "@absolutejs/errors-postgres";

const triage = createIssueTriage({ db, project: "acme" });

await triage.list({ severity: "error", state: "unresolved" });
await triage.get(fingerprint); // issue + recent events
await triage.occurrences(fingerprint, 14); // zero-filled daily sparkline
await triage.stateCounts(); // numbers for the filter chips
await triage.setState(fingerprint, "resolved", { by, note, release });
await triage.assign(fingerprint, "alex");
await triage.releaseStats(["sha1", "sha2"]);
```

A **regression** is derived, not stored: the ingest upsert flips a resolved
issue back to `unresolved` when it recurs but leaves `resolved_at` in place, so
unresolved + a resolution stamp + activity after it means the fix did not hold.
`setState` clears the trail on reopen, because a manual reopen is a decision
rather than a failed fix — and a surviving stamp would make the next
recurrence look like one.

`releaseStats` is the per-release rollup a deployments ledger needs: for each
release, how many issues were introduced under it, carried in from before it,
came back in it, or were declared fixed in it — split by severity, because a
deploy that introduced three warnings is not the same news as one that
introduced three errors. Each issue lands in exactly one bucket per release.

## License

Apache-2.0.
