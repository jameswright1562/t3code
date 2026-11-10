import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  forgetMemory,
  latestCheckpoint,
  listMemory,
  remember,
  saveCheckpoint,
} from "./AgentMemory.ts";

const layer = it.layer(SqlitePersistenceMemory);

layer("AgentMemory persistence", (it) => {
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
});
