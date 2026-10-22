# Changelog

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
