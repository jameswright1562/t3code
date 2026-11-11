/**
 * Hard per-thread provider-start budget. Checked before a native session is
 * opened, including resumed/restarted runs. Zero means explicitly disabled.
 * It does not claim to count native subagent turns within a single provider run.
 */
export function evaluateThreadRunBudget(input: {
  readonly runOrdinal: number;
  readonly maxRuns: number;
}): { readonly allowed: true; readonly reason: "" } |
  { readonly allowed: false; readonly reason: string } {
  const { runOrdinal, maxRuns } = input;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 0 || maxRuns > 1000 ||
      !Number.isSafeInteger(runOrdinal) || runOrdinal < 1) {
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
