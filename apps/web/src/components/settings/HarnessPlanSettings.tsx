import { useState } from "react";
import type { HarnessPlanStepDraft } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const PLAN_PROVIDERS = [
  { id: "codex", label: "Codex" },
  { id: "claudeAgent", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "opencode", label: "OpenCode / custom models" },
] as const;

/**
 * The plan board edits persisted state but does NOT invoke providers or
 * automatically execute steps. The execution scheduler is a separate gate.
 */
export function HarnessPlanSettings() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  const [threadId, setThreadId] = useState("");
  const [draft, setDraft] = useState("");
  const [newProvider, setNewProvider] = useState("codex");
  const [newModel, setNewModel] = useState("");
  const [providerOverrides, setProviderOverrides] = useState<Record<string, string>>({});
  const [modelOverrides, setModelOverrides] = useState<Record<string, string>>({});
  const [dependencyOverrides, setDependencyOverrides] = useState<Record<string, string[]>>({});
  const [criteriaOverrides, setCriteriaOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const scope =
    environmentId !== null && projectId !== null && threadId.trim()
      ? { environmentId, input: { projectId, threadId: threadId.trim() } }
      : null;
  const plan = useEnvironmentQuery(scope === null ? null : serverEnvironment.harnessPlan(scope));
  const leases = useEnvironmentQuery(
    scope === null ? null : serverEnvironment.harnessCheckoutLeases(scope),
  );
  const create = useAtomCommand(serverEnvironment.harnessCreatePlan);
  const change = useAtomCommand(serverEnvironment.harnessMutatePlan);
  const dispatch = useAtomCommand(serverEnvironment.harnessDispatchPlanStep);
  const interrupt = useAtomCommand(serverEnvironment.harnessInterruptPlanStep);
  const lines = draft
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const current = plan.data ?? null;
  const availableProviders = [
    ...PLAN_PROVIDERS,
    ...Object.keys(target?.settings?.providerInstances ?? {})
      .filter((providerId) => !PLAN_PROVIDERS.some((known) => known.id === providerId))
      .map((providerId) => ({ id: providerId, label: providerId })),
  ];
  const editLines = lines.length > 0 ? lines : (current?.steps.map((step) => step.title) ?? []);

  async function createPlan() {
    if (!scope || !projectId || lines.length === 0 || lines.length > 100 || busy) return;
    const steps: HarnessPlanStepDraft[] = lines.map((title) => ({
      id: randomUUID(),
      title,
      dependsOn: [],
      checkoutKey: `project:${projectId}`,
      provider: newProvider,
      ...(newModel.trim() ? { model: newModel.trim() } : {}),
      acceptanceCriteria: "User verifies this step is complete",
    }));
    for (let index = 1; index < steps.length; index++) {
      steps[index] = { ...steps[index]!, dependsOn: [steps[index - 1]!.id] };
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await create({
        ...scope,
        input: { ...scope.input, planId: randomUUID(), steps },
      });
      if (result._tag !== "Success") {
        setMessage("Plan could not be created. Check the project, thread and permissions.");
      } else {
        setDraft("");
        setMessage("Plan created. Steps are not automatically executed.");
        plan.refresh();
      }
    } catch {
      setMessage("Plan creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdits() {
    if (!scope || !current || editLines.length === 0 || editLines.length > 100 || busy) return;
    const steps: HarnessPlanStepDraft[] = editLines.map((title, index) => {
      const existing = current.steps[index];
      return existing
        ? {
            id: existing.id,
            title,
            dependsOn: dependencyOverrides[existing.id] ?? existing.dependsOn,
            checkoutKey: existing.checkoutKey,
            provider: providerOverrides[existing.id] ?? existing.provider,
            model: modelOverrides[existing.id] ?? existing.model,
            acceptanceCriteria: criteriaOverrides[existing.id] ?? existing.acceptanceCriteria,
          }
        : {
            id: randomUUID(),
            title,
            dependsOn: index > 0 ? [current.steps[index - 1]?.id ?? ""] : [],
            checkoutKey: `project:${scope.input.projectId}`,
            provider: newProvider,
            ...(newModel.trim() ? { model: newModel.trim() } : {}),
            acceptanceCriteria: "User verifies this step is complete",
          };
    });
    // New steps extend the linear plan from the previous new or persisted step.
    for (let index = current.steps.length; index < steps.length; index++) {
      if (index > 0) {
        steps[index] = { ...steps[index]!, dependsOn: [steps[index - 1]!.id] };
      }
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await change({
        ...scope,
        input: {
          ...scope.input,
          expectedRevision: current.revision,
          change: { type: "edit", steps },
        },
      });
      if (result._tag !== "Success") {
        setMessage("Edit refused. Active steps and dependencies are protected; reload the plan.");
      } else {
        setDraft("");
        setProviderOverrides({});
        setModelOverrides({});
        setDependencyOverrides({});
        setCriteriaOverrides({});
        setMessage("Plan revision saved.");
        plan.refresh();
      }
    } catch {
      setMessage("Unable to save the plan revision.");
    } finally {
      setBusy(false);
    }
  }

  async function startNativeStep(stepId: string) {
    if (!scope || !current || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await dispatch({
        ...scope,
        input: { ...scope.input, stepId, expectedRevision: current.revision },
      });
      if (result._tag !== "Success") {
        setMessage(
          "Agent start was refused or could not be confirmed. Reload the plan and " +
            "review any retained checkout lease before retrying.",
        );
      } else {
        setMessage("Agent step was dispatched. Further steps require explicit user action.");
        plan.refresh();
      }
    } catch {
      setMessage(
        "Native dispatch could not be confirmed. Review the thread and checkout lease; " +
          "do not blindly retry.",
      );
      plan.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function stopNativeStep(stepId: string) {
    if (!scope || !current || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await interrupt({
        ...scope,
        input: { ...scope.input, stepId, expectedRevision: current.revision },
      });
      if (result._tag !== "Success") {
        setMessage(
          "Stop was not confirmed. Inspect the native thread; the checkout remains reserved.",
        );
      } else {
        setMessage(
          "Native stop requested. The plan step and checkout lease remain held until the " +
            "matching provider run has safely finalized.",
        );
      }
      plan.refresh();
      leases.refresh();
    } catch {
      setMessage("Stop outcome is unknown. Inspect the native thread before retrying.");
    } finally {
      setBusy(false);
    }
  }

  async function transition(
    stepId: string,
    next: "pending" | "running" | "completed" | "failed" | "cancelled",
  ) {
    if (!scope || !current || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await change({
        ...scope,
        input: {
          ...scope.input,
          expectedRevision: current.revision,
          change: { type: "transition", stepId, next },
        },
      });
      if (result._tag !== "Success") {
        setMessage("Transition refused: check dependencies, checkout use or plan revision.");
      } else {
        plan.refresh();
      }
    } catch {
      setMessage("Could not update step status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection id="harness-plans" title="Multi-step plans">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Create and edit a durable plan for a thread. Start each native agent step explicitly using
          the saved provider/model assignment. Native steps hold checkout leases until verified run
          finalization; an interrupted dispatch requires manual review. No next step starts
          automatically.
        </p>
        {projectId === null ? (
          <p>Select a project in Settings to manage its plans.</p>
        ) : (
          <>
            <label className="flex flex-col gap-1" htmlFor="harness-plan-thread">
              Thread ID
              <Input
                id="harness-plan-thread"
                value={threadId}
                onChange={(event) => {
                  setThreadId(event.target.value);
                  setDraft("");
                  setProviderOverrides({});
                  setModelOverrides({});
                  setDependencyOverrides({});
                  setCriteriaOverrides({});
                }}
                placeholder="Thread ID"
              />
            </label>
            {plan.error ? <p role="alert">{plan.error}</p> : null}
            {scope && !plan.isPending && current === null ? (
              <p>No saved plan for this thread.</p>
            ) : null}
            {current ? (
              <>
                <p className="font-medium">
                  Plan revision {current.revision} · {current.steps.length} steps
                </p>
                <ol className="flex flex-col gap-2" aria-label="Saved plan steps">
                  {current.steps.map((step, index) => (
                    <li key={step.id} className="rounded-md border p-3">
                      <p className="font-medium">
                        {index + 1}. {step.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {step.status} · {step.provider} · {step.acceptanceCriteria}
                      </p>
                      {step.dependsOn.length > 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Depends on:{" "}
                          {step.dependsOn
                            .map(
                              (id) => current.steps.find((other) => other.id === id)?.title ?? id,
                            )
                            .join(", ")}
                        </p>
                      ) : null}
                      {(step.status === "pending" || step.status === "failed") && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <label className="flex flex-col gap-1 text-xs">
                            Assigned provider
                            <select
                              className="rounded-md border bg-background p-2"
                              value={providerOverrides[step.id] ?? step.provider}
                              disabled={busy}
                              onChange={(event) =>
                                setProviderOverrides((previous) => ({
                                  ...previous,
                                  [step.id]: event.target.value,
                                }))
                              }
                            >
                              {!PLAN_PROVIDERS.some((provider) => provider.id === step.provider) ? (
                                <option value={step.provider}>{step.provider}</option>
                              ) : null}
                              {availableProviders.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="flex flex-col gap-1 text-xs">
                            Model ID (optional)
                            <Input
                              value={modelOverrides[step.id] ?? step.model ?? ""}
                              disabled={busy}
                              onChange={(event) =>
                                setModelOverrides((previous) => ({
                                  ...previous,
                                  [step.id]: event.target.value,
                                }))
                              }
                              placeholder="Provider default"
                            />
                          </label>
                          <label className="flex min-w-48 flex-col gap-1 text-xs">
                            Acceptance criteria
                            <Input
                              value={criteriaOverrides[step.id] ?? step.acceptanceCriteria}
                              disabled={busy}
                              onChange={(event) =>
                                setCriteriaOverrides((previous) => ({
                                  ...previous,
                                  [step.id]: event.target.value,
                                }))
                              }
                              placeholder="Expected result and required tests"
                            />
                          </label>
                        </div>
                      )}
                      {(step.status === "pending" || step.status === "failed") && (
                        <details className="mt-2 rounded-md border p-2 text-xs">
                          <summary className="cursor-pointer">Edit step dependencies</summary>
                          <p className="mt-2 text-muted-foreground">
                            Choose prerequisite steps. Cycles and unfinished prerequisites for
                            active work are rejected when you save.
                          </p>
                          <div className="mt-2 flex flex-col gap-1">
                            {current.steps
                              .filter((candidate) => candidate.id !== step.id)
                              .map((candidate) => {
                                const selected = dependencyOverrides[step.id] ?? step.dependsOn;
                                return (
                                  <label key={candidate.id} className="flex items-center gap-2">
                                    <input
                                      type="checkbox"
                                      disabled={busy}
                                      checked={selected.includes(candidate.id)}
                                      onChange={(event) =>
                                        setDependencyOverrides((previous) => ({
                                          ...previous,
                                          [step.id]: event.target.checked
                                            ? [...selected, candidate.id]
                                            : selected.filter((id) => id !== candidate.id),
                                        }))
                                      }
                                    />
                                    {candidate.title}
                                  </label>
                                );
                              })}
                          </div>
                        </details>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {step.status === "pending" ? (
                          <>
                            <Button
                              size="xs"
                              disabled={
                                busy ||
                                providerOverrides[step.id] !== undefined ||
                                modelOverrides[step.id] !== undefined ||
                                dependencyOverrides[step.id] !== undefined ||
                                criteriaOverrides[step.id] !== undefined
                              }
                              onClick={() => void startNativeStep(step.id)}
                            >
                              Start agent
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void transition(step.id, "running")}
                            >
                              Track manually
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void transition(step.id, "cancelled")}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : null}
                        {step.status === "running" && step.dispatchMessageId !== undefined ? (
                          <>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void stopNativeStep(step.id)}
                            >
                              Stop agent
                            </Button>
                            <p className="text-xs text-muted-foreground">
                              Stopping requests an interrupt; it does not unlock the checkout until
                              the native run is safely finalized.
                            </p>
                          </>
                        ) : null}
                        {step.status === "running" && step.dispatchMessageId === undefined ? (
                          <>
                            <Button
                              size="xs"
                              disabled={busy}
                              onClick={() => void transition(step.id, "completed")}
                            >
                              Mark complete
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void transition(step.id, "failed")}
                            >
                              Mark failed
                            </Button>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void transition(step.id, "cancelled")}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : null}
                        {step.status === "failed" || step.status === "cancelled" ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void transition(step.id, "pending")}
                          >
                            Reset to pending
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
            {scope ? (
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-col gap-1" htmlFor="harness-plan-new-provider">
                  Provider for new steps
                  <select
                    id="harness-plan-new-provider"
                    className="rounded-md border bg-background p-2"
                    value={newProvider}
                    disabled={busy}
                    onChange={(event) => setNewProvider(event.target.value)}
                  >
                    {PLAN_PROVIDERS.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1" htmlFor="harness-plan-new-model">
                  Model for new steps (optional)
                  <Input
                    id="harness-plan-new-model"
                    value={newModel}
                    disabled={busy}
                    onChange={(event) => setNewModel(event.target.value)}
                    placeholder="Provider default"
                  />
                </label>
              </div>
            ) : null}
            {scope ? (
              <label className="flex flex-col gap-1" htmlFor="harness-plan-lines">
                {current
                  ? "Edit pending step titles (one per line)"
                  : "New plan steps (one per line)"}
                <textarea
                  id="harness-plan-lines"
                  className="min-h-24 w-full rounded-md border bg-background p-2"
                  maxLength={10000}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    current
                      ? "Select Load steps to edit the current plan"
                      : "Research\nImplement\nTest"
                  }
                />
              </label>
            ) : null}
            {scope && current ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setDraft(current.steps.map((step) => step.title).join("\n"))}
                >
                  Load steps for editing
                </Button>
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    editLines.length === 0 ||
                    (lines.length === 0 &&
                      Object.keys(providerOverrides).length === 0 &&
                      Object.keys(modelOverrides).length === 0)
                  }
                  onClick={() => void saveEdits()}
                >
                  Save plan revision
                </Button>
              </div>
            ) : null}
            {scope && current === null ? (
              <Button
                size="sm"
                disabled={busy || lines.length === 0}
                onClick={() => void createPlan()}
              >
                Create plan
              </Button>
            ) : null}
          </>
        )}
        {scope ? (
          <section aria-label="Native checkout lease inspection" className="rounded-md border p-3">
            <p className="font-medium">Checkout leases and crash review</p>
            <p className="text-xs text-muted-foreground">
              Active records survive process restarts. A retained lease may indicate a live agent,
              interrupted dispatch, or unresolved side effect. Verify native processes and the
              working tree before attempting further writes.
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                leases.refresh();
                plan.refresh();
              }}
            >
              Refresh lease status
            </Button>
            {leases.error ? <p role="alert">{leases.error}</p> : null}
            {(leases.data?.length ?? 0) === 0 && !leases.isPending && !leases.error ? (
              <p className="text-xs">No active checkout lease is recorded for this thread.</p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {leases.data?.map((lease) => (
                <li key={lease.leaseId} className="rounded border p-2 text-xs">
                  <p>Lease: {lease.leaseId}</p>
                  <p>Checkout: {lease.checkoutPath}</p>
                  <p>
                    Plan/step: {lease.planId} / {lease.stepId}
                  </p>
                  <p>Acquired: {lease.acquiredAt}</p>
                  <p className="text-muted-foreground">
                    No force-release is offered: a native child may still be writing here.
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </div>
    </SettingsSection>
  );
}
