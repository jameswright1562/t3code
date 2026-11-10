/**
 * Durable, source-backed agent memory and restartable context checkpoints.
 *
 * Initial persistence surface. This intentionally does not intercept model
 * prompts or automatically promote model outputs to verified memory.
 * It requires an existing T3 SqlClient and migration 029 to have run.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export type MemoryScopeType = "global" | "workspace" | "project" | "thread" | "task";
export type MemoryKind =
  | "fact"
  | "decision"
  | "preference"
  | "constraint"
  | "file_reference"
  | "failed_approach"
  | "open_question"
  | "procedure"
  | "outcome";
export type VerificationState = "proposed" | "verified" | "user_confirmed";

export interface MemoryScope {
  readonly scopeType: MemoryScopeType;
  readonly scopeId: string;
}

export interface MemoryEntry extends MemoryScope {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceRef: string;
  readonly sourceActor: string;
  readonly verification: VerificationState;
  readonly confidence: number | null;
  readonly pinned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastVerifiedAt: string | null;
  readonly supersededBy: string | null;
  readonly tombstonedAt: string | null;
}

export interface RememberInput extends MemoryScope {
  /** Stable, caller-generated operation and item IDs make retry idempotent. */
  readonly id: string;
  readonly eventId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sourceRef: string;
  readonly sourceActor: string;
  readonly verification: VerificationState;
  readonly confidence?: number | null;
  readonly pinned?: boolean;
  readonly occurredAt?: string;
}

export interface ContextCheckpoint {
  readonly schemaVersion: 1;
  readonly objective: string;
  readonly planId?: string;
  readonly planRevision?: number;
  readonly completedStepIds?: readonly string[];
  readonly pendingStepIds?: readonly string[];
  readonly activeStepIds?: readonly string[];
  readonly decisionMemoryIds?: readonly string[];
  readonly sourceEventRefs?: readonly string[];
  readonly contextArtifactRefs?: readonly string[];
  readonly nativeSessionId?: string;
  readonly provider?: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly nextActions?: readonly string[];
  readonly openQuestions?: readonly string[];
}

export interface SaveCheckpointInput {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly taskId?: string | null;
  /** Last committed orchestration event sequence covered by this snapshot. */
  readonly sequence: number;
  readonly checkpoint: ContextCheckpoint;
  readonly createdAt?: string;
}

export interface SavedCheckpoint extends SaveCheckpointInput {
  readonly createdAt: string;
}

interface MemoryRow {
  id: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  kind: MemoryKind;
  content: string;
  sourceRef: string;
  sourceActor: string;
  verification: VerificationState;
  confidence: number | null;
  pinned: number;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  supersededBy: string | null;
  tombstonedAt: string | null;
}
interface CheckpointRow {
  id: string;
  projectId: string;
  threadId: string;
  taskId: string | null;
  sequence: number;
  checkpointJson: string;
  createdAt: string;
}

const toEntry = (row: MemoryRow): MemoryEntry => ({
  ...row,
  pinned: row.pinned === 1,
});

const ensureText = (label: string, value: string) =>
  value.trim().length > 0 && value.length <= 100_000
    ? undefined
    : label + " must be non-empty and at most 100,000 characters";

export class AgentMemoryValidationError extends Schema.TaggedError<AgentMemoryValidationError>()(
  "AgentMemoryValidationError",
  { detail: Schema.String },
) {}

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Persist one new memory with its provenance and event in one transaction.
 * Existing identical item IDs are safe to retry. Different content with the
 * same ID is rejected; revisions must use explicit supersession instead.
 */
