import { Effect, Layer } from "effect";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import { AzureDevOpsCli, type AzureDevOpsCliError } from "./AzureDevOpsCli.ts";
import { SourceControlProvider } from "./SourceControlProvider.ts";

function providerError(operation: string, cause: AzureDevOpsCliError): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "azure-devops",
    operation,
    detail: cause.detail,
    cause,
  });
}

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: "azure-devops",
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    updatedAt: summary.updatedAt,
    isCrossRepository: false,
  };
}

export const make = Effect.fn("makeAzureDevOpsSourceControlProvider")(function* () {
  const azure = yield* AzureDevOpsCli;

  return SourceControlProvider.of({
    kind: "azure-devops",
    listChangeRequests: (input) =>
      azure.listPullRequests(input).pipe(
        Effect.map((items) => items.map(toChangeRequest)),
        Effect.mapError((error) => providerError("listChangeRequests", error)),
      ),
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError((error) => providerError("getChangeRequest", error)),
      ),
    createChangeRequest: (input) =>
      azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(Effect.mapError((error) => providerError("createChangeRequest", error))),
    getRepositoryCloneUrls: (input) =>
      azure
        .getRepositoryCloneUrls(input)
        .pipe(Effect.mapError((error) => providerError("getRepositoryCloneUrls", error))),
    getDefaultBranch: (input) =>
      azure
        .getDefaultBranch({ cwd: input.cwd })
        .pipe(Effect.mapError((error) => providerError("getDefaultBranch", error))),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest(input)
        .pipe(Effect.mapError((error) => providerError("checkoutChangeRequest", error))),
  });
});

export const layer = Layer.effect(SourceControlProvider, make());
