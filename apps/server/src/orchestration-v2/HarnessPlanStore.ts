import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  type HarnessPlan,
  type HarnessStep,
  type HarnessStepDraft,
  type HarnessStepStatus,
  HarnessPlanValidationError,
  reviseHarnessSteps,
  transitionHarnessStep,
  validateHarnessSteps,
} from "./HarnessPlan.ts";
import {
  acquireCheckoutLease,
  normalizeCheckoutRealPath,
  releaseCheckoutLease,
} from "./HarnessCheckoutLease.ts";

interface PlanRow {
  readonly planId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly stepsJson: string;
  readonly updatedAt: string;
}

const fail = (detail: string) => new HarnessPlanValidationError({ detail });
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const safe = <T>(f: () => T) => Effect.try({ try: f, catch: (error) => fail(String(error)) });

const parsePlan = Effect.fn("HarnessPlanStore.parse")(function* (row: PlanRow) {
  const steps = yield* safe(() => JSON.parse(row.stepsJson) as HarnessStep[]);
  yield* safe(() => validateHarnessSteps(steps));
  return {
    schemaVersion: 1 as const,
    planId: row.planId,
    projectId: row.projectId,
    threadId: row.threadId,
    revision: row.revision,
    steps,
    updatedAt: row.updatedAt,
  } satisfies HarnessPlan;
});

const readRow = Effect.fn("HarnessPlanStore.readRow")(function* (input: {
  readonly projectId: string;
  readonly threadId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<PlanRow>`
    SELECT plan_id AS "planId", project_id AS "projectId",
      thread_id AS "threadId", revision, steps_json AS "stepsJson",
      updated_at AS "updatedAt"
    FROM harness_thread_plans
    WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId}
  `;
  return rows[0] ?? null;
});

export const readHarnessPlan = Effect.fn("HarnessPlanStore.read")(function* (input: {
  readonly projectId: string;
  readonly threadId: string;
}) {
  const row = yield* readRow(input);
  return row ? yield* parsePlan(row) : null;
});

export const createHarnessPlan = Effect.fn("HarnessPlanStore.create")(function* (input: {
  readonly planId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly steps: readonly HarnessStepDraft[];
  /** Must come from the host filesystem realpath, never an agent/UI claim. */
  readonly trustedCheckoutPath: string;
  readonly updatedAt?: string;
}) {
  if (
    ![input.planId, input.projectId, input.threadId].every(
      (id) => id.trim().length > 0 && id.length <= 128,
    )
  )
    return yield* fail("Invalid plan or scope identity");
  const checkoutPath = yield* safe(() =>
    normalizeCheckoutRealPath(input.trustedCheckoutPath),
  );
  const steps: HarnessStep[] = input.steps.map((step) => ({
    ...step,
    checkoutKey: checkoutPath,
    status: "pending" as const,
    artifactRefs: [],
  }));
  yield* safe(() => validateHarnessSteps(steps));
  const sql = yield* SqlClient.SqlClient;
  const stepsJson = yield* encodeJson(steps);
  const now = input.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* readRow(input);
      if (existing) {
        const plan = yield* parsePlan(existing);
        const priorStepsJson = yield* encodeJson(plan.steps);
        if (plan.planId !== input.planId || priorStepsJson !== stepsJson) {
          return yield* fail("Plan already exists with different content");
        }
        return plan;
      }
      yield* sql`INSERT INTO harness_thread_plans
        (thread_id, project_id, plan_id, revision, steps_json, updated_at)
        VALUES (${input.threadId}, ${input.projectId}, ${input.planId}, 1,
          ${stepsJson}, ${now})`;
      return {
        schemaVersion: 1 as const,
        planId: input.planId,
        projectId: input.projectId,
        threadId: input.threadId,
        revision: 1,
        steps,
        updatedAt: now,
      } satisfies HarnessPlan;
    }),
  );
});

export const mutateHarnessPlan = Effect.fn("HarnessPlanStore.mutate")(function* (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly expectedRevision: number;
  /** Must come from the host filesystem realpath, never an agent/UI claim. */
  readonly trustedCheckoutPath: string;
  readonly change:
    | { readonly type: "edit"; readonly steps: readonly HarnessStepDraft[] }
    | {
        readonly type: "transition";
        readonly stepId: string;
        readonly next: HarnessStepStatus;
        readonly allowParallel?: boolean | undefined;
      };
  readonly updatedAt?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const previous = yield* readHarnessPlan(input);
      if (!previous) return yield* fail("Plan not found in selected project and thread");
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        previous.revision !== input.expectedRevision
      )
        return yield* fail("Stale plan revision; reload before modifying");
      const checkoutPath = yield* safe(() =>
        normalizeCheckoutRealPath(input.trustedCheckoutPath),
      );
      const change =
        input.change.type === "edit"
          ? {
              type: "edit" as const,
              steps: input.change.steps.map((step) => ({
                ...step,
                checkoutKey: checkoutPath,
              })),
            }
          : input.change;
      const steps = yield* safe(() =>
        change.type === "edit"
          ? reviseHarnessSteps(previous.steps, change.steps)
          : transitionHarnessStep(previous.steps, change.stepId, change.next, {
              allowParallel: change.allowParallel ?? false,
            }),
      );
      if (change.type === "transition" && change.next === "running") {
        const step = previous.steps.find((candidate) => candidate.id === change.stepId);
        if (!step || step.checkoutKey !== checkoutPath) {
          return yield* fail(
            "Saved checkout identity is stale; revise pending plan steps before starting.",
          );
        }
        yield* acquireCheckoutLease({
          leaseId: previous.planId + ":" + change.stepId,
          checkoutPath,
          projectId: previous.projectId,
          threadId: previous.threadId,
          planId: previous.planId,
          stepId: change.stepId,
        });
      }
      if (
        change.type === "transition" &&
        (change.next === "completed" || change.next === "failed" ||
          change.next === "cancelled") &&
        previous.steps.some(
          (step) => step.id === change.stepId && step.status === "running",
        )
      ) {
        yield* releaseCheckoutLease({
          leaseId: previous.planId + ":" + change.stepId,
          projectId: previous.projectId,
          threadId: previous.threadId,
          planId: previous.planId,
          stepId: change.stepId,
        });
      }
      const now = input.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
      const stepsJson = yield* encodeJson(steps);
      const revision = previous.revision + 1;
      const updated = yield* sql`UPDATE harness_thread_plans
        SET revision = ${revision}, steps_json = ${stepsJson},
          updated_at = ${now}
        WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId}
          AND revision = ${input.expectedRevision}`;
      // SQLite transactions serialize writers; the revision check also
      // protects callers retrying a stale UI action after a successful write.
      void updated;
      return { ...previous, steps, revision, updatedAt: now } satisfies HarnessPlan;
    }),
  );
});
