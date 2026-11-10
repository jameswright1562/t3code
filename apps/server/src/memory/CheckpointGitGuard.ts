/**
 * Fail-closed Git safety check for a saved context checkpoint.
 * A matching HEAD is necessary but not sufficient to safely replay effects.
 */
export interface CheckpointGitInput {
  readonly savedHeadCommit: string | null;
  readonly currentHeadCommit: string | null;
  readonly savedBranch: string | null;
  readonly currentBranch: string | null;
  readonly hasWorkingTreeChanges: boolean;
  readonly unavailableReason?: string;
}
export interface CheckpointGitState {
  readonly status: "match" | "diverged" | "dirty" | "unverifiable";
  readonly reason: string;
  readonly savedHeadCommit: string | null;
  readonly currentHeadCommit: string | null;
  readonly savedBranch: string | null;
  readonly currentBranch: string | null;
}
export function assessCheckpointGit(input: CheckpointGitInput): CheckpointGitState {
  const values = {
    savedHeadCommit: input.savedHeadCommit,
    currentHeadCommit: input.currentHeadCommit,
    savedBranch: input.savedBranch,
    currentBranch: input.currentBranch,
  };
  if (!input.savedHeadCommit || !input.currentHeadCommit ||
      !input.savedBranch || !input.currentBranch) {
    return {
      ...values,
      status: "unverifiable",
      reason: input.unavailableReason ??
        "Saved or current Git identity is unavailable; manual review is required.",
    };
  }
  if (input.savedHeadCommit !== input.currentHeadCommit ||
      input.savedBranch !== input.currentBranch) {
    return {
      ...values,
      status: "diverged",
      reason: "Saved Git branch or commit differs from the current checkout. Do not replay writes.",
    };
  }
  if (input.hasWorkingTreeChanges) {
    return {
      ...values,
      status: "dirty",
      reason: "HEAD matches, but uncommitted files may differ. Inspect changes before resuming.",
    };
  }
  return {
    ...values,
    status: "match",
    reason: "Saved branch and HEAD match a clean checkout; side effects are not verified.",
  };
}
