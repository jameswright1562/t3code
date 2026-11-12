/**
 * Host-owned, deterministic scheduling policy for user-started multi-step plans.
 * This module chooses eligible work; it never opens a provider session itself.
 * Checkout identity must be resolved from the trusted host, not an agent label.
 */
import * as Schema from "effect/Schema";

export type HarnessStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface HarnessStepDraft {
  readonly id: string;
  readonly title: string;
  readonly dependsOn: readonly string[];
  readonly checkoutKey: string;
  readonly provider: string;
  readonly model?: string | null | undefined;
  readonly acceptanceCriteria: string;
}

export interface HarnessStep extends HarnessStepDraft {
  readonly status: HarnessStepStatus;
  readonly artifactRefs: readonly string[];
  /** Host-generated message identity; an uncertain native dispatch is never replayed on launch. */
  readonly dispatchMessageId?: string | undefined;
}

export interface HarnessPlan {
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly revision: number;
  readonly steps: readonly HarnessStep[];
  readonly updatedAt: string;
}

export class HarnessPlanValidationError extends Schema.TaggedError<HarnessPlanValidationError>()(
  "HarnessPlanValidationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (message: string): never => {
  throw new HarnessPlanValidationError({ detail: message });
};

const isId = (value: string) => value.trim().length > 0 && value.length <= 128;
const ensure = (value: boolean, message: string): void => {
  if (!value) fail(message);
};

