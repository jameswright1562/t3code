import type { HarnessMcpServerConfig, ProviderInstanceId, ProjectId } from "@t3tools/contracts";

/** One canonical filter for native provider adapters; no implicit global access. */
export type HarnessMcpSelection = Readonly<Record<string, HarnessMcpServerConfig>>;

export function selectHarnessMcpServers(
  registry: HarnessMcpSelection,
  provider: ProviderInstanceId,
  project: ProjectId,
): Readonly<Record<string, HarnessMcpServerConfig>> {
  return Object.fromEntries(
    Object.entries(registry).filter(([id, server]) => {
      // Both Claude's MCP prefix matching and Codex's dotted config keys
      // require collision-free identifiers, not arbitrary user-entered labels.
      if (!/^[a-z][a-z0-9_-]{0,47}$/i.test(id) || /^t3-code(?:-|$)/i.test(id)) return false;
      if (!server.enabled || !server.providerInstanceIds.includes(provider)) return false;
      // Native Codex supports enabled_tools. Other adapters cannot guarantee
      // server-side filtering; fail closed rather than silently granting all tools.
      if (server.allowedTools.length > 0 && String(provider) !== "codex") return false;
      if (server.projectIds.length > 0 && !server.projectIds.includes(project)) return false;
      if (server.transport === "stdio") {
        return Boolean(server.command.trim()) && !/[\r\n\x00]/.test(server.command);
      }
      if (server.transport !== "http") return false;
      try {
        const endpoint = new URL(server.url);
        return endpoint.protocol === "https:" ||
          (endpoint.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
      } catch {
        return false;
      }
    }),
  );
}

export function toClaudeHarnessMcpServers(
  selected: HarnessMcpSelection,
): Readonly<Record<string, { readonly type: "http"; readonly url: string } |
  { readonly type: "stdio"; readonly command: string; readonly args: string[]; readonly cwd?: string }>> {
  return Object.fromEntries(
    Object.entries(selected).map(([id, server]) => [
      id,
      server.transport === "http"
        ? { type: "http" as const, url: server.url }
        : {
            type: "stdio" as const,
            command: server.command,
            args: [...server.args],
            ...(server.cwd.trim() === "" ? {} : { cwd: server.cwd }),
          },
    ]),
  );
}

export function toCodexHarnessMcpConfig(
  selected: HarnessMcpSelection,
): Readonly<Record<string, Record<string, string | readonly string[]>>> {
  return Object.fromEntries(
    Object.entries(selected).map(([id, server]) => [
      "mcp_servers." + id,
      server.transport === "http"
        ? {
            url: server.url,
            ...(server.allowedTools.length === 0 ? {} : { enabled_tools: server.allowedTools }),
          }
        : {
            command: server.command,
            args: server.args,
            ...(server.cwd.trim() === "" ? {} : { cwd: server.cwd }),
            ...(server.allowedTools.length === 0 ? {} : { enabled_tools: server.allowedTools }),
          },
    ]),
  );
}
