import { defineImplementation, defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import type { CreatePostgresIssueStoreOptions } from "./index";

/* `sql` is instance-valued (the tag-template client) → built in the wiring
 * from DATABASE_URL; only tablePrefix/ensureSchema are settings. */
export const manifest = defineManifest<CreatePostgresIssueStoreOptions>()({
  contract: 1,
  identity: {
    accent: "#336791",
    category: "observability",
    description:
      "Postgres-backed, Effect-native `IssueStore` for `@absolutejs/errors`. Durable grouped issues + event timeline with new/regression detection in one atomic CTE upsert. Accepts any postgres-js-compatible tag template (porsager/postgres or @neondatabase/serverless). Lazy schema, jsonb tags/extra, no ORM.",
    docsUrl: "https://github.com/absolutejs/errors-adapters/tree/main/postgres",
    name: "@absolutejs/errors-postgres",
    tagline: "Keep your error history in your Postgres database.",
  },
  implements: [
    defineImplementation<CreatePostgresIssueStoreOptions>()({
      contract: "errors/issue-store",
      factory: "createPostgresIssueStore",
      from: "@absolutejs/errors-postgres",
      requires: {
        env: [
          {
            description:
              "Postgres connection string (grouped issues and their event timeline live here)",
            example: "postgres://user:pass@host/db",
            key: "DATABASE_URL",
            secret: true,
          },
        ],
        peers: [
          {
            name: "@neondatabase/serverless",
            range: ">=0.10.0",
            reason:
              "HTTP tag-template Postgres client (swap for `postgres` over TCP if you prefer)",
          },
          {
            name: "effect",
            range: "^3.21.0",
            reason: "Effect runtime shared with @absolutejs/errors",
          },
        ],
        services: [
          {
            description: "Stores grouped issues and the occurrence timeline",
            id: "postgres",
          },
        ],
      },
      settings: Type.Object({
        ensureSchema: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Create the issue and event tables automatically on first use. Turn off if you manage schema through migrations.",
            title: "Create tables automatically",
          }),
        ),
        tablePrefix: Type.Optional(
          Type.String({
            default: "error",
            description:
              "Table-name prefix — 'error' creates error_issues and error_events.",
            pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$",
            title: "Table prefix",
          }),
        ),
      }),
      title: "Your Postgres database (durable issues dashboard)",
      wiring: {
        code: "createPostgresIssueStore({ sql: neon(${env.DATABASE_URL} ?? ''), ...${settings} })",
        imports: [
          {
            from: "@absolutejs/errors-postgres",
            names: ["createPostgresIssueStore"],
          },
          { from: "@neondatabase/serverless", names: ["neon"] },
        ],
      },
    }),
  ],
  settings: Type.Object({}),
  wiring: [],
});
