import { describe, expect, it } from "@effect/vitest";
import type { HarnessMcpServerConfig, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  selectHarnessMcpServers,
  validateHarnessMcpServer,
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
    expect(Object.keys(selectHarnessMcpServers(registry, "claudeAgent" as ProviderInstanceId, "beta" as ProjectId))).toEqual(["otherProject"]);
  });

  it("refuses inline credentials and invalid stdio arguments before native injection", () => {
    const registry = {
      clean: server({ url: "https://mcp.example.org/mcp?tenant=abc" }),
      userinfo: server({ url: "https://user:secret@mcp.example.org/mcp" }),
      tokenQuery: server({ url: "https://mcp.example.org/mcp?access_token=secret" }),
      fragment: server({ url: "https://mcp.example.org/mcp#secret" }),
      unsafeArg: server({
        transport: "stdio", url: "", command: "npx", args: ["--api-key", "secret"],
      }),
      unsafeCwd: server({ transport: "stdio", url: "", command: "npx", cwd: "bad\npath" }),
    };
    expect(Object.keys(selectHarnessMcpServers(
      registry, "claudeAgent" as ProviderInstanceId, "alpha" as ProjectId,
    ))).toEqual(["clean"]);
    expect(validateHarnessMcpServer("userinfo", registry.userinfo)).toMatch(/credentials/);
    expect(validateHarnessMcpServer("unsafeArg", registry.unsafeArg)).toMatch(/tokens/);
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
