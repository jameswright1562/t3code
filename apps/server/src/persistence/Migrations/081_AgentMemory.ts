import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Phase-zero durable memory storage. Additive only: existing conversations,
 * events, provider sessions, plans and checkpoints are left untouched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    "CREATE TABLE IF NOT EXISTS agent_memory_items (" +
      "id TEXT PRIMARY KEY, " +
      "scope_type TEXT NOT NULL CHECK (scope_type IN ('global','workspace','project','thread','task')), " +
      "scope_id TEXT NOT NULL, " +
      "kind TEXT NOT NULL CHECK (kind IN ('fact','decision','preference','constraint','file_reference','failed_approach','open_question','procedure','outcome')), " +
      "content TEXT NOT NULL, " +
      "source_ref TEXT NOT NULL, " +
      "source_actor TEXT NOT NULL, " +
      "verification TEXT NOT NULL CHECK (verification IN ('proposed','verified','user_confirmed')), " +
      "confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), " +
      "pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)), " +
      "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, " +
      "last_verified_at TEXT, superseded_by TEXT, tombstoned_at TEXT, " +
      "schema_version INTEGER NOT NULL DEFAULT 1)",
  );

  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS idx_agent_memory_scope " +
      "ON agent_memory_items(scope_type, scope_id, tombstoned_at, kind, updated_at)",
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS idx_agent_memory_source ON agent_memory_items(source_ref)",
  );

  yield* sql.unsafe(
    "CREATE TABLE IF NOT EXISTS agent_memory_checkpoints (" +
      "id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, " +
      "task_id TEXT, sequence INTEGER NOT NULL CHECK (sequence >= 0), " +
      "checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)), " +
      "created_at TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, " +
      "UNIQUE(thread_id, sequence))",
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS idx_agent_memory_checkpoints_latest " +
      "ON agent_memory_checkpoints(thread_id, sequence DESC)",
  );

  yield* sql.unsafe(
    "CREATE TABLE IF NOT EXISTS agent_memory_events (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, " +
      "memory_id TEXT NOT NULL, operation TEXT NOT NULL, " +
      "payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), " +
      "occurred_at TEXT NOT NULL)",
  );
  yield* sql.unsafe(
    "CREATE INDEX IF NOT EXISTS idx_agent_memory_events_memory " +
      "ON agent_memory_events(memory_id, seq)",
  );
});
