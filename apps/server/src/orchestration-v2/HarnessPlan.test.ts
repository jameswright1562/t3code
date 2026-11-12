import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { layerMemory } from "../persistence/Sqlite.ts";
import {
  attachHarnessDispatch,
  checkpointHarnessPlan,
  matchingActiveHarnessRun,
  queuedHarnessRecoveryRuns,
  readyHarnessSteps,
  renderHarnessStepPrompt,
  terminalHarnessStepStatus,
  transitionHarnessStep,
  validateHarnessSteps,
  type HarnessStepDraft,
} from "./HarnessPlan.ts";
import {
  createHarnessPlan,
  mutateHarnessPlan,
  readHarnessPlan,
  settleNativeHarnessStep,
} from "./HarnessPlanStore.ts";

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

it("checkpoints a plan revision with bounded eligible next steps and no execution", () => {
  const steps = [
    { ...draft("implement"), status: "pending" as const, artifactRefs: [] },
    { ...draft("verify", ["implement"]), status: "pending" as const, artifactRefs: [] },
  ];
  const plan = {
    schemaVersion: 1 as const,
    planId: "plan:checkpoint",
    projectId: "project:checkpoint",
    threadId: "thread:checkpoint",
    revision: 7,
    steps,
    updatedAt: "2026-11-12T00:00:00Z",
  };
  const original = checkpointHarnessPlan(plan);
  assert.equal(original.planId, plan.planId);
  assert.equal(original.planRevision, 7);
  assert.deepStrictEqual(original.pendingStepIds, ["implement", "verify"]);
  assert.deepStrictEqual(original.activeStepIds, []);
  assert.deepStrictEqual(original.nextActions, ["Step implement"]);

  const started = checkpointHarnessPlan({
    ...plan,
    revision: 8,
    steps: transitionHarnessStep(steps, "implement", "running"),
  });
  assert.deepStrictEqual(started.activeStepIds, ["implement"]);
  assert.deepStrictEqual(started.nextActions, []);
  const finished = checkpointHarnessPlan({
    ...plan,
    revision: 9,
    steps: transitionHarnessStep(
      transitionHarnessStep(steps, "implement", "running"),
      "implement",
      "completed",
    ),
  });
  assert.deepStrictEqual(finished.completedStepIds, ["implement"]);
  assert.deepStrictEqual(finished.nextActions, ["Step verify"]);
});

it("maps only verified terminal native run states to plan settlement", () => {
  assert.equal(terminalHarnessStepStatus("completed"), "completed");
  assert.equal(terminalHarnessStepStatus("failed"), "failed");
  assert.equal(terminalHarnessStepStatus("cancelled"), "cancelled");
  assert.equal(terminalHarnessStepStatus("interrupted"), null);
  for (const active of ["starting", "queued", "running", "waiting", "preparing"]) {
    assert.equal(terminalHarnessStepStatus(active), null);
  }
});

it("holds only unheld queued harness messages after restart", () => {
  const runs = [
    { id: "harness-queued", status: "queued", userMessageId: "harness:one", queueHeld: false },
    { id: "already-held", status: "queued", userMessageId: "harness:two", queueHeld: true },
    { id: "ordinary", status: "queued", userMessageId: "message:normal", queueHeld: false },
    { id: "running", status: "running", userMessageId: "harness:three", queueHeld: false },
  ];
  assert.deepStrictEqual(
    queuedHarnessRecoveryRuns(runs).map((run) => run.id),
    ["harness-queued"],
  );
});

it("stops only the exact active run for the same durable plan and thread", () => {
  const run = {
    id: "run:approved",
    userMessageId: "harness:msg",
    sourcePlanRef: { planId: "plan:approved", threadId: "thread:approved" },
    status: "running",
  };
  const input = {
    planId: "plan:approved",
    threadId: "thread:approved",
    dispatchMessageId: "harness:msg",
  };
  assert.deepStrictEqual(matchingActiveHarnessRun([run], input), run);
  assert.equal(matchingActiveHarnessRun([run], { ...input, planId: "plan:other" }), undefined);
  assert.equal(matchingActiveHarnessRun([run], { ...input, threadId: "thread:other" }), undefined);
  assert.equal(
    matchingActiveHarnessRun([run], { ...input, dispatchMessageId: "harness:other" }),
    undefined,
  );
  assert.equal(matchingActiveHarnessRun([{ ...run, status: "completed" }], input), undefined);
  assert.equal(matchingActiveHarnessRun([{ ...run, sourcePlanRef: undefined }], input), undefined);
});

