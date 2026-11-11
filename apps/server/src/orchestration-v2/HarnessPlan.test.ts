import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layerMemory } from "../persistence/Sqlite.ts";
import {
  readyHarnessSteps,
  transitionHarnessStep,
  validateHarnessSteps,
  type HarnessStepDraft,
} from "./HarnessPlan.ts";
import { createHarnessPlan, mutateHarnessPlan, readHarnessPlan } from "./HarnessPlanStore.ts";

const draft = (
  id: string,
  dependsOn: readonly string[] = [],
  checkoutKey = "repo:main",
): HarnessStepDraft => ({
  id,
  title: "Step " + id,
  dependsOn,
  checkoutKey,
  provider: "codex",
  acceptanceCriteria: "Tests pass",
});

it("rejects cycles and checkout conflicts without invoking agents", () => {
  const steps = [
    { ...draft("a", ["b"]), status: "pending" as const, artifactRefs: [] },
    { ...draft("b", ["a"]), status: "pending" as const, artifactRefs: [] },
  ];
  assert.throws(() => validateHarnessSteps(steps), /Cyclic/);
  const independent = [
    { ...draft("a"), status: "pending" as const, artifactRefs: [] },
    { ...draft("b"), status: "pending" as const, artifactRefs: [] },
  ];
  assert.deepStrictEqual(
    readyHarnessSteps(independent).map((x) => x.id),
    ["a"],
  );
  const running = transitionHarnessStep(independent, "a", "running");
  assert.deepStrictEqual(readyHarnessSteps(running, { allowParallel: true, maxParallel: 4 }), []);
  assert.throws(
    () => transitionHarnessStep(running, "b", "running", { allowParallel: true }),
    /checkout concurrency/,
  );
});

const layer = it.layer(layerMemory);
layer("persistent harness plans", (it) => {
  it.effect("enforces dependency order, optimistic revisions, and project isolation", () =>
    Effect.gen(function* () {
      const scope = { projectId: "harness-project-a", threadId: "harness-thread-a" };
      const plan = yield* createHarnessPlan({
        ...scope,
        planId: "plan:1",
        steps: [draft("build"), draft("verify", ["build"])],
      });
      assert.equal(plan.revision, 1);
      assert.deepStrictEqual(
        (yield* createHarnessPlan({
          ...scope,
          planId: "plan:1",
          steps: [draft("build"), draft("verify", ["build"])],
        })).revision,
        1,
      );
      assert.equal(
        yield* readHarnessPlan({
          ...scope,
          projectId: "harness-project-b",
        }),
        null,
      );
      const blocked = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 1,
          change: { type: "transition", stepId: "verify", next: "running" },
        }),
      );
      assert.equal(blocked._tag, "Failure");
      const started = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 1,
        change: { type: "transition", stepId: "build", next: "running" },
      });
      assert.equal(started.revision, 2);
      const stale = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 1,
          change: { type: "transition", stepId: "build", next: "completed" },
        }),
      );
      assert.equal(stale._tag, "Failure");
      const completed = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 2,
        change: { type: "transition", stepId: "build", next: "completed" },
      });
      assert.deepStrictEqual(
        readyHarnessSteps(completed.steps).map((x) => x.id),
        ["verify"],
      );
      assert.deepStrictEqual((yield* readHarnessPlan(scope))?.steps, completed.steps);
    }),
  );
  it.effect("cannot erase completed steps or create overlapping writers", () =>
    Effect.gen(function* () {
      const scope = { projectId: "harness-project-c", threadId: "harness-thread-c" };
      yield* createHarnessPlan({
        ...scope,
        planId: "plan:2",
        steps: [draft("a"), draft("b", [], "repo:isolated-b")],
      });
      const a = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 1,
        change: { type: "transition", stepId: "a", next: "running" },
      });
      const b = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 2,
        change: { type: "transition", stepId: "b", next: "running", allowParallel: true },
      });
      assert.equal(b.steps.filter((s) => s.status === "running").length, 2);
      const erased = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 3,
          change: { type: "edit", steps: [draft("b", [], "repo:isolated-b")] },
        }),
      );
      assert.equal(erased._tag, "Failure");
      assert.equal(a.revision, 2);
    }),
  );
});
