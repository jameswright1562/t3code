import { useState } from "react";
import { validateHarnessMcpServer } from "@t3tools/shared/harnessMcp";
import type { HarnessMcpServerConfig, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { requestConfirmDialog } from "~/confirmDialog";

/**
 * Shared configuration is persisted in the environment's settings, and is
 * available to native providers only for explicitly selected projects/providers.
 * OAuth and headers are deliberately not accepted until a Keychain-backed
 * credential workflow can be wired end-to-end.
 */
export function HarnessMcpSettings() {
  const { target } = useSettingsScope();
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const settings = target?.settings;
  const configured = settings?.harnessMcpServers ?? {};
  const [editingId, setEditingId] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [projectScope, setProjectScope] = useState<"selected" | "all">("selected");
  const [existingProjectIds, setExistingProjectIds] = useState<string[]>([]);
  const [allowedTools, setAllowedTools] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const availableProviderIds = Array.from(
    new Set([
      "claudeAgent",
      "codex",
      "cursor",
      "opencode",
      ...Object.keys(settings?.providerInstances ?? {}),
    ]),
  ).sort();

  const reset = () => {
    setEditingId(null);
    setId("");
    setName("");
    setTransport("http");
    setUrl("");
    setCommand("");
    setArgs("");
    setCwd("");
    setEnabled(true);
    setSelectedProviders([]);
    setExistingProjectIds([]);
    setProjectScope("selected");
    setAllowedTools("");
  };
  const edit = (serverId: string, config: HarnessMcpServerConfig) => {
    setEditingId(serverId);
    setId(serverId);
    setName(config.name);
    setTransport(config.transport);
    setUrl(config.url);
    setCommand(config.command);
    setArgs(config.args.join("\n"));
    setCwd(config.cwd);
    setEnabled(config.enabled);
    setSelectedProviders([...config.providerInstanceIds]);
    setProjectScope(config.projectIds.length === 0 ? "all" : "selected");
    setExistingProjectIds([...config.projectIds]);
    setAllowedTools(config.allowedTools.join(", "));
    setMessage(null);
  };

  const save = async () => {
    if (target === null) return;
    const nextId = id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(nextId) || nextId.startsWith("t3-code")) {
      setMessage("Choose a safe server ID (letters, digits, dash/underscore; not t3-code).");
      return;
    }
    if (!name.trim() || selectedProviders.length === 0) {
      setMessage("Name the server and select at least one agent provider.");
      return;
    }
    if (transport === "http") {
      try {
        const parsed = new URL(url.trim());
        if (
          !(
            parsed.protocol === "https:" ||
            (parsed.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
          )
        ) {
          setMessage("Use HTTPS or a local HTTP endpoint.");
          return;
        }
      } catch {
        setMessage("Enter a valid HTTP(S) MCP URL.");
        return;
      }
    } else if (!command.trim() || /[\r\n\x00]/.test(command)) {
      setMessage("Enter a local executable (not a shell script pipeline).");
      return;
    }
    const projectIds =
      projectScope === "all"
        ? []
        : existingProjectIds.length > 0
          ? existingProjectIds
          : target.projectId === null
            ? []
            : [target.projectId];
    if (projectScope === "selected" && projectIds.length === 0) {
      setMessage("Select a project in Settings, or explicitly choose all projects.");
      return;
    }
    const entry: HarnessMcpServerConfig = {
      name: name.trim(),
      transport,
      enabled,
      url: transport === "http" ? url.trim() : "",
      command: transport === "stdio" ? command.trim() : "",
      args:
        transport === "stdio"
          ? args
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean)
          : [],
      cwd: transport === "stdio" ? cwd.trim() : "",
      providerInstanceIds: selectedProviders as ProviderInstanceId[],
      projectIds: projectIds as ProjectId[],
      allowedTools: allowedTools
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    };
    const validationError = validateHarnessMcpServer(nextId, entry);
    if (validationError !== null) {
      setMessage(validationError);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const changes: Record<string, HarnessMcpServerConfig | null> = { [nextId]: entry };
      if (editingId !== null && editingId !== nextId) changes[editingId] = null;
      const result = await update({
        environmentId: target.environmentId,
        input: { patch: { harnessMcpServers: changes } },
      });
      if (result._tag !== "Success") {
        setMessage("Could not save MCP settings. Check your permissions.");
      } else {
        setMessage("MCP configuration saved. New native agent sessions will load it.");
        reset();
      }
    } catch {
      setMessage("The MCP settings update failed.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (serverId: string) => {
    if (target === null) return;
    const approved = await requestConfirmDialog(
      "Remove this shared MCP server? Existing native sessions may retain its connection until restarted.",
    );
    if (!approved) return;
    setBusy(true);
    try {
      const result = await update({
        environmentId: target.environmentId,
        input: { patch: { harnessMcpServers: { [serverId]: null } } },
      });
      setMessage(
        result._tag === "Success" ? "Removed MCP server." : "Could not remove MCP server.",
      );
    } catch {
      setMessage("Could not remove MCP server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection id="harness-mcp" title="Shared MCP servers">
      <p className="text-sm text-muted-foreground">
        Add local stdio or remote HTTP MCP servers once, then select which providers and projects
        may use them. Each agent manages its own native connection; new sessions pick up changes.
        HTTP authentication/OAuth is not yet available through this form. Never paste tokens into
        URLs or commands.
      </p>
      {target === null ? (
        <p role="status">Choose an environment above to manage MCP servers.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2">
            {Object.entries(configured).map(([serverId, config]) => (
              <li
                key={serverId}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {config.name} ({serverId}) {config.enabled ? "" : "· disabled"}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {config.transport === "http" ? config.url : config.command}
                    {" · "}
                    {config.providerInstanceIds.join(", ")}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => edit(serverId, config)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void remove(serverId)}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <fieldset className="flex flex-col gap-3 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">
              {editingId ? "Edit MCP server" : "Add MCP server"}
            </legend>
            <label className="text-xs" htmlFor="harness-mcp-id">
              Server ID
            </label>
            <Input
              id="harness-mcp-id"
              value={id}
              disabled={busy}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. figma"
            />
            <label className="text-xs" htmlFor="harness-mcp-name">
              Display name
            </label>
            <Input
              id="harness-mcp-name"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="Figma"
            />
            <div className="flex items-center gap-3">
              <label className="text-sm">
                <input
                  type="radio"
                  checked={transport === "http"}
                  onChange={() => setTransport("http")}
                />{" "}
                Remote HTTP
              </label>
              <label className="text-sm">
                <input
                  type="radio"
                  checked={transport === "stdio"}
                  onChange={() => setTransport("stdio")}
                />{" "}
                Local stdio
              </label>
              <label className="text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />{" "}
                Enabled
              </label>
            </div>
            {transport === "http" ? (
              <>
                <label className="text-xs" htmlFor="harness-mcp-url">
                  MCP URL
                </label>
                <Input
                  id="harness-mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Local stdio executes with your operating-system permissions. Only configure
                  trusted servers.
                </p>
                <label className="text-xs" htmlFor="harness-mcp-command">
                  Executable
                </label>
                <Input
                  id="harness-mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                />
                <label className="text-xs" htmlFor="harness-mcp-args">
                  Arguments (one per line)
                </label>
                <textarea
                  id="harness-mcp-args"
                  className="min-h-24 rounded-md border bg-background p-2 text-sm"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                />
                <label className="text-xs" htmlFor="harness-mcp-cwd">
                  Working directory (optional)
                </label>
                <Input id="harness-mcp-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} />
              </>
            )}
            <fieldset>
              <legend className="text-sm">Allowed agent providers</legend>
              <div className="mt-2 flex flex-wrap gap-3">
                {availableProviderIds.map((providerId) => (
                  <label key={providerId} className="text-sm">
                    <input
                      type="checkbox"
                      checked={selectedProviders.includes(providerId)}
                      onChange={(e) =>
                        setSelectedProviders((old) =>
                          e.target.checked
                            ? [...old, providerId]
                            : old.filter((v) => v !== providerId),
                        )
                      }
                    />{" "}
                    {providerId}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-sm">Project availability</legend>
              <label className="mr-3 text-sm">
                <input
                  type="radio"
                  checked={projectScope === "selected"}
                  onChange={() => setProjectScope("selected")}
                />{" "}
                Selected project
              </label>
              <label className="text-sm">
                <input
                  type="radio"
                  checked={projectScope === "all"}
                  onChange={() => setProjectScope("all")}
                />{" "}
                All projects
              </label>
              {projectScope === "selected" ? (
                <p className="text-xs text-muted-foreground">
                  Uses existing saved project IDs when editing, or the currently selected project
                  when adding.
                </p>
              ) : null}
            </fieldset>
            <label className="text-xs" htmlFor="harness-mcp-allowed-tools">
              Tool allowlist (optional, comma-separated)
            </label>
            <Input
              id="harness-mcp-allowed-tools"
              value={allowedTools}
              onChange={(e) => setAllowedTools(e.target.value)}
              placeholder="e.g. search, read_file"
            />
            <p className="text-xs text-muted-foreground">
              Native adapters may not enforce tool allowlists uniformly. For high-risk integrations,
              use provider permissions.
            </p>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Save server"}
              </Button>
              {editingId !== null ? (
                <Button variant="outline" onClick={reset}>
                  Cancel edit
                </Button>
              ) : null}
            </div>
          </fieldset>
        </div>
      )}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </SettingsSection>
  );
}
