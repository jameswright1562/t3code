import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import { remember, confirmMemory, forgetMemory, reviseMemory } from "./AgentMemory.ts";
import { makeMemoryFtsQuery, searchMemoryCandidates } from "./MemorySearch.ts";

const layer = it.layer(layerMemory);

layer("SQLite agent memory search", (it) => {
  it.effect("recalls an older verified memory past the newest 100 and keeps scopes separate", () =>
    Effect.gen(function* () {
      const scope = { scopeType: "project" as const, scopeId: "fts-recall-project" };
      yield* remember({
        ...scope, id: "fts-rare-memory", eventId: "fts-rare-created",
        kind: "decision", content: "The hornbill architecture uses durable checkpoints",
        sourceRef: "repo:design@1", sourceActor: "user", verification: "user_confirmed",
        occurredAt: "2024-01-01T00:00:00.000Z",
      });
      yield* Effect.forEach(Array.from({ length: 110 }, (_, i) => i), (i) =>
        remember({
          ...scope, id: "fts-new-" + i, eventId: "fts-created-" + i,
          kind: "fact", content: "Ordinary build detail number " + i,
          sourceRef: "tests:" + i, sourceActor: "tool", verification: "verified",
          occurredAt: "2026-11-10T12:00:00.000Z",
        }),
        { concurrency: 1, discard: true },
      );
      const found = yield* searchMemoryCandidates({
        scopes: [scope], query: "hornbill architecture", limitPerScope: 20,
      });
      assert.deepStrictEqual(found.map((x) => x.id), ["fts-rare-memory"]);
      assert.deepStrictEqual(yield* searchMemoryCandidates({
        scopes: [{ scopeType: "project", scopeId: "fts-other-project" }],
        query: "hornbill", limitPerScope: 20,
      }), []);
    }),
  );

  it.effect("tracks verification, revisions and tombstones without returning unapproved items", () =>
    Effect.gen(function* () {
      const scope = { scopeType: "project" as const, scopeId: "fts-approval-project" };
      yield* remember({
        ...scope, id: "fts-proposal", eventId: "fts-proposal-created",
        kind: "fact", content: "Deuterium protocol is enabled",
        sourceRef: "source:proposed", sourceActor: "agent", verification: "proposed",
      });
      const search = () => searchMemoryCandidates({ scopes: [scope], query: "deuterium" });
      assert.equal((yield* search()).length, 0);
      yield* confirmMemory({ scope, id: "fts-proposal", eventId: "fts-confirm" });
      assert.deepStrictEqual((yield* search()).map((x) => x.id), ["fts-proposal"]);
      yield* reviseMemory({
        scope, id: "fts-proposal", replacementId: "fts-revised",
        eventId: "fts-revise", content: "Deuterium protocol was disabled",
      });
      assert.deepStrictEqual((yield* search()).map((x) => x.id), ["fts-revised"]);
      yield* forgetMemory({ scope, id: "fts-revised", eventId: "fts-forget" });
      assert.deepStrictEqual(yield* search(), []);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM agent_memory_search
        WHERE agent_memory_search MATCH 'deuterium'
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );
});

it("builds safe, bounded search phrases", () => {
  assert.equal(makeMemoryFtsQuery('hello" OR *world*'), '"hello" OR "world"');
  assert.equal(makeMemoryFtsQuery("a b"), null);
});
