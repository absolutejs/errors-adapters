# Changelog

## 0.4.0 — 2026-11-16

- `IssueListQuery` takes `levels`: exactly these levels, so a board can
  filter info apart from warning (`severity: "warning"` groups both). Applied
  together with `severity` when both are given.
- Exports the `IssueLevel` type.

## 0.3.0 — 2026-11-16

- `createIssueTriage` takes `excludeTitles`: issues whose title contains any
  of them (case-insensitive, `%` and `_` matched as text) are left out of the
  list, its total and the state counts, in the query itself. The older
  `exclude` predicate filtered a page after it was fetched, so pages came back
  short and the counts still included what it dropped.
- Exports `PERFORMANCE_ISSUE_TITLES`: the slow response, slow interaction,
  slow resource, slow route p95, Web Vital regression, slow query, pool
  saturation and cache hit-rate titles error tracking filed as issues before
  latency moved to a Performance page. Pair it with
  `reliabilitySignalPreset` from `@absolutejs/beacon/policy`, which stops the
  browser filing them.

## 0.2.0 — 2026-10-22

- Adds `createIssueTriage`: the regression, sparkline, grouping and
  per-release rollup queries two boards had each written by hand, bound to one
  project.
- `error_issues` gains nullable `resolved_at`, `resolved_by`,
  `resolved_release` and `resolution_note` columns, which the store now writes.
  `ensureSchema` adds them to an existing table; an application that owns the
  schema through migrations must add them itself.
- Accepts `@absolutejs/errors` 0.10 (built against Elysia 2.0.0-rc.0) as well
  as 0.9.

## 0.1.2 — 2026-07-28

- Passes Drizzle `tags` and `extra` values to database drivers as native
  objects so Bun SQL persists JSONB objects rather than JSONB string scalars.
- Adds unit and disposable-Postgres regression coverage for the JSONB driver
  boundary.

## 0.0.5 — 2026-07-23

- Adds package-owned `errorIssues` and `errorEvents` Drizzle tables.
- Adds `createDrizzleIssueStore({ db })` with atomic grouping, regression
  detection, severity escalation, coalesced occurrence counts, sampled event
  timelines, filtering, assignment and state management.
- Uses a portable native-JSONB codec across Bun SQL, postgres.js, Neon and
  PGlite.
- Advertises the Drizzle implementation and migration lifecycle in the
  AbsoluteJS manifest.
