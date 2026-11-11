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
import { potentialSecretCategory } from "./MemorySecrets.ts";

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
  /** Last committed canonical thread event (not the ordinal of a run). */
  readonly eventCursor?: number;
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
  /** Monotonic per-thread checkpoint index (currently run ordinal). This is NOT an event-store replay cursor. */
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
  const secret = potentialSecretCategory(input.content) ?? potentialSecretCategory(input.sourceRef);
  if (secret) {
    return yield* new AgentMemoryValidationError({
      detail: `Do not store potential ${secret} credentials in agent memory`,
    });
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
export const listMemory = Effect.fn("AgentMemory.listMemory")(function* (
  scopes: readonly MemoryScope[],
  limitPerScope = 100,
) {
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
        return yield* new AgentMemoryValidationError({
          detail: "Memory not found in selected scope",
        });
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

/**
 * Confirmation is a privileged host/UI action, never exposed as an agent MCP
 * tool. A proposed item is not injected into model context before this succeeds.
 */
export const confirmMemory = Effect.fn("AgentMemory.confirmMemory")(function* (input: {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly eventId: string;
  readonly occurredAt?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = input.occurredAt ?? DateTime.formatIso(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly verification: VerificationState;
        readonly tombstonedAt: string | null;
      }>`
        SELECT verification, tombstoned_at AS "tombstonedAt"
        FROM agent_memory_items
        WHERE id = ${input.id} AND scope_type = ${input.scope.scopeType}
          AND scope_id = ${input.scope.scopeId}
      `;
      const row = rows[0];
      if (!row || row.tombstonedAt !== null) {
        return yield* new AgentMemoryValidationError({
          detail: "Memory is missing or was deleted in this scope",
        });
      }
      if (row.verification === "user_confirmed") return false;
      yield* sql`
        UPDATE agent_memory_items
        SET verification = 'user_confirmed',
          last_verified_at = ${now}, updated_at = ${now}
        WHERE id = ${input.id} AND scope_type = ${input.scope.scopeType}
          AND scope_id = ${input.scope.scopeId} AND tombstoned_at IS NULL
      `;
      yield* sql`
        INSERT INTO agent_memory_events (
          event_id, memory_id, operation, payload_json, occurred_at
        ) VALUES (${input.eventId}, ${input.id}, 'user_confirmed', '{}', ${now})
      `;
      return true;
    }),
  );
});

/** Update a memory pin in the selected scope with an append-only audit event. */
export const pinMemory = Effect.fn("AgentMemory.pinMemory")(function* (input: {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly eventId: string;
  readonly pinned: boolean;
  readonly occurredAt?: string;
}) {
  if (
    [input.id, input.scope.scopeId, input.eventId].some((value) => ensureText("identifier", value))
  ) {
    return yield* new AgentMemoryValidationError({
      detail: "Memory ID, scope and event ID are required",
    });
  }
  const sql = yield* SqlClient.SqlClient;
  const now = input.occurredAt ?? DateTime.formatIso(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ pinned: number }>`
        SELECT pinned FROM agent_memory_items WHERE id = ${input.id}
          AND scope_type = ${input.scope.scopeType} AND scope_id = ${input.scope.scopeId}
          AND tombstoned_at IS NULL AND superseded_by IS NULL
      `;
      const row = rows[0];
      if (!row)
        return yield* new AgentMemoryValidationError({
          detail: "Memory not found in selected scope",
        });
      if ((row.pinned === 1) === input.pinned) return false;
      yield* sql`
        UPDATE agent_memory_items SET pinned = ${input.pinned ? 1 : 0}, updated_at = ${now}
        WHERE id = ${input.id} AND scope_type = ${input.scope.scopeType}
          AND scope_id = ${input.scope.scopeId} AND tombstoned_at IS NULL
      `;
      yield* sql`
        INSERT INTO agent_memory_events (event_id, memory_id, operation, payload_json, occurred_at)
        VALUES (${input.eventId}, ${input.id}, 'pin_changed', ${yield* encodeJson({ pinned: input.pinned })}, ${now})
      `;
      return true;
    }),
  );
});

/**
 * User edits create a new verified revision, never alter provenance of the
 * original. A superseded record remains in the audit trail but is excluded
 * from future retrieval and native provider context.
 */
