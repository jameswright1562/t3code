import { GitPullRequestIcon } from "lucide-react";
import type { ElementType } from "react";
import type { SourceControlProviderInfo } from "@t3tools/contracts";

import { AzureDevOpsIcon, GitHubIcon, GitLabIcon } from "./components/Icons";
import {
  DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  getChangeRequestTerminology,
  type ChangeRequestTerminology,
} from "./sourceControlTerms";

export type { ChangeRequestTerminology };

export interface SourceControlPresentation {
  providerName: string;
  terminology: ChangeRequestTerminology;
  Icon: ElementType<{ className?: string }>;
}

const DEFAULT_PRESENTATION: SourceControlPresentation = {
  providerName: "source control",
  terminology: DEFAULT_CHANGE_REQUEST_TERMINOLOGY,
  Icon: GitPullRequestIcon,
};

export function getSourceControlPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): SourceControlPresentation {
  switch (provider?.kind) {
    case "github":
      return {
        providerName: provider.name || "GitHub",
        terminology: getChangeRequestTerminology(provider),
        Icon: GitHubIcon,
      };
    case "gitlab":
      return {
        providerName: provider.name || "GitLab",
        terminology: getChangeRequestTerminology(provider),
        Icon: GitLabIcon,
      };
    case "azure-devops":
      return {
        providerName: provider.name || "Azure DevOps",
        terminology: getChangeRequestTerminology(provider),
        Icon: AzureDevOpsIcon,
      };
    default:
      return DEFAULT_PRESENTATION;
  }
}
