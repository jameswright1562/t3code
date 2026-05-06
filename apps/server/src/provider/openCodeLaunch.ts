import { existsSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_OPENCODE_BINARY = "opencode";

export interface OpenCodeLaunchSpec {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly displayBinaryPath: string;
}

function trimmedBinaryPath(binaryPath: string): string {
  const trimmed = binaryPath.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OPENCODE_BINARY;
}

function safeStat(targetPath: string) {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

function resolveCheckoutScript(binaryPath: string): string | null {
  const stat = safeStat(binaryPath);
  if (stat?.isDirectory()) {
    const repoScript = path.join(binaryPath, "packages", "opencode", "bin", "opencode");
    if (existsSync(repoScript)) {
      return repoScript;
    }
    const packageScript = path.join(binaryPath, "bin", "opencode");
    if (existsSync(packageScript)) {
      return packageScript;
    }
    return null;
  }

  if (!stat?.isFile()) {
    return null;
  }

  const normalizedBase = path.basename(binaryPath).toLowerCase();
  if (
    normalizedBase === "opencode" ||
    normalizedBase === "opencode.js" ||
    normalizedBase === "opencode.cjs" ||
    normalizedBase === "opencode.mjs"
  ) {
    return binaryPath;
  }

  return null;
}

export function resolveOpenCodeLaunchSpec(binaryPath: string): OpenCodeLaunchSpec {
  const normalizedBinaryPath = trimmedBinaryPath(binaryPath);
  const checkoutScript = resolveCheckoutScript(normalizedBinaryPath);

  if (checkoutScript) {
    return {
      executable: process.execPath,
      args: [checkoutScript],
      displayBinaryPath: normalizedBinaryPath,
    };
  }

  return {
    executable: normalizedBinaryPath,
    args: [],
    displayBinaryPath: normalizedBinaryPath,
  };
}

export function buildOpenCodeProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  configJsonc: string,
): NodeJS.ProcessEnv {
  const trimmedConfig = configJsonc.trim();
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: trimmedConfig.length > 0 ? trimmedConfig : "{}",
  };
}