export const reviseMemory = Effect.fn("AgentMemory.reviseMemory")(function* (input: {
  readonly id: string;
  readonly replacementId: string;
  readonly scope: MemoryScope;
  readonly content: string;
  readonly eventId: string;
  readonly occurredAt?: string;
}) {
  const validationError = [
    ensureText("id", input.id),
    ensureText("replacementId", input.replacementId),
    ensureText("scopeId", input.scope.scopeId),
    ensureText("content", input.content),
    ensureText("eventId", input.eventId),
  ].find(Boolean);
  if (validationError || input.id === input.replacementId) {
    return yield* new AgentMemoryValidationError({
      detail: validationError ?? "A revision needs a different memory ID",
    });
  }
  const secret = potentialSecretCategory(input.content);
  if (secret) {
    return yield* new AgentMemoryValidationError({
      detail: `Do not store potential ${secret} credentials in agent memory`,
    });
  }
  const sql = yield* SqlClient.SqlClient;
  const now = input.occurredAt ?? DateTime.formatIso(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const original = yield* sql<MemoryRow>`
        SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", kind, content,
          source_ref AS "sourceRef", source_actor AS "sourceActor", verification,
          confidence, pinned, created_at AS "createdAt", updated_at AS "updatedAt",
          last_verified_at AS "lastVerifiedAt", superseded_by AS "supersededBy",
          tombstoned_at AS "tombstonedAt"
        FROM agent_memory_items
        WHERE id = ${input.id}
          AND scope_type = ${input.scope.scopeType}
          AND scope_id = ${input.scope.scopeId}
      `;
      const old = original[0];
      if (!old || old.tombstonedAt !== null) {
        return yield* new AgentMemoryValidationError({
          detail: "Memory not found in selected scope",
        });
      }
      // Replaying the same request must return its committed revision.
      if (old.supersededBy === input.replacementId) {
        const saved = yield* sql<MemoryRow>`
          SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", kind, content,
            source_ref AS "sourceRef", source_actor AS "sourceActor", verification,
            confidence, pinned, created_at AS "createdAt", updated_at AS "updatedAt",
            last_verified_at AS "lastVerifiedAt", superseded_by AS "supersededBy",
            tombstoned_at AS "tombstonedAt"
          FROM agent_memory_items WHERE id = ${input.replacementId}
            AND scope_type = ${input.scope.scopeType}
            AND scope_id = ${input.scope.scopeId}
        `;
        if (saved[0]?.content === input.content) return toEntry(saved[0]);
        return yield* new AgentMemoryValidationError({
          detail: "Revision ID was already used with different content",
        });
      }
      if (old.supersededBy !== null) {
        return yield* new AgentMemoryValidationError({
          detail: "This memory was already revised; refresh before editing",
        });
      }
      const sourceRef = `memory:${old.id}`;
      yield* sql`
        INSERT INTO agent_memory_items (
          id, scope_type, scope_id, kind, content, source_ref, source_actor,
          verification, confidence, pinned, created_at, updated_at, last_verified_at
        ) VALUES (
          ${input.replacementId}, ${old.scopeType}, ${old.scopeId}, ${old.kind},
          ${input.content}, ${sourceRef}, 'user', 'user_confirmed',
          ${old.confidence}, ${old.pinned}, ${now}, ${now}, ${now}
        )
      `;
      yield* sql`
        UPDATE agent_memory_items SET superseded_by = ${input.replacementId}, updated_at = ${now}
        WHERE id = ${old.id} AND scope_type = ${old.scopeType}
          AND scope_id = ${old.scopeId} AND tombstoned_at IS NULL
          AND superseded_by IS NULL
      `;
      yield* sql`
        INSERT INTO agent_memory_events (
          event_id, memory_id, operation, payload_json, occurred_at
        ) VALUES (
          ${input.eventId}, ${old.id}, 'superseded',
          ${yield* encodeJson({ replacementId: input.replacementId })}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO agent_memory_events (
          event_id, memory_id, operation, payload_json, occurred_at
        ) VALUES (
          ${input.eventId + ":revision"}, ${input.replacementId}, 'user_revised',
          ${yield* encodeJson({ previousId: old.id, originalSourceRef: old.sourceRef })}, ${now}
        )
      `;
      return {
        id: input.replacementId,
        scopeType: old.scopeType,
        scopeId: old.scopeId,
        kind: old.kind,
        content: input.content,
        sourceRef,
        sourceActor: "user",
        verification: "user_confirmed",
        confidence: old.confidence,
        pinned: old.pinned === 1,
        createdAt: now,
        updatedAt: now,
        lastVerifiedAt: now,
        supersededBy: null,
        tombstonedAt: null,
      } satisfies MemoryEntry;
    }),
  );
});

/** Refuse malformed optional recovery state, not only unsupported schema versions.
 * Imported backups are integrity-checked but are not authenticated statements
 * about a native session or repository, so all known fields need validation.
 */
export function isValidContextCheckpoint(value: unknown): value is ContextCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.objective !== "string" ||
    !candidate.objective.trim()
  )
    return false;
  for (const key of ["planId", "nativeSessionId", "provider", "branch", "headCommit"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") return false;
  }
  if (
    candidate.headCommit !== undefined &&
    !/^[a-f0-9]{40,64}$/i.test(candidate.headCommit as string)
  )
    return false;
  if (
    candidate.eventCursor !== undefined &&
    (!Number.isSafeInteger(candidate.eventCursor) || (candidate.eventCursor as number) < 0)
  )
    return false;
  if (
    candidate.planRevision !== undefined &&
    (!Number.isSafeInteger(candidate.planRevision) || (candidate.planRevision as number) < 0)
  )
    return false;
  for (const key of [
    "completedStepIds",
    "pendingStepIds",
    "activeStepIds",
    "decisionMemoryIds",
    "sourceEventRefs",
    "contextArtifactRefs",
    "nextActions",
    "openQuestions",
  ]) {
    const field = candidate[key];
    if (
      field !== undefined &&
      (!Array.isArray(field) || !field.every((entry: unknown) => typeof entry === "string"))
    ) {
      return false;
    }
  }
  return true;
}

