/**
 * Hard per-thread provider-start budget. Checked before a native session is
 * opened, including resumed/restarted runs. Zero means explicitly disabled.
 * It does not claim to count native subagent turns within a single provider run.
 */
export function evaluateThreadRunBudget(input: {
  readonly runOrdinal: number;
  readonly maxRuns: number;
}):
  | { readonly allowed: true; readonly reason: "" }
  | { readonly allowed: false; readonly reason: string } {
  const { runOrdinal, maxRuns } = input;
  if (
    !Number.isSafeInteger(maxRuns) ||
    maxRuns < 0 ||
    maxRuns > 1000 ||
    !Number.isSafeInteger(runOrdinal) ||
    runOrdinal < 1
  ) {
    return { allowed: false, reason: "Invalid per-thread run budget configuration." };
  }
  if (maxRuns !== 0 && runOrdinal > maxRuns) {
    return {
      allowed: false,
      reason: `Thread run limit of ${maxRuns} reached. Increase or disable the limit under Settings → Agent run budgets before retrying.`,
    };
  }
  return { allowed: true, reason: "" };
}

/**
 * Fail-closed limit for directly app-owned, nonterminal delegated children of
 * one active parent run. Check under the parent's command dispatch lock before
 * emitting any child thread or side-effect. Provider-native descendants are
 * not observable here and require a separate supervision gate.
 */
export function evaluateDelegatedChildBudget(input: {
  readonly activeChildren: number;
  readonly maxConcurrentChildren: number;
}):
  | { readonly allowed: true; readonly reason: "" }
  | { readonly allowed: false; readonly reason: string } {
  const { activeChildren, maxConcurrentChildren } = input;
  if (
    !Number.isSafeInteger(activeChildren) ||
    activeChildren < 0 ||
    !Number.isSafeInteger(maxConcurrentChildren) ||
    maxConcurrentChildren < 1 ||
    maxConcurrentChildren > 32
  ) {
    return { allowed: false, reason: "Invalid delegated child concurrency budget." };
  }
  if (activeChildren >= maxConcurrentChildren) {
    return {
      allowed: false,
      reason: `Delegated child limit of ${maxConcurrentChildren} reached for this run. Wait for a child to finish or change Agent run budgets in Settings.`,
    };
  }
  return { allowed: true, reason: "" };
}
