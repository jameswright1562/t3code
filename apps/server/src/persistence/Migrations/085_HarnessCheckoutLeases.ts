import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * These are persistent, manual-recovery-required plan leases. Do not expire
 * them automatically: a crashed T3 process may have left a native child alive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS harness_checkout_leases (
      lease_id TEXT PRIMARY KEY,
      checkout_path TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_active_checkout_lease
    ON harness_checkout_leases(checkout_path)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_harness_active_checkout_lease_thread
    ON harness_checkout_leases(project_id, thread_id)
  `;
});
