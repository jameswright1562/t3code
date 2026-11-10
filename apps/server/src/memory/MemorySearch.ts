/**
 * Indexed candidate discovery for source-backed memory. No model calls,
 * embeddings, implicit global scopes or unapproved proposal retrieval.
 * Ranking/token budgeting happens separately in MemoryContext.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { MemoryEntry, MemoryScope } from "./AgentMemory.ts";

interface MemoryRow extends Omit<MemoryEntry, "pinned"> {
  readonly pinned: number;
}
const toEntry = (row: MemoryRow): MemoryEntry => ({ ...row, pinned: row.pinned === 1 });

/** Quoted FTS phrases are derived from Unicode word tokens, not raw user syntax. */
export function makeMemoryFtsQuery(query: string): string | null {
  const tokens = [...new Set(query.toLocaleLowerCase("en").match(/[\p{L}\p{N}_.-]{3,}/gu) ?? [])].slice(0, 8);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"`).join(" OR ");
}

export const searchMemoryCandidates = Effect.fn("AgentMemory.searchCandidates")(function* (input: {
  readonly scopes: readonly MemoryScope[];
  readonly query: string;
  readonly limitPerScope?: number;
}) {
  if (input.scopes.length === 0) return [] as MemoryEntry[];
  const sql = yield* SqlClient.SqlClient;
  const limit = Math.max(1, Math.min(500, Math.floor(input.limitPerScope ?? 250)));
  const match = makeMemoryFtsQuery(input.query.slice(0, 1000));
  const index = match === null ? [] : yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_memory_search'
  `;
  const indexed = match !== null && index.length > 0;
  const found = new Map<string, MemoryEntry>();
  for (const scope of input.scopes) {
    if (!scope.scopeId.trim()) continue;
    const rows = indexed
      ? yield* sql<MemoryRow>`
        SELECT m.id, m.scope_type AS "scopeType", m.scope_id AS "scopeId",
          m.kind, m.content, m.source_ref AS "sourceRef",
          m.source_actor AS "sourceActor", m.verification, m.confidence,
          m.pinned, m.created_at AS "createdAt", m.updated_at AS "updatedAt",
          m.last_verified_at AS "lastVerifiedAt",
          m.superseded_by AS "supersededBy", m.tombstoned_at AS "tombstonedAt"
        FROM agent_memory_items m
        WHERE m.scope_type = ${scope.scopeType} AND m.scope_id = ${scope.scopeId}
          AND m.tombstoned_at IS NULL AND m.superseded_by IS NULL
          AND m.verification <> 'proposed'
          AND (m.pinned = 1 OR m.rowid IN (
            SELECT rowid FROM agent_memory_search
            WHERE agent_memory_search MATCH ${match}
          ))
        ORDER BY m.pinned DESC, m.updated_at DESC, m.id
        LIMIT ${limit}
      `
      : yield* sql<MemoryRow>`
        SELECT id, scope_type AS "scopeType", scope_id AS "scopeId",
          kind, content, source_ref AS "sourceRef",
          source_actor AS "sourceActor", verification, confidence, pinned,
          created_at AS "createdAt", updated_at AS "updatedAt",
          last_verified_at AS "lastVerifiedAt",
          superseded_by AS "supersededBy", tombstoned_at AS "tombstonedAt"
        FROM agent_memory_items
        WHERE scope_type = ${scope.scopeType} AND scope_id = ${scope.scopeId}
          AND tombstoned_at IS NULL AND superseded_by IS NULL
          AND verification <> 'proposed'
        ORDER BY pinned DESC, updated_at DESC, id
        LIMIT ${limit}
      `;
    for (const row of rows) found.set(row.id, toEntry(row));
  }
  return [...found.values()];
});
