import type { SourceControlProviderInfo } from "@t3tools/contracts";

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    if (separatorIndex <= 0) {
      return null;
    }
    return hostWithPath.slice(0, separatorIndex).toLowerCase();
  }

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || host.includes("gitlab");
}

function isAzureDevOpsHost(host: string): boolean {
  return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || host.includes("bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }

  if (isGitHubHost(host)) {
    return {
      kind: "github",
      name: host === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isGitLabHost(host)) {
    return {
      kind: "gitlab",
      name: host === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isAzureDevOpsHost(host)) {
    return {
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isBitbucketHost(host)) {
    return {
      kind: "bitbucket",
      name: host === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: "unknown",
    name: host,
    baseUrl: toBaseUrl(host),
  };
}
