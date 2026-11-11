import { describe, expect, it } from "@effect/vitest";
import { assessCheckpointGit } from "./CheckpointGitGuard.ts";

const base = {
  savedHeadCommit: "abc123",
  currentHeadCommit: "abc123",
  savedBranch: "task/my-work",
  currentBranch: "task/my-work",
  hasWorkingTreeChanges: false,
};

describe("checkpoint Git recovery guard", () => {
  it("matches only a clean identical checkout", () => {
    expect(assessCheckpointGit(base).status).toBe("match");
  });
  it("detects changed HEAD or branch", () => {
    expect(assessCheckpointGit({ ...base, currentHeadCommit: "different" }).status).toBe(
      "diverged",
    );
    expect(assessCheckpointGit({ ...base, currentBranch: "main" }).status).toBe("diverged");
  });
  it("rejects dirty worktrees and unknown historical checkpoint identity", () => {
    expect(assessCheckpointGit({ ...base, hasWorkingTreeChanges: true }).status).toBe("dirty");
    expect(assessCheckpointGit({ ...base, savedHeadCommit: null }).status).toBe("unverifiable");
    expect(assessCheckpointGit({ ...base, currentHeadCommit: null }).status).toBe("unverifiable");
  });
});
