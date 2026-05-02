export interface OwnerBranch {
  readonly owner: string;
  readonly refName: string;
}

const OWNER_BRANCH_RE = /^([^:/\s]+):(.+)$/u;

export function parseOwnerBranch(headSelector: string): OwnerBranch | null {
  const match = OWNER_BRANCH_RE.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : null;
}
