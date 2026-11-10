import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import { confirmMemory, forgetMemory, listMemory, remember, reviseMemory } from "./AgentMemory.ts";
import { exportMemoryBackup, importMemoryBackup } from "./MemoryBackup.ts";

const layer = it.layer(layerMemory);

layer("Lossless project-scoped memory backup", (it) => {
  it.effect("round-trips tombstones, revisions, provenance and audit events idempotently", () =>
    Effect.gen(function* () {
      const scope = { scopeType: "project" as const, scopeId: "memory-backup-roundtrip" };
      yield* remember({
        id: "backup-original", eventId: "backup-created", ...scope,
        kind: "decision", content: "Initial decision", sourceRef: "file:repo@abc",
        sourceActor: "agent:codex", verification: "proposed",
      });
      yield* confirmMemory({ id: "backup-original", scope, eventId: "backup-confirm" });
      yield* reviseMemory({
        id: "backup-original", replacementId: "backup-revision",
        eventId: "backup-revise", scope, content: "Revised decision",
      });
      yield* forgetMemory({ id: "backup-revision", scope, eventId: "backup-forget" });
      const before = yield* exportMemoryBackup(scope);
      assert.equal(before.entries.length, 2);
      assert.equal(before.events.length, 5);
      assert.equal(before.entries.find((x) => x.id === "backup-revision")?.tombstonedAt !== null, true);
      assert.equal(before.entries.find((x) => x.id === "backup-original")?.supersededBy, "backup-revision");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM agent_memory_events WHERE memory_id IN ('backup-original', 'backup-revision')`;
      yield* sql`DELETE FROM agent_memory_items WHERE id IN ('backup-original', 'backup-revision')`;
      const imported = yield* importMemoryBackup({ scope, backup: before });
      assert.deepStrictEqual(imported, { importedEntries: 2, importedEvents: 5 });
      assert.deepStrictEqual(yield* importMemoryBackup({ scope, backup: before }), {
        importedEntries: 0, importedEvents: 0,
      });
      const after = yield* exportMemoryBackup(scope);
      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(yield* listMemory([scope]), []);
    }),
  );

  it.effect("rejects wrong scope, corruption and conflicting existing records without partial writes", () =>
    Effect.gen(function* () {
      const scope = { scopeType: "project" as const, scopeId: "memory-backup-validation" };
      yield* remember({
        id: "backup-conflict", eventId: "backup-conflict-created", ...scope,
        kind: "fact", content: "Trusted", sourceRef: "test:source",
        sourceActor: "user", verification: "user_confirmed",
      });
      const backup = yield* exportMemoryBackup(scope);
      const wrongScope = yield* Effect.result(importMemoryBackup({
        scope: { scopeType: "project", scopeId: "other-project" }, backup,
      }));
      assert.equal(wrongScope._tag, "Failure");
      const corrupt = yield* Effect.result(importMemoryBackup({
        scope, backup: { ...backup, checksum: "0".repeat(64) },
      }));
      assert.equal(corrupt._tag, "Failure");
      // A validly checksummed but conflicting import must roll back a prior
      // insert in the SAME transaction, rather than partially restoring it.
      const old = backup.entries[0]!;
      const staged = {
        schemaVersion: 1 as const, scope,
        entries: [
          { ...old, id: "backup-rollback-row", content: "Uncommitted record" },
          { ...old, content: "Malicious conflict" },
        ],
        events: [
          {
            eventId: "backup-rollback-event", memoryId: "backup-rollback-row",
            operation: "created", payloadJson: "{}", occurredAt: old.createdAt,
          },
          ...backup.events,
        ],
      };
      const conflict = {
        ...staged,
        checksum: createHash("sha256").update(JSON.stringify(staged), "utf8").digest("hex"),
      };
      const attempted = yield* Effect.result(importMemoryBackup({ scope, backup: conflict }));
      assert.equal(attempted._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      const residue = yield* sql<{ count: number }>`SELECT COUNT(*) AS "count"
        FROM agent_memory_items WHERE id = 'backup-rollback-row'`;
      assert.equal(residue[0]?.count, 0);
      const events = yield* sql<{ count: number }>`SELECT COUNT(*) AS "count"
        FROM agent_memory_events WHERE event_id = 'backup-rollback-event'`;
      assert.equal(events[0]?.count, 0);
      assert.equal((yield* listMemory([scope]))[0]?.content, "Trusted");
    }),
  );
});