/** Context checkpoints are versioned, append-only and scoped by thread. */
export const saveCheckpoint = Effect.fn("AgentMemory.saveCheckpoint")(function* (
  input: SaveCheckpointInput,
) {
  if (
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    !input.id.trim() ||
    !input.projectId.trim() ||
    !input.threadId.trim() ||
    !isValidContextCheckpoint(input.checkpoint)
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
          return yield* new AgentMemoryValidationError({
            detail: "Conflicting checkpoint at this sequence",
          });
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

/**
 * Restore the newest *valid* checkpoint for one canonical project/thread pair.
 * A newer row may be damaged by a crash or an old unsupported schema: never
 * let it mask an earlier committed checkpoint. The caller remains responsible
 * for checking the repository HEAD and replaying later canonical events.
 */
export const recoverCheckpoint = Effect.fn("AgentMemory.recoverCheckpoint")(function* (input: {
  readonly projectId: string;
  readonly threadId: string;
}) {
  if (!input.projectId.trim() || !input.threadId.trim()) {
    return yield* new AgentMemoryValidationError({ detail: "Project and thread are required" });
  }
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CheckpointRow>`
    SELECT id, project_id AS "projectId", thread_id AS "threadId",
      task_id AS "taskId", sequence, checkpoint_json AS "checkpointJson",
      created_at AS "createdAt"
    FROM agent_memory_checkpoints
    WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
    ORDER BY sequence DESC
  `;
  let skippedInvalid = 0;
  for (const row of rows) {
    const checkpoint = yield* decodeJson(row.checkpointJson).pipe(Effect.orElseSucceed(() => null));
    if (!isValidContextCheckpoint(checkpoint)) {
      skippedInvalid++;
      continue;
    }
    return {
      checkpoint: {
        id: row.id,
        projectId: row.projectId,
        threadId: row.threadId,
        taskId: row.taskId,
        sequence: row.sequence,
        checkpoint,
        createdAt: row.createdAt,
      } satisfies SavedCheckpoint,
      skippedInvalid,
    };
  }
  return { checkpoint: null, skippedInvalid };
});

/**
 * Read bounded checkpoint history for an explicitly selected canonical
 * project/thread pair. Invalid/corrupt entries are counted but never returned
 * as executable recovery state. Pagination is intentionally recent-first.
 */
export const listCheckpointHistory = Effect.fn("AgentMemory.listCheckpointHistory")(
  function* (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly limit?: number | undefined;
  }) {
    if (!input.projectId.trim() || !input.threadId.trim()) {
      return yield* new AgentMemoryValidationError({ detail: "Project and thread are required" });
    }
    const sql = yield* SqlClient.SqlClient;
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 30)));
    const rows = yield* sql<CheckpointRow>`
    SELECT id, project_id AS "projectId", thread_id AS "threadId",
      task_id AS "taskId", sequence, checkpoint_json AS "checkpointJson",
      created_at AS "createdAt"
    FROM agent_memory_checkpoints
    WHERE project_id = ${input.projectId} AND thread_id = ${input.threadId}
    ORDER BY sequence DESC LIMIT ${limit + 1}
  `;
    const checkpoints: Array<SavedCheckpoint & { readonly taskId: string | null }> = [];
    let skippedInvalid = 0;
    for (const row of rows.slice(0, limit)) {
      const decoded = yield* decodeJson(row.checkpointJson).pipe(Effect.orElseSucceed(() => null));
      if (!isValidContextCheckpoint(decoded)) {
        skippedInvalid++;
        continue;
      }
      checkpoints.push({
        id: row.id,
        projectId: row.projectId,
        threadId: row.threadId,
        taskId: row.taskId,
        sequence: row.sequence,
        checkpoint: decoded,
        createdAt: row.createdAt,
      });
    }
    return { checkpoints, skippedInvalid, truncated: rows.length > limit };
  },
);

/**
 * Legacy thread-only lookup. Prefer recoverCheckpoint with the canonical
 * project ID at any user/API boundary to prevent cross-project probing.
 */
export const latestCheckpoint = Effect.fn("AgentMemory.latestCheckpoint")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql<{ readonly projectId: string }>`
    SELECT project_id AS "projectId" FROM agent_memory_checkpoints
    WHERE thread_id = ${threadId} ORDER BY sequence DESC LIMIT 1
  `;
  if (!projects[0]) return null;
  const recovered = yield* recoverCheckpoint({ projectId: projects[0].projectId, threadId });
  return recovered.checkpoint;
});

/** Export live entries only from caller-authorized exact scopes (no global wildcard). */
export const exportMemory = Effect.fn("AgentMemory.exportMemory")(function* (
  scopes: readonly MemoryScope[],
) {
  if (scopes.length === 0) {
    return yield* new AgentMemoryValidationError({
      detail: "At least one authorized scope is required",
    });
  }
  const entries = yield* listMemory(scopes, 500);
  return {
    schemaVersion: 1 as const,
    entries,
  };
});