export const remember = Effect.fn("AgentMemory.remember")(function* (input: RememberInput) {
    const validationError = [
      ensureText("id", input.id),
      ensureText("eventId", input.eventId),
      ensureText("scopeId", input.scopeId),
      ensureText("content", input.content),
      ensureText("sourceRef", input.sourceRef),
      ensureText("sourceActor", input.sourceActor),
    ].find(Boolean);
    if (validationError) {
      return yield* new AgentMemoryValidationError({ detail: validationError });
    }
    if (
      input.confidence != null &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    ) {
      return yield* new AgentMemoryValidationError({ detail: "confidence must be between 0 and 1" });
    }
    const sql = yield* SqlClient.SqlClient;
    const now = input.occurredAt ?? DateTime.formatIso(yield* DateTime.now);

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<MemoryRow>`
          SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", kind, content,
            source_ref AS "sourceRef", source_actor AS "sourceActor", verification,
            confidence, pinned, created_at AS "createdAt", updated_at AS "updatedAt",
            last_verified_at AS "lastVerifiedAt", superseded_by AS "supersededBy",
            tombstoned_at AS "tombstonedAt"
          FROM agent_memory_items
          WHERE id = ${input.id}
        `;
        const previous = existing[0];
        if (previous) {
          if (
            previous.scopeType !== input.scopeType ||
            previous.scopeId !== input.scopeId ||
            previous.content !== input.content ||
            previous.sourceRef !== input.sourceRef ||
            previous.kind !== input.kind
          ) {
            return yield* new AgentMemoryValidationError({
              detail: "Memory ID already exists with different content or provenance",
            });
          }
          return toEntry(previous);
        }

        yield* sql`
          INSERT INTO agent_memory_items (
            id, scope_type, scope_id, kind, content, source_ref, source_actor,
            verification, confidence, pinned, created_at, updated_at, last_verified_at
          ) VALUES (
            ${input.id}, ${input.scopeType}, ${input.scopeId}, ${input.kind}, ${input.content},
            ${input.sourceRef}, ${input.sourceActor}, ${input.verification},
            ${input.confidence ?? null}, ${input.pinned ? 1 : 0}, ${now}, ${now},
            ${input.verification === "proposed" ? null : now}
          )
        `;
        yield* sql`
          INSERT INTO agent_memory_events (
            event_id, memory_id, operation, payload_json, occurred_at
          ) VALUES (
            ${input.eventId}, ${input.id}, 'created',
            ${yield* encodeJson({
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              kind: input.kind,
              sourceRef: input.sourceRef,
            })}, ${now}
          )
        `;
        return {
          id: input.id,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          kind: input.kind,
          content: input.content,
          sourceRef: input.sourceRef,
          sourceActor: input.sourceActor,
          verification: input.verification,
          confidence: input.confidence ?? null,
          pinned: input.pinned ?? false,
          createdAt: now,
          updatedAt: now,
          lastVerifiedAt: input.verification === "proposed" ? null : now,
          supersededBy: null,
          tombstonedAt: null,
        } satisfies MemoryEntry;
      }),
    );
  });

/**
 * Exact scope matching. No implicit cross-project/global retrieval.
 * The caller must explicitly supply every scope that it is authorized to read.
 */
export const listMemory = Effect.fn("AgentMemory.listMemory")(function* (scopes: readonly MemoryScope[], limitPerScope = 100) {
    const sql = yield* SqlClient.SqlClient;
    const limit = Math.max(1, Math.min(500, Math.floor(limitPerScope)));
    const result: MemoryEntry[] = [];
    for (const scope of scopes) {
      const rows = yield* sql<MemoryRow>`
        SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", kind, content,
          source_ref AS "sourceRef", source_actor AS "sourceActor", verification,
          confidence, pinned, created_at AS "createdAt", updated_at AS "updatedAt",
          last_verified_at AS "lastVerifiedAt", superseded_by AS "supersededBy",
          tombstoned_at AS "tombstonedAt"
        FROM agent_memory_items
        WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
          AND tombstoned_at IS NULL AND superseded_by IS NULL
        ORDER BY pinned DESC, updated_at DESC, id ASC
        LIMIT ${limit}
      `;
      result.push(...rows.map(toEntry));
    }
    return result;
  });

