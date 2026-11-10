import { useState, type ChangeEvent } from "react";
import type { HarnessMemoryEntry, HarnessMemoryBackup } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { requestConfirmDialog } from "~/confirmDialog";

/**
 * Project-scoped host UI. The server additionally checks settings-write scope
 * for approvals and mutations. Agent MCP credentials cannot call these RPCs.
 */
export function AgentMemorySettings() {
  const { target } = useSettingsScope();
  const environmentId = target?.environmentId ?? null;
  const projectId = target?.projectId ?? null;
  const scope = projectId === null ? null : { scopeType: "project" as const, scopeId: projectId };
  const memories = useEnvironmentQuery(
    environmentId !== null && scope !== null
      ? serverEnvironment.harnessMemories({ environmentId, input: { scope } })
      : null,
  );
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [threadId, setThreadId] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const recovery = useEnvironmentQuery(
    environmentId !== null && projectId !== null && threadId.trim().length > 0
      ? serverEnvironment.harnessRecoverCheckpoint({
          environmentId,
          input: { projectId, threadId: threadId.trim() },
        })
      : null,
  );

  const confirm = useAtomCommand(serverEnvironment.harnessConfirmMemory);
  const forget = useAtomCommand(serverEnvironment.harnessForgetMemory);
  const pin = useAtomCommand(serverEnvironment.harnessPinMemory);
  const exportEntries = useAtomCommand(serverEnvironment.harnessExportMemory);
  const backupEntries = useAtomCommand(serverEnvironment.harnessBackupMemory);
  const restoreEntries = useAtomCommand(serverEnvironment.harnessRestoreMemory);
  const revise = useAtomCommand(serverEnvironment.harnessReviseMemory);
  const entries = memories.data?.filter((entry) =>
    [entry.kind, entry.content, entry.sourceRef, entry.verification]
      .some((value) => value.toLowerCase().includes(filter.trim().toLowerCase())),
  ) ?? [];

  async function mutate(
    entry: HarnessMemoryEntry,
    action: "confirm" | "forget" | "pin",
  ): Promise<void> {
    if (environmentId === null || scope === null) return;
    if (action === "forget") {
      const approved = await (requestConfirmDialog(
        "Forget this memory? It will be excluded from future context. Its audit history is retained.",
      ) ?? Promise.resolve(false));
      if (!approved) return;
    }
    setBusy(entry.id);
    setMessage(null);
    const input = { environmentId, input: { id: entry.id, scope, eventId: randomUUID() } };
    try {
      const result =
        action === "confirm"
          ? await confirm(input)
          : action === "forget"
            ? await forget(input)
            : await pin({ ...input, input: { ...input.input, pinned: !entry.pinned } });
      if (result._tag !== "Success") {
        setMessage("The memory change was not saved. Check your settings permissions.");
      } else {
        memories.refresh();
      }
    } catch {
      setMessage("The memory operation failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveRevision(): Promise<void> {
    if (environmentId === null || scope === null || editing === null) return;
    const content = editing.content.trim();
    if (!content || content.length > 100_000) {
      setMessage("Revision must contain 1–100,000 characters.");
      return;
    }
    setBusy(editing.id);
    setMessage(null);
    try {
      const result = await revise({
        environmentId,
        input: {
          id: editing.id,
          replacementId: randomUUID(),
          eventId: randomUUID(),
          scope,
          content,
        },
      });
      if (result._tag !== "Success") {
        setMessage("Revision not saved. Refresh and check for a newer revision.");
      } else {
        setEditing(null);
        memories.refresh();
        setMessage("Saved a verified revision. Original source and audit history are retained.");
      }
    } catch {
      setMessage("Memory revision failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveExport(): Promise<void> {
    if (environmentId === null || scope === null) return;
    setBusy("export");
    setMessage(null);
    try {
      const result = await exportEntries({ environmentId, input: { scope } });
      if (result._tag !== "Success") {
        setMessage("Memory export failed.");
        return;
      }
      const blob = new Blob([JSON.stringify(result.value, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "t3-project-memory.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("Exported selected live project memories. Audit history is not included.");
    } catch {
      setMessage("Memory export failed.");
    } finally {
      setBusy(null);
    }
  }

  async function saveBackup(): Promise<void> {
    if (environmentId === null || scope === null) return;
    setBusy("backup");
    setMessage(null);
    try {
      const result = await backupEntries({ environmentId, input: { scope } });
      if (result._tag !== "Success") {
        setMessage("Full memory backup failed.");
        return;
      }
      const blob = new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "t3-project-memory-backup.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("Saved complete scoped memory backup, including tombstones and audit history.");
    } catch {
      setMessage("Full memory backup failed.");
    } finally {
      setBusy(null);
    }
  }

  async function restoreBackup(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined || environmentId === null || scope === null) return;
    if (file.size > 16 * 1024 * 1024) {
      setMessage("Backup exceeds the maximum 16 MiB size.");
      return;
    }
    const approved = await (requestConfirmDialog(
      "Restore this project memory backup? This imports its original provenance, deletions and audit history. Conflicting records will be rejected; no existing memory will be overwritten.",
    ) ?? Promise.resolve(false));
    if (!approved) return;
    setBusy("restore");
    setMessage(null);
    try {
      const backup = JSON.parse(await file.text()) as HarnessMemoryBackup;
      const result = await restoreEntries({ environmentId, input: { scope, backup } });
      if (result._tag !== "Success") {
        setMessage("Backup rejected. Check its checksum, project scope and existing record conflicts.");
        return;
      }
      memories.refresh();
      setMessage(`Restored ${result.value.importedEntries} memories and ${result.value.importedEvents} audit events.`);
    } catch {
      setMessage("Could not read or restore this backup JSON file.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection id="agent-memory" title="Agent memory">
      <p className="text-sm text-muted-foreground">
        Verified project memories survive agent sessions. Proposed memories are never trusted
        automatically. Select a single project in the settings scope to review its memories.
      </p>
      {projectId === null || environmentId === null ? (
        <p className="text-sm text-muted-foreground" role="status">
          Select a project above to manage its memory.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Search project memories"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search content, type or source"
            />
            <Button variant="outline" disabled={busy !== null} onClick={() => memories.refresh()}>
              Refresh
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void saveExport()}>
              Export live JSON
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => void saveBackup()}>
              Full backup
            </Button>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Restore complete memory backup for this project
            <input
              type="file"
              accept="application/json,.json"
              aria-label="Restore project memory backup"
              disabled={busy !== null}
              onChange={(event) => void restoreBackup(event)}
            />
          </label>
          {memories.error ? <p role="alert" className="text-sm">{memories.error}</p> : null}
          {memories.isPending ? <p role="status">Loading project memories…</p> : null}
          {entries.length === 0 && !memories.isPending ? (
            <p className="text-sm text-muted-foreground">No matching memories.</p>
          ) : null}
          <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto" aria-label="Project memories">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-md border p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">
                    {entry.kind} · {entry.verification}{entry.pinned ? " · pinned" : ""}
                  </span>
                  <div className="flex gap-1">
                    {entry.verification === "proposed" ? (
                      <Button size="xs" disabled={busy !== null} onClick={() => void mutate(entry, "confirm")}>
                        Approve
                      </Button>
                    ) : null}
                    <Button size="xs" variant="outline" disabled={busy !== null}
                      onClick={() => setEditing({ id: entry.id, content: entry.content })}>
                      Edit
                    </Button>
                    <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void mutate(entry, "pin")}>
                      {entry.pinned ? "Unpin" : "Pin"}
                    </Button>
                    <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void mutate(entry, "forget")}>
                      Forget
                    </Button>
                  </div>
                </div>
                {editing?.id === entry.id ? (
                  <div className="flex flex-col gap-2">
                    <label className="text-xs" htmlFor={`edit-memory-${entry.id}`}>New memory revision</label>
                    <textarea
                      id={`edit-memory-${entry.id}`}
                      className="min-h-24 w-full rounded-md border bg-background p-2 text-sm"
                      value={editing.content}
                      maxLength={100_000}
                      onChange={(event) => setEditing({ id: entry.id, content: event.target.value })}
                    />
                    <div className="flex gap-2">
                      <Button size="xs" disabled={busy !== null} onClick={() => void saveRevision()}>
                        Save revision
                      </Button>
                      <Button size="xs" variant="outline" disabled={busy !== null}
                        onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">{entry.content}</p>
                )}
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  Source: {entry.sourceRef} · {entry.sourceActor}
                </p>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-2 border-t pt-3">
            <label className="text-sm font-medium" htmlFor="harness-recovery-thread">
              Inspect a saved thread checkpoint
            </label>
            <Input
              id="harness-recovery-thread"
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              placeholder="Thread ID"
            />
            {recovery.error ? <p role="alert">{recovery.error}</p> : null}
            {recovery.data?.skippedInvalid ? (
              <p role="status">Skipped {recovery.data.skippedInvalid} invalid checkpoint(s).</p>
            ) : null}
            {recovery.data?.checkpoint ? (
              <p className="text-sm">
                Latest valid checkpoint #{recovery.data.checkpoint.sequence}:{" "}
                {JSON.stringify(recovery.data.checkpoint.checkpoint)}
              </p>
            ) : threadId.trim() && !recovery.isPending ? (
              <p className="text-sm text-muted-foreground">No valid checkpoint for this thread.</p>
            ) : null}
          </div>
        </div>
      )}
      {message ? <p className="text-sm" role="status">{message}</p> : null}
    </SettingsSection>
  );
}
