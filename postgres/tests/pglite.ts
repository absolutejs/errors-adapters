/**
 * A tiny shim adapting PGlite (real Postgres, compiled to WASM, in-process) to
 * the `PostgresTag` tag-template shape the adapter consumes. Lets the tests
 * exercise the *actual* SQL — ON CONFLICT / xmax / CTEs / ILIKE — with true
 * Postgres semantics, no external server.
 */
import { PGlite } from "@electric-sql/pglite";
import type { PostgresTag } from "../src/index";

type RawFragment = { __raw: string; then: Promise<unknown[]>["then"] };

const isRaw = (value: unknown): value is RawFragment =>
  typeof value === "object" && value !== null && "__raw" in value;

export const makePgliteTag = (): { sql: PostgresTag; db: PGlite } => {
  const db = new PGlite();

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    const binds: unknown[] = [];
    strings.forEach((chunk, i) => {
      text += chunk;
      if (i >= values.length) return;
      const value = values[i];
      if (isRaw(value)) {
        text += value.__raw;
      } else {
        binds.push(value);
        text += `$${binds.length}`;
      }
    });
    return db.query(text, binds).then((result) => result.rows);
  }) as unknown as PostgresTag & {
    unsafe: PostgresTag["unsafe"];
  };

  tag.unsafe = (raw: string) => {
    // Dual nature, matching porsager/postgres: embeddable as a raw fragment
    // (read via `__raw`, never awaited), AND awaitable to run multi-statement
    // DDL via PGlite's exec(). exec runs lazily — only when `then` is invoked
    // by `await` — so embedding a fragment never executes its text as SQL.
    const fragment: RawFragment = {
      __raw: raw,
      then: (onfulfilled, onrejected) =>
        db
          .exec(raw)
          .then(() => [] as unknown[])
          .then(onfulfilled, onrejected),
    };
    return fragment as unknown as ReturnType<PostgresTag["unsafe"]>;
  };

  return { db, sql: tag };
};