/**
 * Tombstone in place; never silently delete the immutable audit event.
 * Scope matching prevents accidentally deleting another project's record.
 */
export const forgetMemory = Effect.fn("AgentMemory.forgetMemory")(function* (input: {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly eventId: string;
  readonly occurredAt?: string;
}) {
    const sql = yield* SqlClient.SqlClient;
    const now = input.occurredAt ?? DateTime.formatIso(yield* DateTime.now);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: string; readonly tombstonedAt: string | null }>`
          SELECT id, tombstoned_at AS "tombstonedAt"
          FROM agent_memory_items
          WHERE id = ${input.id} AND scope_type = ${input.scope.scopeType}
            AND scope_id = ${input.scope.scopeId}
        `;
        if (!rows[0]) {
          return yield* new AgentMemoryValidationError({ detail: "Memory not found in selected scope" });
        }
        if (rows[0].tombstonedAt !== null) return false;
        yield* sql`
          UPDATE agent_memory_items
          SET tombstoned_at = ${now}, updated_at = ${now}
          WHERE id = ${input.id}
        `;
        yield* sql`
          INSERT INTO agent_memory_events (
            event_id, memory_id, operation, payload_json, occurred_at
          ) VALUES (${input.eventId}, ${input.id}, 'tombstoned', '{}', ${now})
        `;
        return true;
      }),
    );
  });

/** Context checkpoints are versioned, append-only and scoped by thread. */
export const saveCheckpoint = Effect.fn("AgentMemory.saveCheckpoint")(function* (input: SaveCheckpointInput) {
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      !input.id.trim() ||
      !input.projectId.trim() ||
      !input.threadId.trim() ||
      input.checkpoint.schemaVersion !== 1 ||
      !input.checkpoint.objective.trim()
    ) {
      return yield* new AgentMemoryValidationError({ detail: "Invalid memory checkpoint" });
    }
    const sql = yield* SqlClient.SqlClient;
    const json = yield* encodeJson(input.checkpoint);
    const createdAt = input.createdAt ?? DateTime.formatIso(yield* DateTime.now);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<CheckpointRow>`
          SELECT id, project_id AS "projectId", thread_id AS "threadId",
            task_id AS "taskId", sequence, checkpoint_json AS "checkpointJson",
            created_at AS "createdAt"
          FROM agent_memory_checkpoints
          WHERE thread_id = ${input.threadId} AND sequence = ${input.sequence}
        `;
        if (rows[0]) {
          if (rows[0].id !== input.id || rows[0].checkpointJson !== json) {
            return yield* new AgentMemoryValidationError({ detail: "Conflicting checkpoint at this sequence" });
          }
          return { ...input, createdAt: rows[0].createdAt } satisfies SavedCheckpoint;
        }
        yield* sql`
          INSERT INTO agent_memory_checkpoints (
            id, project_id, thread_id, task_id, sequence,
            checkpoint_json, created_at, schema_version
          ) VALUES (
            ${input.id}, ${input.projectId}, ${input.threadId}, ${input.taskId ?? null},
            ${input.sequence}, ${json}, ${createdAt}, 1
          )
        `;
        return { ...input, createdAt } satisfies SavedCheckpoint;
      }),
    );
  });

export const latestCheckpoint = Effect.fn("AgentMemory.latestCheckpoint")(function* (threadId: string) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<CheckpointRow>`
      SELECT id, project_id AS "projectId", thread_id AS "threadId",
        task_id AS "taskId", sequence, checkpoint_json AS "checkpointJson",
        created_at AS "createdAt"
      FROM agent_memory_checkpoints
      WHERE thread_id = ${threadId}
      ORDER BY sequence DESC LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.projectId,
      threadId: row.threadId,
      taskId: row.taskId,
      sequence: row.sequence,
      checkpoint: (yield* decodeJson(row.checkpointJson)) as ContextCheckpoint,
      createdAt: row.createdAt,
    } satisfies SavedCheckpoint;
  });