/** Validate all edges before saving. Cycles and dangling references fail closed. */
export function validateHarnessSteps(steps: readonly HarnessStep[]): void {
  ensure(steps.length > 0 && steps.length <= 100, "A plan requires 1–100 steps");
  const byId = new Map<string, HarnessStep>();
  for (const step of steps) {
    ensure(isId(step.id) && !byId.has(step.id), "Step IDs must be unique and non-empty");
    ensure(step.title.trim().length > 0 && step.title.length <= 500, "Invalid step title");
    ensure(
      step.checkoutKey.trim().length > 0 && step.checkoutKey.length <= 4096,
      "Every step needs a host-resolved checkout key",
    );
    ensure(isId(step.provider), "Every step needs a provider");
    ensure(step.acceptanceCriteria.length <= 10000, "Acceptance criteria too long");
    ensure(step.dependsOn.length <= 100, "Too many step dependencies");
    ensure(step.artifactRefs.length <= 200, "Too many step artifacts");
    ensure(
      step.dispatchMessageId === undefined ||
        (isId(step.dispatchMessageId) && step.status !== "pending"),
      "Invalid or stale native dispatch identity",
    );
    ensure(
      ["pending", "running", "completed", "failed", "cancelled"].includes(step.status),
      "Invalid step status",
    );
    byId.set(step.id, step);
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const walk = (id: string): void => {
    ensure(!visiting.has(id), "Cyclic plan dependencies are not allowed");
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step)
      throw new HarnessPlanValidationError({ detail: "Dependency points to a missing step" });
    visiting.add(id);
    const deps = new Set<string>();
    for (const dep of step.dependsOn) {
      ensure(dep !== id && !deps.has(dep), "Invalid or duplicate dependency");
      deps.add(dep);
      walk(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) walk(step.id);
  for (const step of steps) {
    if (step.status !== "running" && step.status !== "completed") continue;
    ensure(
      step.dependsOn.every((id) => byId.get(id)?.status === "completed"),
      "Running or completed steps cannot have unfinished dependencies",
    );
  }
  const occupied = new Set<string>();
  for (const step of steps.filter((step) => step.status === "running")) {
    ensure(!occupied.has(step.checkoutKey), "Concurrent writers share a checkout");
    occupied.add(step.checkoutKey);
  }
}

/**
 * Default to sequential execution. Parallel selection is explicit, chooses at
 * most one new writer per checkout, and never treats failed deps as complete.
 */
export function readyHarnessSteps(
  steps: readonly HarnessStep[],
  options: { readonly allowParallel?: boolean; readonly maxParallel?: number } = {},
): readonly HarnessStep[] {
  validateHarnessSteps(steps);
  const running = steps.filter((step) => step.status === "running");
  if (running.length && options.allowParallel !== true) return [];
  const capacity =
    options.allowParallel === true
      ? Math.min(4, Math.max(0, Math.floor(options.maxParallel ?? 1))) - running.length
      : 1;
  if (capacity <= 0) return [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  const occupied = new Set(running.map((step) => step.checkoutKey));
  const ready: HarnessStep[] = [];
  for (const step of steps) {
    if (ready.length >= capacity) break;
    if (step.status !== "pending" || occupied.has(step.checkoutKey)) continue;
    if (!step.dependsOn.every((id) => byId.get(id)?.status === "completed")) continue;
    ready.push(step);
    occupied.add(step.checkoutKey);
  }
  return ready;
}

/** Immutable, guarded state transition; cancellation requires host acknowledgement. */
export function transitionHarnessStep(
  steps: readonly HarnessStep[],
  stepId: string,
  next: HarnessStepStatus,
  options: { readonly allowParallel?: boolean } = {},
): readonly HarnessStep[] {
  const step = steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new HarnessPlanValidationError({ detail: "Step does not exist in this plan" });
  const from = step.status;
  const allowed =
    (from === "pending" && (next === "running" || next === "cancelled")) ||
    (from === "running" && (next === "completed" || next === "failed" || next === "cancelled")) ||
    (from === "failed" && next === "pending");
  ensure(allowed, "Invalid plan step state transition");
  if (next === "running") {
    ensure(
      readyHarnessSteps(steps, {
        allowParallel: options.allowParallel ?? false,
        maxParallel: 4,
      }).some((candidate) => candidate.id === stepId),
      "Dependencies or checkout concurrency prevent starting this step",
    );
  }
  const updated = steps.map((candidate) =>
    candidate.id === stepId
      ? {
          ...candidate,
          status: next,
          ...(next === "pending" ? { dispatchMessageId: undefined } : {}),
        }
      : candidate,
  );
  validateHarnessSteps(updated);
  return updated;
}

/**
 * A native dispatch identity is recorded in the same SQL transaction as
 * the plan's running transition and checkout lease. Never independently
 * replay a command for a running step after restart.
 */
export function attachHarnessDispatch(
  steps: readonly HarnessStep[],
  stepId: string,
  messageId: string,
): readonly HarnessStep[] {
  if (!isId(messageId)) fail("Invalid native dispatch message identity");
  const updated = transitionHarnessStep(steps, stepId, "running");
  return updated.map((step) =>
    step.id === stepId ? { ...step, dispatchMessageId: messageId } : step,
  );
}

/** Small, deterministic prompt: no planning/model calls are spent on the control plane. */
export function renderHarnessStepPrompt(step: HarnessStep): string {
  return [
    "Execute this single user-approved coding plan step. Do not start later plan steps.",
    "Step: " + step.title,
    "Acceptance criteria: " + (step.acceptanceCriteria || "Report the changed files and tests."),
    "At completion, report evidence and any remaining issues. Do not claim unrun tests passed.",
  ].join("\n\n");
}

/** Preserve active/completed work across user edits; a stale plan cannot erase it. */
export function reviseHarnessSteps(
  current: readonly HarnessStep[],
  drafts: readonly HarnessStepDraft[],
): readonly HarnessStep[] {
  const original = new Map(current.map((step) => [step.id, step]));
  const updated = drafts.map((draft) => {
    const existing = original.get(draft.id);
    if (existing && existing.status !== "pending" && existing.status !== "failed") {
      const {
        status: _status,
        artifactRefs: _artifacts,
        dispatchMessageId: _dispatchMessageId,
        ...prior
      } = existing;
      ensure(
        JSON.stringify(prior) === JSON.stringify(draft),
        "An active or completed step cannot be edited",
      );
    }
    return {
      ...draft,
      status: existing?.status ?? "pending",
      artifactRefs: existing?.artifactRefs ?? [],
      ...(existing?.dispatchMessageId === undefined
        ? {}
        : { dispatchMessageId: existing.dispatchMessageId }),
    } satisfies HarnessStep;
  });
  for (const step of current) {
    if (step.status !== "pending" && step.status !== "failed") {
      ensure(
        updated.some((candidate) => candidate.id === step.id),
        "An active or completed step cannot be deleted",
      );
    }
  }
  validateHarnessSteps(updated);
  return updated;
}

/**
 * Source-backed, bounded plan state for a durable context checkpoint.
 * These fields are evidence of the saved plan revision, not approval to
 * resume execution or retry a native provider's external side effects.
 */
export function checkpointHarnessPlan(plan: HarnessPlan): {
  readonly planId: string;
  readonly planRevision: number;
  readonly completedStepIds: readonly string[];
  readonly pendingStepIds: readonly string[];
  readonly activeStepIds: readonly string[];
  readonly nextActions: readonly string[];
} {
  validateHarnessSteps(plan.steps);
  const completedStepIds: string[] = [];
  const pendingStepIds: string[] = [];
  const activeStepIds: string[] = [];
  for (const step of plan.steps) {
    if (step.status === "completed") completedStepIds.push(step.id);
    if (step.status === "pending") pendingStepIds.push(step.id);
    if (step.status === "running") activeStepIds.push(step.id);
  }
  return {
    planId: plan.planId,
    planRevision: plan.revision,
    completedStepIds,
    pendingStepIds,
    activeStepIds,
    // Include only work actually eligible under the manual, sequential policy.
    // Pending steps with failed dependencies are not next actions.
    nextActions: readyHarnessSteps(plan.steps)
      .slice(0, 5)
      .map((step) => step.title.slice(0, 240)),
  };
}
