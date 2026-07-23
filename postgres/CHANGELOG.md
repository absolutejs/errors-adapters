# Changelog

## 0.0.5 — 2026-07-23

- Adds package-owned `errorIssues` and `errorEvents` Drizzle tables.
- Adds `createDrizzleIssueStore({ db })` with atomic grouping, regression
  detection, severity escalation, coalesced occurrence counts, sampled event
  timelines, filtering, assignment and state management.
- Uses a portable native-JSONB codec across Bun SQL, postgres.js, Neon and
  PGlite.
- Advertises the Drizzle implementation and migration lifecycle in the
  AbsoluteJS manifest.
