import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  AgentMemoryValidationError,
  type MemoryEntry,
  type MemoryScope,
} from "./AgentMemory.ts";

/**
 * A lossless backup of the memory ledger for ONE explicitly selected scope.
 * Unlike the older live-memory export this includes tombstones, superseded
 * revisions, original timestamps, provenance and all corresponding events.
 * The digest detects accidental corruption, not malicious alteration.
 */
export interface MemoryAuditEvent {
  readonly eventId: string;
  readonly memoryId: string;
  readonly operation: string;
  readonly payloadJson: string;
  readonly occurredAt: string;
}
export interface MemoryBackup {
  readonly schemaVersion: 1;
  readonly scope: MemoryScope;
  readonly entries: readonly MemoryEntry[];
  readonly events: readonly MemoryAuditEvent[];
  readonly checksum: string;
}
export interface MemoryImportResult {
  readonly importedEntries: number;
  readonly importedEvents: number;
}
type BackupPayload = Omit<MemoryBackup, "checksum">;

interface MemoryRow extends Omit<MemoryEntry, "pinned"> {
  readonly pinned: number;
}

const MAX_ITEMS = 10000;
const MAX_EVENTS = 100000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Deterministic digest over the exact serialized scope, records and audit ledger. */
export const checksumMemoryBackup = Effect.fn("MemoryBackup.checksum")(function* (payload: BackupPayload) {
  const serialized = yield* encodeJson(payload);
  return yield* Digest.Digest.pipe(
    Effect.flatMap((service) =>
      service.digestHex(Digest.sha256, new TextEncoder().encode(serialized))),
    Effect.provide(Digest.layerWebCrypto),
  );
});
const item = (row: MemoryRow): MemoryEntry => ({
  ...row,
  pinned: row.pinned === 1,
});
const invalid = (detail: string) => new AgentMemoryValidationError({ detail });

export const exportMemoryBackup = Effect.fn("MemoryBackup.export")(function* (scope: MemoryScope) {
  if (!scope.scopeId.trim()) return yield* invalid("A specific memory scope is required");
  const sql = yield* SqlClient.SqlClient;
  // No implicit global or cross-project scope. Older revisions and deleted
  // rows are deliberately included; these must not be lost during restore.
  const rows = yield* sql<MemoryRow>`
    SELECT id, scope_type AS "scopeType", scope_id AS "scopeId",
      kind, content, source_ref AS "sourceRef", source_actor AS "sourceActor",
      verification, confidence, pinned, created_at AS "createdAt",
      updated_at AS "updatedAt", last_verified_at AS "lastVerifiedAt",
      superseded_by AS "supersededBy", tombstoned_at AS "tombstonedAt"
    FROM agent_memory_items
    WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
    ORDER BY created_at, id
  `;
  const events = yield* sql<MemoryAuditEvent>`
    SELECT e.event_id AS "eventId", e.memory_id AS "memoryId",
      e.operation, e.payload_json AS "payloadJson", e.occurred_at AS "occurredAt"
    FROM agent_memory_events e JOIN agent_memory_items m ON m.id = e.memory_id
    WHERE m.scope_type = ${scope.scopeType} AND m.scope_id = ${scope.scopeId}
    ORDER BY e.seq
  `;
  if (rows.length > MAX_ITEMS || events.length > MAX_EVENTS) {
    return yield* invalid("Backup exceeds the per-scope entry or audit event limit");
  }
  const payload = {
    schemaVersion: 1 as const,
    scope,
    entries: rows.map(item),
    events,
  };
  const encoded = yield* encodeJson(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES) {
    return yield* invalid("Backup exceeds the 16 MiB limit");
  }
  return { ...payload, checksum: yield* checksumMemoryBackup(payload) } satisfies MemoryBackup;
});

