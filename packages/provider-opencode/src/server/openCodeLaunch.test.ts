import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off - synchronous temporary fixture files in a unit test.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - test fixture paths.
import * as NodePath from "node:path";

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
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-test-"));
    try {
      const filename = NodePath.join(root, "packages", "opencode", "bin", "opencode");
      NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
      NodeFS.writeFileSync(filename, "#!/usr/bin/env node\nconsole.log('opencode');\n");
      expect(resolveOpenCodeLaunchSpec(root)).toEqual({
        executable: process.execPath,
        args: [filename],
        displayBinaryPath: root,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not misidentify a native file named opencode as a script", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-bin-"));
    try {
      const executable = NodePath.join(root, "opencode");
      NodeFS.writeFileSync(executable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(resolveOpenCodeLaunchSpec(executable)).toEqual({
        executable,
        args: [],
        displayBinaryPath: executable,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
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
