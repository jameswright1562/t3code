import type { HarnessMcpServerConfig, ProviderInstanceId, ProjectId } from "@t3tools/contracts";

/** One canonical filter for native provider adapters; no implicit global access. */
export type HarnessMcpSelection = Readonly<Record<string, HarnessMcpServerConfig>>;

/** Plaintext MCP settings cannot contain bearer credentials. Keychain-backed
 * authentication is a separate feature and must use opaque secret references.
 */
export function validateHarnessMcpServer(id: string, server: HarnessMcpServerConfig): string | null {
  if (!/^[a-z][a-z0-9_-]{0,47}$/i.test(id) || /^t3-code(?:-|$)/i.test(id)) {
    return "Unsafe MCP server ID";
  }
  if (!server.name.trim()) return "MCP server name is required";
  if (server.transport === "stdio") {
    if (!server.command.trim() || /[\r\n\x00]/.test(server.command) ||
        /[\r\n\x00]/.test(server.cwd) ||
        server.args.some((arg) => /[\r\n\x00]/.test(arg))) {
      return "Unsafe stdio executable, directory or argument";
    }
    if (server.args.some((arg) =>
      /(?:^|[-_])(?:token|password|secret|api[-_]?key|credential|authorization)(?:$|[=:-])/i.test(arg))) {
      return "Do not put access tokens or passwords in MCP command arguments";
    }
    return null;
  }
  if (server.transport !== "http") return "Unsupported MCP transport";
  try {
    const url = new URL(server.url);
    if (!(url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      return "Remote MCP endpoints must use HTTPS";
    }
    if (url.username || url.password || url.hash) {
      return "MCP URL cannot contain credentials or fragments";
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:token|password|secret|credential|authorization|api.?key|bearer)/i.test(key)) {
        return "MCP URL contains a credential-like query parameter";
      }
    }
    return null;
  } catch {
    return "Invalid MCP HTTP URL";
  }
}


export function selectHarnessMcpServers(
  registry: HarnessMcpSelection,
  provider: ProviderInstanceId,
  project: ProjectId,
): Readonly<Record<string, HarnessMcpServerConfig>> {
  return Object.fromEntries(
    Object.entries(registry).filter(([id, server]) => {
      // Both Claude's MCP prefix matching and Codex's dotted config keys
      // require collision-free identifiers, not arbitrary user-entered labels.
      if (validateHarnessMcpServer(id, server) !== null) return false;
      if (!server.enabled || !server.providerInstanceIds.includes(provider)) return false;
      // Native Codex supports enabled_tools. Other adapters cannot guarantee
      // server-side filtering; fail closed rather than silently granting all tools.
      if (server.allowedTools.length > 0 && String(provider) !== "codex") return false;
      if (server.projectIds.length > 0 && !server.projectIds.includes(project)) return false;
      return true;
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
