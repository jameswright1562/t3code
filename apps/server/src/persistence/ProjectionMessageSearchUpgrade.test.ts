import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest } from "./Migrations.ts";
import Migration0083 from "./Migrations/083_UpstreamProjectionMessageSearchText.ts";
import Migration0086 from "./Migrations/086_UpstreamTurnItemConversationIndex.ts";
import Migration0087 from "./Migrations/087_UpstreamCommandReadIndexes.ts";
import Migration0088 from "./Migrations/088_UpstreamLastExecutedRunIndex.ts";
import Migration0089 from "./Migrations/089_UpstreamTurnItemCounts.ts";

const layer = it.layer(layerMemory);

layer("Upstream message-search migration ID collision", (it) => {
  it.effect("retains fork 81/82 and installs upstream search_text at 83", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        migrationManifest.filter(([id]) => id >= 81 && id <= 83),
        [
          [81, "AgentMemory"],
          [82, "AgentMemorySearch"],
          [83, "UpstreamProjectionMessageSearchText"],
        ],
      );
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

it.effect("reconciles an upstream-upgraded 81–85 database without rewriting its journal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });

    // Simulate the deployed upstream schema before this fork is installed.
    yield* Migration0083;
    yield* Migration0086;
    yield* Migration0087;
    yield* Migration0088;
    yield* Migration0089;
    const upstreamNames = [
      "ProjectionMessageSearchText",
      "TurnItemConversationIndex",
      "CommandReadIndexes",
      "LastExecutedRunIndex",
      "TurnItemCounts",
    ];
    for (const [index, name] of upstreamNames.entries()) {
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${81 + index}, ${name})
      `;
    }
    yield* runMigrations();

    const journal = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id BETWEEN 81 AND 89 ORDER BY migration_id
    `;
    assert.deepStrictEqual(journal.slice(0, 5).map((entry) => entry.name), upstreamNames);
    assert.deepStrictEqual(
      journal.slice(5).map((entry) => entry.name),
      [
        "UpstreamTurnItemConversationIndex",
        "UpstreamCommandReadIndexes",
        "UpstreamLastExecutedRunIndex",
        "UpstreamTurnItemCounts",
      ],
    );
    const forkTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'agent_memory_items', 'agent_memory_checkpoints', 'agent_memory_events',
        'harness_thread_plans', 'harness_checkout_leases',
        'orchestration_v2_projection_turn_item_counts'
      )
    `;
    assert.equal(forkTables.length, 6);
    const triggers = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'orchestration_v2_turn_item_counts_%'
    `;
    assert.equal(triggers.length, 3);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades fork migration 85 through upstream schema ports 86–89", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 85 });
    const prior = yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations
      WHERE migration_id BETWEEN 81 AND 85 ORDER BY migration_id
    `;
    yield* runMigrations();
    const retained = yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations
      WHERE migration_id BETWEEN 81 AND 85 ORDER BY migration_id
    `;
    assert.deepStrictEqual(retained, prior);
    const migrated = yield* sql<{ readonly migration_id: number }>`
      SELECT migration_id FROM effect_sql_migrations
      WHERE migration_id BETWEEN 86 AND 89 ORDER BY migration_id
    `;
    assert.deepStrictEqual(migrated.map((entry) => entry.migration_id), [86, 87, 88, 89]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses unknown migration 82 before mutating an upstream 81 database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (81, 'ProjectionMessageSearchText'), (82, 'UnknownMigration')
    `;
    const result = yield* Effect.exit(runMigrations());
    assert.equal(result._tag, "Failure");
    const tables = yield* sql`
      SELECT name FROM sqlite_master
      WHERE name IN ('agent_memory_items', 'harness_thread_plans')
    `;
    assert.equal(tables.length, 0);
    const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations
      WHERE migration_id IN (81, 82) ORDER BY migration_id
    `;
    assert.deepStrictEqual(ledger, [
      { migration_id: 81, name: "ProjectionMessageSearchText" },
      { migration_id: 82, name: "UnknownMigration" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
