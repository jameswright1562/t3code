import { describe, expect, it } from "vitest";
import type { HarnessMcpServerConfig, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  selectHarnessMcpServers,
  toClaudeHarnessMcpServers,
  toCodexHarnessMcpConfig,
} from "./harnessMcp.ts";

const server = (overrides: Partial<HarnessMcpServerConfig> = {}): HarnessMcpServerConfig => ({
  name: "Example",
  enabled: true,
  transport: "http",
  url: "https://mcp.example.org/mcp",
  command: "",
  args: [],
  cwd: "",
  providerInstanceIds: ["claudeAgent" as ProviderInstanceId],
  projectIds: ["alpha" as ProjectId],
  allowedTools: [],
  ...overrides,
});

describe("shared MCP provider routing", () => {
  it("does not expose disabled, unauthorized, conflicting, or unsafe servers", () => {
    const registry = {
      allowed: server(),
      disabled: server({ enabled: false }),
      "t3-code": server(),
      otherProject: server({ projectIds: ["beta" as ProjectId] }),
      otherProvider: server({ providerInstanceIds: ["codex" as ProviderInstanceId] }),
      insecure: server({ url: "http://public.example.org/mcp" }),
      malformed: server({ url: "invalid" }),
      local: server({ url: "http://127.0.0.1:8765/mcp" }),
    };
    expect(Object.keys(selectHarnessMcpServers(registry, "claudeAgent" as ProviderInstanceId, "alpha" as ProjectId))).toEqual(["allowed", "local"]);
    expect(selectHarnessMcpServers(registry, "claudeAgent" as ProviderInstanceId, "beta" as ProjectId)).toEqual({});
  });

  it("serializes HTTP and stdio servers to native runtime formats", () => {
    const selected = {
      external: server({ projectIds: [] }),
      compiler: server({
        transport: "stdio", url: "", command: "npx", args: ["-y", "mcp-test"],
        allowedTools: ["search"],
      }),
    };
    expect(toClaudeHarnessMcpServers(selected)).toMatchObject({
      external: { type: "http", url: "https://mcp.example.org/mcp" },
      compiler: { type: "stdio", command: "npx", args: ["-y", "mcp-test"] },
    });
    expect(toCodexHarnessMcpConfig(selected)).toMatchObject({
      "mcp_servers.external": { url: "https://mcp.example.org/mcp" },
      "mcp_servers.compiler": { command: "npx", args: ["-y", "mcp-test"], enabled_tools: ["search"] },
    });
  });
});