export const importMemoryBackup = Effect.fn("MemoryBackup.import")(function* (input: {
  readonly scope: MemoryScope;
  readonly backup: MemoryBackup;
}) {
  const { scope, backup } = input;
  if (!scope.scopeId.trim() || backup.schemaVersion !== 1 ||
      backup.scope.scopeType !== scope.scopeType || backup.scope.scopeId !== scope.scopeId) {
    return yield* invalid("Backup does not belong to the selected scope");
  }
  const payload: BackupPayload = {
    schemaVersion: backup.schemaVersion,
    scope: backup.scope,
    entries: backup.entries,
    events: backup.events,
  };
  const encoded = yield* encodeJson(payload);
  if (backup.entries.length > MAX_ITEMS || backup.events.length > MAX_EVENTS ||
      Buffer.byteLength(encoded, "utf8") > MAX_JSON_BYTES ||
      !/^[a-f0-9]{64}$/.test(backup.checksum) ||
      (yield* checksumMemoryBackup(payload)) !== backup.checksum) {
    return yield* invalid("Backup checksum, size or format is invalid");
  }
  const ids = new Set<string>();
  for (const entry of backup.entries) {
    if (!entry.id.trim() || ids.has(entry.id) ||
        entry.scopeType !== scope.scopeType || entry.scopeId !== scope.scopeId ||
        !entry.content.trim() || !entry.sourceRef.trim()) {
      return yield* invalid("Backup contains duplicate, invalid or out-of-scope memory");
    }
    ids.add(entry.id);
  }
  const eventIds = new Set<string>();
  for (const event of backup.events) {
    if (!event.eventId.trim() || eventIds.has(event.eventId) ||
        !ids.has(event.memoryId)) {
      return yield* invalid("Backup contains duplicate or unscoped audit events");
    }
    eventIds.add(event.eventId);
    const decoded = yield* Effect.result(decodeJson(event.payloadJson));
    if (decoded._tag === "Failure") {
      return yield* invalid("Backup contains malformed audit JSON");
    }
  }
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let importedEntries = 0;
      let importedEvents = 0;
      for (const entry of backup.entries) {
        // Conflicting IDs must abort the ENTIRE restore, never mutate an
        // existing user-confirmed memory or silently resurrect tombstones.
        const existing = yield* sql<MemoryRow>`
          SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", kind,
            content, source_ref AS "sourceRef", source_actor AS "sourceActor",
            verification, confidence, pinned, created_at AS "createdAt",
            updated_at AS "updatedAt", last_verified_at AS "lastVerifiedAt",
            superseded_by AS "supersededBy", tombstoned_at AS "tombstonedAt"
          FROM agent_memory_items WHERE id = ${entry.id}
        `;
        if (existing[0]) {
          const stored = item(existing[0]);
          if (!(Object.keys(entry) as (keyof MemoryEntry)[]).every(
            (key) => stored[key] === entry[key]
          )) return yield* invalid("Existing memory conflicts with backup: " + entry.id);
          continue;
        }
        yield* sql`
          INSERT INTO agent_memory_items (
            id, scope_type, scope_id, kind, content, source_ref, source_actor,
            verification, confidence, pinned, created_at, updated_at,
            last_verified_at, superseded_by, tombstoned_at, schema_version
          ) VALUES (
            ${entry.id}, ${entry.scopeType}, ${entry.scopeId}, ${entry.kind},
            ${entry.content}, ${entry.sourceRef}, ${entry.sourceActor},
            ${entry.verification}, ${entry.confidence}, ${entry.pinned ? 1 : 0},
            ${entry.createdAt}, ${entry.updatedAt}, ${entry.lastVerifiedAt},
            ${entry.supersededBy}, ${entry.tombstonedAt}, 1
          )
        `;
        importedEntries++;
      }
      for (const event of backup.events) {
        const existing = yield* sql<MemoryAuditEvent>`
          SELECT event_id AS "eventId", memory_id AS "memoryId", operation,
            payload_json AS "payloadJson", occurred_at AS "occurredAt"
          FROM agent_memory_events WHERE event_id = ${event.eventId}
        `;
        if (existing[0]) {
          if (!(Object.keys(event) as (keyof MemoryAuditEvent)[]).every(
            (key) => existing[0]![key] === event[key]
          )) return yield* invalid("Existing audit event conflicts with backup: " + event.eventId);
          continue;
        }
        yield* sql`
          INSERT INTO agent_memory_events
            (event_id, memory_id, operation, payload_json, occurred_at)
          VALUES (
            ${event.eventId}, ${event.memoryId}, ${event.operation},
            ${event.payloadJson}, ${event.occurredAt}
          )
        `;
        importedEvents++;
      }
      return { importedEntries, importedEvents } satisfies MemoryImportResult;
    }),
  );
});
