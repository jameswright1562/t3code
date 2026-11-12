import { useState } from "react";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

/** Run-budget safety gate is enforced server-side before opening native sessions. */
export function HarnessRunBudgetSettings() {
  const { target } = useSettingsScope();
  const save = useAtomCommand(serverEnvironment.updateSettings);
  const saved = target?.settings?.harnessMaxRunsPerThread ?? 0;
  const savedChildLimit = target?.settings?.harnessMaxConcurrentDelegatedTasks ?? 4;
  const [edit, setEdit] = useState<{ environmentId: string; value: string } | null>(null);
  const [childEdit, setChildEdit] = useState<{ environmentId: string; value: string } | null>(null);
  const draft = edit?.environmentId === target?.environmentId ? edit.value : String(saved);
  const childDraft =
    childEdit?.environmentId === target?.environmentId ? childEdit.value : String(savedChildLimit);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function update(): Promise<void> {
    if (target === null) return;
    const cap = Number(draft);
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > 1000 || !draft.trim()) {
      setMessage("Use a whole number from 0 (unlimited) to 1,000.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await save({
        environmentId: target.environmentId,
        input: { patch: { harnessMaxRunsPerThread: cap } },
      });
      if (result._tag === "Success") setEdit(null);
      setMessage(result._tag === "Success" ? "Run limit saved." : "Could not save run limit.");
    } catch {
      setMessage("Could not save run limit.");
    } finally {
      setBusy(false);
    }
  }
  async function updateChildLimit(): Promise<void> {
    if (target === null) return;
    const limit = Number(childDraft);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 || !childDraft.trim()) {
      setMessage("Use a whole number from 1 to 32 for concurrent delegated children.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await save({
        environmentId: target.environmentId,
        input: { patch: { harnessMaxConcurrentDelegatedTasks: limit } },
      });
      if (result._tag === "Success") setChildEdit(null);
      setMessage(
        result._tag === "Success"
          ? "Child concurrency limit saved."
          : "Could not save child limit.",
      );
    } catch {
      setMessage("Could not save child limit.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection id="harness-run-budget" title="Agent run budgets">
      <p className="text-sm text-muted-foreground">
        Limit how many native provider runs may start in one thread. The limit also applies after
        app restarts. When reached, T3 records a failed run instead of launching another provider
        session. Direct app-created delegated children also have a concurrent limit. Native provider
        subagents and token usage within a run are not yet capped.
      </p>
      {target === null ? (
        <p className="text-sm text-muted-foreground">
          Select an environment to edit its run budget.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <label className="text-sm" htmlFor="harness-max-runs">
              Maximum runs per thread
            </label>
            <Input
              id="harness-max-runs"
              type="number"
              min={0}
              max={1000}
              step={1}
              value={draft}
              disabled={busy}
              onChange={(event) =>
                setEdit({ environmentId: target.environmentId, value: event.target.value })
              }
            />
            <Button disabled={busy} onClick={() => void update()}>
              {busy ? "Saving…" : "Save limit"}
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm" htmlFor="harness-max-children">
              Max concurrent delegated children
            </label>
            <Input
              id="harness-max-children"
              type="number"
              min={1}
              max={32}
              step={1}
              value={childDraft}
              disabled={busy}
              onChange={(event) =>
                setChildEdit({ environmentId: target.environmentId, value: event.target.value })
              }
            />
            <Button disabled={busy} onClick={() => void updateChildLimit()}>
              {busy ? "Saving…" : "Save child limit"}
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        0 disables the per-thread run cap; a value of 20 allows up to 20 runs on each thread.
        The delegated child limit defaults to 4 per active parent run.
      </p>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
