import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

export interface OpenCodeLaunchSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly displayBinaryPath: string;
}

function safeIsFile(filename: string): boolean {
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

function safeIsDirectory(filename: string): boolean {
  try {
    return statSync(filename).isDirectory();
  } catch {
    return false;
  }
}

function executableForScript(filename: string): string | undefined {
  const extension = path.extname(filename).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(extension)) return process.execPath;
  if (!safeIsFile(filename)) return undefined;

  // Do not send native binaries named "opencode" to Node.
  let header: string;
  let fd: number | undefined;
  try {
    fd = openSync(filename, "r");
    const bytes = Buffer.alloc(256);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    header = bytes.subarray(0, count).toString("utf8").split("\n", 1)[0] ?? "";
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!header.startsWith("#!")) return undefined;
  if (/(\b|\/)bun(\s|$)/.test(header)) return "bun";
  if (/(\b|\/)node(\s|$)/.test(header)) return process.execPath;
  return undefined;
}

/**
 * Keep regular installed binaries untouched; allow a local OpenCode source
 * checkout/package directory to be used as the Binary Path setting.
 */
export function resolveOpenCodeLaunchSpec(binaryPath: string): OpenCodeLaunchSpec {
  const normalized = binaryPath.trim() || "opencode";
  let filename: string | undefined;
  if (safeIsDirectory(normalized)) {
    filename = [
      path.join(normalized, "packages", "opencode", "bin", "opencode"),
      path.join(normalized, "bin", "opencode"),
    ].find((candidate) => existsSync(candidate) && safeIsFile(candidate));
  } else if (safeIsFile(normalized)) {
    filename = normalized;
  }
  if (filename) {
    const executable = executableForScript(filename);
    if (executable) return { executable, args: [filename], displayBinaryPath: normalized };
  }
  return { executable: normalized, args: [], displayBinaryPath: normalized };
}

/**
 * Preserve the previous fork's explicit config injection, but do not erase an
 * existing user environment when no config was provided through the T3 UI.
 */
export function buildOpenCodeProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  configJsonc: string,
): NodeJS.ProcessEnv {
  const content = configJsonc.trim();
  return content ? { ...environment, OPENCODE_CONFIG_CONTENT: content } : environment;
}
