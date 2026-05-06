import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildOpenCodeProcessEnvironment, resolveOpenCodeLaunchSpec } from "./openCodeLaunch.ts";

describe("resolveOpenCodeLaunchSpec", () => {
  it("keeps plain executable names unchanged", () => {
    expect(resolveOpenCodeLaunchSpec("opencode")).toEqual({
      executable: "opencode",
      args: [],
      displayBinaryPath: "opencode",
    });
  });

  it("treats an OpenCode checkout root as a runnable Node script", () => {
    const root = mkdtempSync(path.join(tmpdir(), "t3code-opencode-root-"));
    const scriptPath = path.join(root, "packages", "opencode", "bin", "opencode");
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env node\nconsole.log('opencode')\n");

    expect(resolveOpenCodeLaunchSpec(root)).toEqual({
      executable: process.execPath,
      args: [scriptPath],
      displayBinaryPath: root,
    });
  });

  it("treats an OpenCode package directory as a runnable Node script", () => {
    const packageDir = mkdtempSync(path.join(tmpdir(), "t3code-opencode-package-"));
    const scriptPath = path.join(packageDir, "bin", "opencode");
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env node\nconsole.log('opencode')\n");

    expect(resolveOpenCodeLaunchSpec(packageDir)).toEqual({
      executable: process.execPath,
      args: [scriptPath],
      displayBinaryPath: packageDir,
    });
  });
});

describe("buildOpenCodeProcessEnvironment", () => {
  it("isolates local launches from ambient OpenCode config when no config is provided", () => {
    expect(
      buildOpenCodeProcessEnvironment(
        {
          PATH: "/usr/bin",
          OPENCODE_CONFIG_CONTENT: '{"provider":{"ambient":{"name":"Ambient"}}}',
        },
        "",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCODE_CONFIG_CONTENT: "{}",
    });
  });

  it("injects explicit OpenCode config content for local launches", () => {
    expect(
      buildOpenCodeProcessEnvironment(
        {
          PATH: "/usr/bin",
        },
        '{ "provider": { "openrouter": { "options": { "baseURL": "https://openrouter.ai/api/v1" } } } }',
      ),
    ).toEqual({
      PATH: "/usr/bin",
      OPENCODE_CONFIG_CONTENT:
        '{ "provider": { "openrouter": { "options": { "baseURL": "https://openrouter.ai/api/v1" } } } }',
    });
  });
});
