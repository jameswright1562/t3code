import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "./Sqlite.ts";
import { migrationManifest } from "./Migrations.ts";

const layer = it.layer(layerMemory);

layer("Upstream message-search migration ID collision", (it) => {
  it.effect("retains fork 81/82 and installs upstream search_text at 83", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(migrationManifest.filter(([id]) => id >= 81), [
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
