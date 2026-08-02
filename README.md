# AbsoluteJS Errors Adapters

Durable storage integrations for `@absolutejs/errors`.

## PostgreSQL

`@absolutejs/errors-postgres` implements the Effect-native `IssueStore` contract with first-class Drizzle and tagged-template clients. It persists normalized issues, occurrence history, status changes, and indexed lookup data without coupling the core error pipeline to a database driver.

```sh
bun add @absolutejs/errors @absolutejs/errors-postgres
```

Use the core package’s memory store for tests and local development, then switch to the PostgreSQL adapter when issue history must survive process restarts or be queried by operators. See the adapter package README for schema setup and client examples.