it("records a native dispatch identity only when the step is ready", () => {
  const steps = [
    { ...draft("compile"), status: "pending" as const, artifactRefs: [] },
    { ...draft("test", ["compile"]), status: "pending" as const, artifactRefs: [] },
  ];
  assert.throws(() => attachHarnessDispatch(steps, "test", "message:early"), /Dependencies/);
  const dispatched = attachHarnessDispatch(steps, "compile", "message:compile");
  assert.equal(dispatched[0]?.status, "running");
  assert.equal(dispatched[0]?.dispatchMessageId, "message:compile");
  assert.match(renderHarnessStepPrompt(dispatched[0]!), /Do not start later plan steps/);
  assert.throws(() => attachHarnessDispatch(dispatched, "compile", "message:duplicate"), /Invalid/);
});

const layer = it.layer(layerMemory);
layer("persistent harness plans", (it) => {
  it.effect("enforces dependency order, optimistic revisions, and project isolation", () =>
    Effect.gen(function* () {
      const scope = {
        projectId: "harness-project-a",
        threadId: "harness-thread-a",
        trustedCheckoutPath: "/work/project-a",
      };
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
  it.effect("persists editable DAG edges but refuses cycles and stale writes", () =>
    Effect.gen(function* () {
      const scope = {
        projectId: "harness-project-dag",
        threadId: "harness-thread-dag",
        trustedCheckoutPath: "/work/project-dag",
      };
      yield* createHarnessPlan({
        ...scope,
        planId: "plan:dag",
        steps: [draft("prepare"), draft("test", ["prepare"]), draft("review", ["test"])],
      });
      const parallelReview = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 1,
        change: {
          type: "edit",
          steps: [draft("prepare"), draft("test", ["prepare"]), draft("review", ["prepare"])],
        },
      });
      assert.equal(parallelReview.revision, 2);
      assert.deepStrictEqual(parallelReview.steps[2]?.dependsOn, ["prepare"]);
      const cycle = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 2,
          change: {
            type: "edit",
            steps: [
              draft("prepare", ["review"]),
              draft("test", ["prepare"]),
              draft("review", ["prepare"]),
            ],
          },
        }),
      );
      assert.equal(cycle._tag, "Failure");
      assert.deepStrictEqual((yield* readHarnessPlan(scope))?.steps, parallelReview.steps);
    }),
  );
  it.effect("cannot erase completed steps or create overlapping writers", () =>
    Effect.gen(function* () {
      const scope = {
        projectId: "harness-project-c",
        threadId: "harness-thread-c",
        trustedCheckoutPath: "/work/project-c",
      };
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
      const blocked = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 2,
          change: { type: "transition", stepId: "b", next: "running", allowParallel: true },
        }),
      );
      assert.equal(blocked._tag, "Failure");
      const erased = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 2,
          change: { type: "edit", steps: [draft("b", [], "repo:isolated-b")] },
        }),
      );
      assert.equal(erased._tag, "Failure");
      assert.equal(a.revision, 2);
    }),
  );
  it.effect("stores per-step native provider choices and protects active assignments", () =>
    Effect.gen(function* () {
      const scope = {
        projectId: "harness-project-routing",
        threadId: "harness-thread-routing",
        trustedCheckoutPath: "/work/project-routing",
      };
      yield* createHarnessPlan({
        ...scope,
        planId: "plan:routing",
        steps: [
          { ...draft("implement"), provider: "claudeAgent", model: "sonnet-5.5" },
          { ...draft("review", ["implement"]), provider: "cursor" },
        ],
      });
      const original = yield* readHarnessPlan(scope);
      assert.equal(original?.steps[0]?.provider, "claudeAgent");
      assert.equal(original?.steps[0]?.model, "sonnet-5.5");
      assert.equal(original?.steps[1]?.provider, "cursor");

      const edited = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 1,
        change: {
          type: "edit",
          steps: [
            { ...draft("implement"), provider: "opencode", model: "example/custom-model" },
            { ...draft("review", ["implement"]), provider: "codex" },
          ],
        },
      });
      assert.equal(edited.steps[0]?.provider, "opencode");
      assert.equal(edited.steps[0]?.model, "example/custom-model");
      assert.equal(edited.steps[1]?.provider, "codex");

      yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 2,
        change: { type: "transition", stepId: "implement", next: "running" },
      });
      const blocked = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 3,
          change: {
            type: "edit",
            steps: [
              { ...draft("implement"), provider: "claudeAgent", model: "sonnet-5.5" },
              { ...draft("review", ["implement"]), provider: "codex" },
            ],
          },
        }),
      );
      assert.equal(blocked._tag, "Failure");
      assert.equal((yield* readHarnessPlan(scope))?.steps[0]?.provider, "opencode");
    }),
  );
  it.effect("native dispatch intent holds its lease until a matching terminal run", () =>
    Effect.gen(function* () {
      const scope = {
        projectId: "native-dispatch-project",
        threadId: "native-dispatch-thread",
        trustedCheckoutPath: "/work/native-dispatch",
      };
      yield* createHarnessPlan({
        ...scope,
        planId: "plan-native",
        steps: [draft("implement"), draft("test", ["implement"])],
      });
      const claimed = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 1,
        change: { type: "dispatch", stepId: "implement", messageId: "message:native-start" },
      });
      assert.equal(claimed.steps[0]?.status, "running");
      assert.equal(claimed.steps[0]?.dispatchMessageId, "message:native-start");
      const duplicate = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 1,
          change: { type: "dispatch", stepId: "implement", messageId: "message:duplicate" },
        }),
      );
      assert.equal(duplicate._tag, "Failure");

      // The existing manual board cannot claim a provider finished or release its lease.
      const forced = yield* Effect.result(
        mutateHarnessPlan({
          ...scope,
          expectedRevision: 2,
          change: { type: "transition", stepId: "implement", next: "completed" },
        }),
      );
      assert.equal(forced._tag, "Failure");
      assert.equal(
        yield* settleNativeHarnessStep({
          ...scope,
          planId: "plan-native",
          messageId: "message:wrong",
          next: "completed",
        }),
        false,
      );
      assert.equal(
        yield* settleNativeHarnessStep({
          ...scope,
          planId: "plan-native",
          messageId: "message:native-start",
          next: "completed",
        }),
        true,
      );
      assert.equal(
        yield* settleNativeHarnessStep({
          ...scope,
          planId: "plan-native",
          messageId: "message:native-start",
          next: "completed",
        }),
        false,
      );
      const completed = yield* readHarnessPlan(scope);
      assert.equal(completed?.steps[0]?.status, "completed");
      assert.equal(completed?.steps[1]?.status, "pending");
      const after = yield* mutateHarnessPlan({
        ...scope,
        expectedRevision: 3,
        change: { type: "dispatch", stepId: "test", messageId: "message:native-test" },
      });
      assert.equal(after.steps[1]?.status, "running");
    }),
  );
  it.effect("blocks plan writes across different threads in one canonical checkout", () =>
    Effect.gen(function* () {
      const a = {
        projectId: "shared-project",
        threadId: "thread-one",
        trustedCheckoutPath: "/workspace/shared",
      };
      const b = {
        projectId: "shared-project",
        threadId: "thread-two",
        trustedCheckoutPath: "/workspace/shared",
      };
      yield* createHarnessPlan({ ...a, planId: "plan-one", steps: [draft("a")] });
      yield* createHarnessPlan({ ...b, planId: "plan-two", steps: [draft("b")] });
      yield* mutateHarnessPlan({
        ...a,
        expectedRevision: 1,
        change: { type: "transition", stepId: "a", next: "running" },
      });
      const blocked = yield* Effect.result(
        mutateHarnessPlan({
          ...b,
          expectedRevision: 1,
          change: { type: "transition", stepId: "b", next: "running" },
        }),
      );
      assert.equal(blocked._tag, "Failure");
      yield* mutateHarnessPlan({
        ...a,
        expectedRevision: 2,
        change: { type: "transition", stepId: "a", next: "completed" },
      });
      const resumed = yield* mutateHarnessPlan({
        ...b,
        expectedRevision: 1,
        change: { type: "transition", stepId: "b", next: "running" },
      });
      assert.equal(resumed.steps[0]?.status, "running");
    }),
  );
});
