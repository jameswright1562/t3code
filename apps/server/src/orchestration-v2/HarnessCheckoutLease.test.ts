import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory } from "../persistence/Sqlite.ts";
import {
  acquireCheckoutLease,
  checkoutPathsOverlap,
  listActiveCheckoutLeases,
  normalizeCheckoutRealPath,
  releaseCheckoutLease,
} from "./HarnessCheckoutLease.ts";

const owner = (leaseId: string, threadId = "thread:a") => ({
  leaseId, threadId, projectId: "project:a", planId: "plan:a", stepId: "step:a",
});

it("normalizes realpaths conservatively and detects parent-child overlap", () => {
  assert.equal(normalizeCheckoutRealPath("/Projects/Repo/"), "/projects/repo");
  assert.equal(normalizeCheckoutRealPath("C:\\Repo\\work"), "c:/repo/work");
  assert.equal(checkoutPathsOverlap("/projects/repo", "/projects/repo/src"), true);
  assert.equal(checkoutPathsOverlap("/projects/repo", "/projects/repo2"), false);
  assert.throws(() => normalizeCheckoutRealPath("../../repo"), /absolute checkout/);
  assert.throws(() => normalizeCheckoutRealPath("/projects/../secret"), /Noncanonical/);
});

const layer = it.layer(layerMemory);
layer("persistent exclusive checkout leases", (it) => {
  it.effect("holds a checkout across requests, refuses aliases and cross-scope release", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const first = { ...owner("lease:a"), checkoutPath: "/private/project" };
      const acquired = yield* sql.withTransaction(acquireCheckoutLease(first));
      assert.equal(acquired.checkoutPath, "/private/project");
      const repeated = yield* sql.withTransaction(acquireCheckoutLease(first));
      assert.equal(repeated.leaseId, acquired.leaseId);
      const other = { ...owner("lease:b", "thread:b"), checkoutPath: "/private/project/src" };
      const blocked = yield* Effect.result(
        sql.withTransaction(acquireCheckoutLease(other)),
      );
      assert.equal(blocked._tag, "Failure");
      const stolen = yield* Effect.result(
        sql.withTransaction(releaseCheckoutLease(owner("lease:a", "thread:b"))),
      );
      assert.equal(stolen._tag, "Failure");
      assert.equal((yield* listActiveCheckoutLeases()).length, 1);
      yield* sql.withTransaction(releaseCheckoutLease(owner("lease:a")));
      assert.equal((yield* listActiveCheckoutLeases()).length, 0);
      const retried = yield* sql.withTransaction(acquireCheckoutLease(other));
      assert.equal(retried.leaseId, "lease:b");
    }),
  );
  it.effect("a forgotten running step cannot be acquired by a different owner after reload", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(acquireCheckoutLease({
        ...owner("lease:crash"), checkoutPath: "/private/crash",
      }));
      // A new request has no in-memory state. The persisted record is still live.
      const contender = yield* Effect.result(sql.withTransaction(acquireCheckoutLease({
        ...owner("lease:other", "thread:restart"),
        checkoutPath: "/private/crash",
      })));
      assert.equal(contender._tag, "Failure");
    }),
  );
});
