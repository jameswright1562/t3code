import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest } from "./Migrations.ts";

const layer = it.layer(layerMemory);

layer("Upstream message-search migration ID collision", (it) => {
  it.effect("retains fork 81/82 and installs upstream search_text at 83", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(migrationManifest.filter(([id]) => id >= 81 && id <= 83), [
        [81, "AgentMemory"],
        [82, "AgentMemorySearch"],
        [83, "UpstreamProjectionMessageSearchText"],
      ]);
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('orchestration_v2_projection_messages')
        WHERE name = 'search_text'
      `;
      assert.equal(columns.length, 1);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'agent_memory_items'
      `;
      assert.equal(tables.length, 1);
    }),
  );
});

it.effect("recovers a database with upstream migration 81 already applied", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 81 });
    // Simulate the upstream user's journal/schema before installing this fork.
    yield* sql`DROP TABLE agent_memory_items`;
    yield* sql`DROP TABLE agent_memory_checkpoints`;
    yield* sql`DROP TABLE agent_memory_events`;
    yield* sql`ALTER TABLE orchestration_v2_projection_messages ADD COLUMN search_text TEXT`;
    yield* sql`UPDATE effect_sql_migrations
      SET name = 'ProjectionMessageSearchText' WHERE migration_id = 81`;
    yield* runMigrations();
    const memory = yield* sql`SELECT 1 FROM sqlite_master
      WHERE name = 'agent_memory_items'`;
    assert.equal(memory.length, 1);
    const journal = yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations WHERE migration_id = 81
    `;
    assert.equal(journal[0]?.name, "ProjectionMessageSearchText");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
