import type { SourceControlProviderInfo } from "@t3tools/contracts";

export interface ChangeRequestTerminology {
  shortLabel: string;
  singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (provider?.kind === "gitlab") {
    return {
      shortLabel: "MR",
      singular: "merge request",
    };
  }
  return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
}
