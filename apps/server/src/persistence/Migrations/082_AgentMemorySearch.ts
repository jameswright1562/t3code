import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Optional FTS5 trigram index over approved, live project/thread memory.
 * Agent proposals, superseded revisions and tombstones are never indexed.
 * Old macOS SQLite builds may lack the tokenizer; the read path has a
 * bounded, exact-scope SQL fallback. Other migration errors must propagate.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = yield* sql`
    CREATE VIRTUAL TABLE agent_memory_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning(
          "Agent memory FTS5 index unavailable; scoped search will use fallback.",
          cause,
        ).pipe(Effect.as(false)),
    ),
  );
  if (!created) return;

  yield* sql.unsafe(`
    CREATE TRIGGER agent_memory_search_insert AFTER INSERT ON agent_memory_items
    WHEN new.verification <> 'proposed'
      AND new.tombstoned_at IS NULL AND new.superseded_by IS NULL
    BEGIN
      INSERT INTO agent_memory_search(rowid, text)
      VALUES (new.rowid, new.content || ' ' || new.source_ref);
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER agent_memory_search_update
    AFTER UPDATE OF content, source_ref, verification, tombstoned_at, superseded_by
    ON agent_memory_items
    BEGIN
      DELETE FROM agent_memory_search WHERE rowid = old.rowid;
      INSERT INTO agent_memory_search(rowid, text)
      SELECT new.rowid, new.content || ' ' || new.source_ref
      WHERE new.verification <> 'proposed'
        AND new.tombstoned_at IS NULL AND new.superseded_by IS NULL;
    END
  `);
  yield* sql.unsafe(`
    CREATE TRIGGER agent_memory_search_delete AFTER DELETE ON agent_memory_items
    BEGIN
      DELETE FROM agent_memory_search WHERE rowid = old.rowid;
    END
  `);
  yield* sql`
    INSERT INTO agent_memory_search(rowid, text)
    SELECT rowid, content || ' ' || source_ref FROM agent_memory_items
    WHERE verification <> 'proposed'
      AND tombstoned_at IS NULL AND superseded_by IS NULL
  `;
});
