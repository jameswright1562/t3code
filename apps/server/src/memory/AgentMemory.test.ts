import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import {
  forgetMemory,
  confirmMemory,
  latestCheckpoint,
  pinMemory,
  recoverCheckpoint,
  exportMemory,
  listMemory,
  remember,
  saveCheckpoint,
} from "./AgentMemory.ts";

const layer = it.layer(layerMemory);

layer("Checkpoint fallback and authorized export", (it) => {
  it.effect("skips a corrupt newer checkpoint without crossing project scopes", () =>
    Effect.gen(function* () {
      const threadId = "thread-recovery-invalid";
      const projectId = "project-recovery-valid";
      yield* saveCheckpoint({
        id: "checkpoint-good",
        threadId,
        projectId,
        sequence: 1,
        checkpoint: { schemaVersion: 1, objective: "Resume safely", nextActions: ["review diff"] },
      });
      yield* saveCheckpoint({
        id: "checkpoint-bad",
        threadId,
        projectId,
        sequence: 2,
        checkpoint: { schemaVersion: 1, objective: "Later run" },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE agent_memory_checkpoints
        SET checkpoint_json = '{"schemaVersion":999}' WHERE id = 'checkpoint-bad'`;
      const found = yield* recoverCheckpoint({ threadId, projectId });
      assert.equal(found.checkpoint?.id, "checkpoint-good");
      assert.equal(found.skippedInvalid, 1);
      const other = yield* recoverCheckpoint({ threadId, projectId: "other-project" });
      assert.equal(other.checkpoint, null);
      assert.equal(other.skippedInvalid, 0);
    }),
  );

  it.effect("exports only selected live memories with provenance", () =>
    Effect.gen(function* () {
      const common = {
        kind: "fact" as const,
        sourceRef: "file:README.md@abc",
        sourceActor: "user",
        verification: "user_confirmed" as const,
      };
      yield* remember({
        ...common, id: "export-allowed", eventId: "export-allowed-event",
        scopeType: "project", scopeId: "export-project-a", content: "Allowed item",
      });
      yield* remember({
        ...common, id: "export-denied", eventId: "export-denied-event",
        scopeType: "project", scopeId: "export-project-b", content: "Another project",
      });
      const snapshot = yield* exportMemory([{ scopeType: "project", scopeId: "export-project-a" }]);
      assert.equal(snapshot.schemaVersion, 1);
      assert.ok(snapshot.entries.some((entry) => entry.id === "export-allowed"));
      assert.ok(snapshot.entries.every((entry) => entry.id !== "export-denied"));
      assert.equal(snapshot.entries[0]?.sourceRef, common.sourceRef);
      const empty = yield* Effect.result(exportMemory([]));
      assert.equal(empty._tag, "Failure");
    }),
  );
});

layer("AgentMemory persistence", (it) => {
  it.effect("pin changes are audited and do not cross project scopes", () =>
    Effect.gen(function* () {
      const input = {
        id: "test-memory-pin",
        eventId: "test-memory-pin-create",
        scopeType: "project" as const,
        scopeId: "pin-project-a",
        kind: "preference" as const,
        content: "Prefer deterministic tests",
        sourceRef: "thread:tests:1",
        sourceActor: "user",
        verification: "user_confirmed" as const,
      };
      yield* remember(input);
      const scope = { scopeType: input.scopeType, scopeId: input.scopeId };
      const wrong = yield* Effect.result(
        pinMemory({
          id: input.id,
          eventId: "pin-wrong",
          scope: { scopeType: "project", scopeId: "pin-project-b" },
          pinned: true,
        }),
      );
      assert.equal(wrong._tag, "Failure");
      assert.equal(yield* pinMemory({
        id: input.id, scope, eventId: "pin-first", pinned: true,
      }), true);
      assert.equal(yield* pinMemory({
        id: input.id, scope, eventId: "pin-retry", pinned: true,
      }), false);
      const items = yield* listMemory([scope]);
      assert.equal(items.find((item) => item.id === input.id)?.pinned, true);
      const sql = yield* SqlClient.SqlClient;
      const events = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS "count" FROM agent_memory_events
        WHERE memory_id = ${input.id} AND operation = 'pin_changed'
      `;
      assert.equal(events[0]?.count, 1);
    }),
  );


  it.effect("persists scoped source-backed memories with idempotent retries", () =>
    Effect.gen(function* () {
      const input = {
        id: "memory-create-1",
        eventId: "memory-create-event-1",
        scopeType: "project" as const,
        scopeId: "project-alpha",
        kind: "decision" as const,
        content: "Use a local SQLite-backed memory store",
        sourceRef: "conversation:event-100",
        sourceActor: "user",
        verification: "user_confirmed" as const,
        occurredAt: "2026-11-10T19:00:00.000Z",
      };
      const stored = yield* remember(input);
      const retry = yield* remember(input);
      assert.equal(stored.id, input.id);
      assert.deepStrictEqual(stored, retry);
      assert.equal(stored.sourceRef, input.sourceRef);

      const matching = yield* listMemory([{ scopeType: "project", scopeId: "project-alpha" }]);
      assert.ok(matching.some((item) => item.id === input.id));
      const unrelated = yield* listMemory([{ scopeType: "project", scopeId: "project-beta" }]);
      assert.ok(unrelated.every((item) => item.id !== input.id));

      const sql = yield* SqlClient.SqlClient;
      const events = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS "count" FROM agent_memory_events
        WHERE memory_id = ${input.id}
      `;
      assert.equal(events[0]?.count, 1);

      const collision = yield* Effect.result(remember({ ...input, content: "different" }));
      assert.equal(collision._tag, "Failure");
    }),
  );

  it.effect("tombstones a memory without touching other project scopes", () =>
    Effect.gen(function* () {
      const target = {
        id: "memory-delete-1",
        eventId: "memory-delete-event-1",
        scopeType: "project" as const,
        scopeId: "project-delete",
        kind: "fact" as const,
        content: "Temporary implementation fact",
        sourceRef: "file:README.md@123",
        sourceActor: "tool",
        verification: "verified" as const,
      };
      yield* remember(target);
      const wrongScope = yield* Effect.result(
        forgetMemory({
          id: target.id,
          scope: { scopeType: "project", scopeId: "different-project" },
          eventId: "memory-delete-wrong-scope",
        }),
      );
      assert.equal(wrongScope._tag, "Failure");
      assert.equal(
        yield* forgetMemory({
          id: target.id,
          scope: { scopeType: "project", scopeId: target.scopeId },
          eventId: "memory-delete-success",
        }),
        true,
      );
      assert.equal(
        yield* forgetMemory({
          id: target.id,
          scope: { scopeType: "project", scopeId: target.scopeId },
          eventId: "memory-delete-success",
        }),
        false,
      );
      const result = yield* listMemory([{ scopeType: "project", scopeId: target.scopeId }]);
      assert.ok(result.every((item) => item.id !== target.id));
    }),
  );

  it.effect("keeps versioned checkpoints and refuses conflicting retries", () =>
    Effect.gen(function* () {
      const first = {
        id: "cp-first",
        projectId: "project-checkpoints",
        threadId: "thread-checkpoints",
        taskId: "task-checkpoints",
        sequence: 10,
        createdAt: "2026-11-10T19:01:00.000Z",
        checkpoint: { schemaVersion: 1 as const, objective: "Edit a plan", planRevision: 1 },
      };
      const second = {
        ...first,
        id: "cp-second",
        sequence: 12,
        checkpoint: {
          schemaVersion: 1 as const,
          objective: "Edit a plan",
          planRevision: 2,
          decisionMemoryIds: ["memory-create-1"],
        },
      };
      yield* saveCheckpoint(first);
      yield* saveCheckpoint(second);
      const latest = yield* latestCheckpoint(first.threadId);
      assert.equal(latest?.id, second.id);
      assert.equal(latest?.sequence, 12);
      assert.equal(latest?.checkpoint.planRevision, 2);

      const retry = yield* saveCheckpoint(second);
      assert.equal(retry.id, second.id);
      const conflict = yield* Effect.result(
        saveCheckpoint({ ...second, id: "cp-conflicting", checkpoint: first.checkpoint }),
      );
      assert.equal(conflict._tag, "Failure");
    }),
  );
  it.effect("requires explicit user confirmation before a proposed memory is trusted", () =>
    Effect.gen(function* () {
      const proposal = {
        id: "memory-awaiting-confirmation",
        eventId: "memory-proposal-event",
        scopeType: "project" as const,
        scopeId: "project-proposals",
        kind: "decision" as const,
        content: "Use durable source-backed memory",
        sourceRef: "thread:t3-proposal:session:abc",
        sourceActor: "agent:claude",
        verification: "proposed" as const,
      };
      yield* remember(proposal);
      const scope = { scopeType: proposal.scopeType, scopeId: proposal.scopeId };
      const before = yield* listMemory([scope]);
      assert.equal(before.find((item) => item.id === proposal.id)?.verification, "proposed");
      assert.equal(
        yield* confirmMemory({
          id: proposal.id,
          scope,
          eventId: "memory-user-confirmed-event",
        }),
        true,
      );
      assert.equal(
        yield* confirmMemory({
          id: proposal.id,
          scope,
          eventId: "memory-user-confirmed-event",
        }),
        false,
      );
      const after = yield* listMemory([scope]);
      assert.equal(after.find((item) => item.id === proposal.id)?.verification, "user_confirmed");
      const sql = yield* SqlClient.SqlClient;
      const events = yield* sql<{ count: number }>`SELECT COUNT(*) AS "count"
        FROM agent_memory_events WHERE memory_id = ${proposal.id}`;
      assert.equal(events[0]?.count, 2);
    }),
  );

});
