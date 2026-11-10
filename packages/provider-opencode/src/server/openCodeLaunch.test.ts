import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildOpenCodeProcessEnvironment, resolveOpenCodeLaunchSpec } from "./openCodeLaunch.ts";

describe("resolveOpenCodeLaunchSpec", () => {
  it("preserves a native executable name", () => {
    expect(resolveOpenCodeLaunchSpec("opencode")).toEqual({
      executable: "opencode",
      args: [],
      displayBinaryPath: "opencode",
    });
  });

  it("starts a source checkout's Node script", () => {
    const root = mkdtempSync(path.join(tmpdir(), "t3-opencode-test-"));
    try {
      const filename = path.join(root, "packages", "opencode", "bin", "opencode");
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename, "#!/usr/bin/env node\nconsole.log('opencode');\n");
      expect(resolveOpenCodeLaunchSpec(root)).toEqual({
        executable: process.execPath,
        args: [filename],
        displayBinaryPath: root,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not misidentify a native file named opencode as a script", () => {
    const root = mkdtempSync(path.join(tmpdir(), "t3-opencode-bin-"));
    try {
      const executable = path.join(root, "opencode");
      writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(resolveOpenCodeLaunchSpec(executable)).toEqual({
        executable,
        args: [],
        displayBinaryPath: executable,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildOpenCodeProcessEnvironment", () => {
  it("preserves ambient configuration until UI config explicitly overrides it", () => {
    const original = { PATH: "/usr/bin", OPENCODE_CONFIG_CONTENT: '{"model":"existing"}' };
    expect(buildOpenCodeProcessEnvironment(original, "")).toEqual(original);
    expect(buildOpenCodeProcessEnvironment(original, '{ "model": "custom" }')).toEqual({
      PATH: "/usr/bin",
      OPENCODE_CONFIG_CONTENT: '{ "model": "custom" }',
    });
  });
});
