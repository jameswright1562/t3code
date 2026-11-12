import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Port of upstream migration 82; fork migration IDs 81–85 are immutable. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_conversation_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, type, run_id)
    WHERE type NOT IN (
      'command_execution', 'reasoning', 'file_change', 'file_search', 'web_search', 'dynamic_tool'
    )
  `;
});
