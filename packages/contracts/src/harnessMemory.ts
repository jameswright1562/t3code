import * as Schema from "effect/Schema";

/** Wire contracts for host-authorized, source-backed memory management. */
export const HarnessMemoryScopeType = Schema.Literals(["global", "workspace", "project", "thread", "task"]);
export const HarnessMemoryKind = Schema.Literals([
  "fact", "decision", "preference", "constraint", "file_reference",
  "failed_approach", "open_question", "procedure", "outcome",
]);
export const HarnessMemoryVerification = Schema.Literals(["proposed", "verified", "user_confirmed"]);
export const HarnessMemoryScope = Schema.Struct({
  scopeType: HarnessMemoryScopeType,
  scopeId: Schema.String,
});
export const HarnessMemoryEntry = Schema.Struct({
  id: Schema.String,
  scopeType: HarnessMemoryScopeType,
  scopeId: Schema.String,
  kind: HarnessMemoryKind,
  content: Schema.String,
  sourceRef: Schema.String,
  sourceActor: Schema.String,
  verification: HarnessMemoryVerification,
  confidence: Schema.NullOr(Schema.Number),
  pinned: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastVerifiedAt: Schema.NullOr(Schema.String),
  supersededBy: Schema.NullOr(Schema.String),
  tombstonedAt: Schema.NullOr(Schema.String),
});
export type HarnessMemoryEntry = typeof HarnessMemoryEntry.Type;
export const HarnessMemoryListInput = Schema.Struct({
  scope: HarnessMemoryScope,
  limit: Schema.optional(Schema.Number),
});
export const HarnessMemoryMutationInput = Schema.Struct({
  scope: HarnessMemoryScope,
  id: Schema.String,
  eventId: Schema.String,
});
export const HarnessMemoryReviseInput = Schema.Struct({
  ...HarnessMemoryMutationInput.fields,
  replacementId: Schema.String,
  content: Schema.String,
});
export const HarnessMemoryPinInput = Schema.Struct({
  ...HarnessMemoryMutationInput.fields,
  pinned: Schema.Boolean,
});
export const HarnessMemoryExport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entries: Schema.Array(HarnessMemoryEntry),
});
/** Full audited memory backup, distinct from live-only export. */
export const HarnessMemoryAuditEvent = Schema.Struct({
  eventId: Schema.String,
  memoryId: Schema.String,
  operation: Schema.String,
  payloadJson: Schema.String,
  occurredAt: Schema.String,
});
export const HarnessMemoryCheckpointArchive = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  sequence: Schema.Number,
  checkpointJson: Schema.String,
  createdAt: Schema.String,
  schemaVersion: Schema.Number,
});
export const HarnessMemoryBackup = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  scope: HarnessMemoryScope,
  entries: Schema.Array(HarnessMemoryEntry),
  events: Schema.Array(HarnessMemoryAuditEvent),
  checkpoints: Schema.Array(HarnessMemoryCheckpointArchive),
  checksum: Schema.String,
});
export type HarnessMemoryBackup = typeof HarnessMemoryBackup.Type;
export const HarnessMemoryRestoreInput = Schema.Struct({
  scope: HarnessMemoryScope,
  backup: HarnessMemoryBackup,
});
export const HarnessMemoryRestoreResult = Schema.Struct({
  importedEntries: Schema.Number,
  importedEvents: Schema.Number,
  importedCheckpoints: Schema.Number,
});
export const HarnessCheckpointRecoverInput = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
});
export const HarnessCheckpointRecovery = Schema.Struct({
  checkpoint: Schema.NullOr(Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    threadId: Schema.String,
    taskId: Schema.optional(Schema.NullOr(Schema.String)),
    sequence: Schema.Number,
    createdAt: Schema.String,
    checkpoint: Schema.Unknown,
  })),
  skippedInvalid: Schema.Number,
});
export class HarnessMemoryError extends Schema.TaggedError<HarnessMemoryError>()(
  "HarnessMemoryError",
  { message: Schema.String },
) {}
