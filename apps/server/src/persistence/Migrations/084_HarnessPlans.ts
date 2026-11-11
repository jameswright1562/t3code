import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Persist one user-authored plan per canonical thread with optimistic revision. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS harness_thread_plans (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      plan_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_harness_thread_plans_project
    ON harness_thread_plans(project_id, updated_at)`;
});
