import { Cache, Context, Duration, Effect, Exit, Layer } from "effect";
import { SourceControlProviderError } from "@t3tools/contracts";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";

import { SourceControlProvider, type SourceControlProviderShape } from "./SourceControlProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

export interface SourceControlProviderRegistryShape {
  readonly resolve: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderShape, SourceControlProviderError>;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("t3/source-control/SourceControlProviderRegistry") {}

function unsupportedProvider(kind: SourceControlProviderKind): SourceControlProviderShape {
  const unsupported = (operation: string) =>
    Effect.fail(
      new SourceControlProviderError({
        provider: kind,
        operation,
        detail: `No ${kind} source control provider is registered.`,
      }),
    );

  return SourceControlProvider.of({
    kind,
    listChangeRequests: () => unsupported("listChangeRequests"),
    getChangeRequest: () => unsupported("getChangeRequest"),
    createChangeRequest: () => unsupported("createChangeRequest"),
    getRepositoryCloneUrls: () => unsupported("getRepositoryCloneUrls"),
    getDefaultBranch: () => unsupported("getDefaultBranch"),
    checkoutChangeRequest: () => unsupported("checkoutChangeRequest"),
  });
}

function providerDetectionError(operation: string, cwd: string, cause: unknown) {
  return new SourceControlProviderError({
    provider: "unknown",
    operation,
    detail: `Failed to detect source control provider for ${cwd}.`,
    cause,
  });
}

function firstRemoteUrlFromVerboseOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const match = /^\S+\s+(\S+)\s+\((?:fetch|push)\)$/.exec(trimmed);
    const remoteUrl = match?.[1]?.trim() ?? "";
    if (remoteUrl.length > 0) {
      return remoteUrl;
    }
  }
  return null;
}

export const make = Effect.fn("makeSourceControlProviderRegistry")(function* () {
  const github = yield* GitHubSourceControlProvider.make();
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make();
  const git = yield* GitVcsDriver.GitVcsDriver;
  const providers: Partial<Record<SourceControlProviderKind, SourceControlProviderShape>> = {
    "azure-devops": azureDevOps,
    github,
  };

  const detectProviderKind = Effect.fn("SourceControlProviderRegistry.detectProviderKind")(
    function* (cwd: string) {
      const originUrl = yield* git
        .readConfigValue(cwd, "remote.origin.url")
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const remoteUrl =
        originUrl ??
        (yield* git
          .execute({
            operation: "SourceControlProviderRegistry.detectProvider.remoteVerbose",
            cwd,
            args: ["remote", "-v"],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? firstRemoteUrlFromVerboseOutput(result.stdout) : null,
            ),
            Effect.mapError((error) => providerDetectionError("detectProvider", cwd, error)),
          ));

      if (!remoteUrl) {
        return "unknown" as const;
      }

      return detectSourceControlProviderFromGitRemoteUrl(remoteUrl)?.kind ?? "unknown";
    },
  );

  const providerKindCache = yield* Cache.makeWith<
    string,
    SourceControlProviderKind,
    SourceControlProviderError
  >(detectProviderKind, {
    capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
  });

  return SourceControlProviderRegistry.of({
    resolve: (input) =>
      Cache.get(providerKindCache, input.cwd).pipe(
        Effect.map((kind) => providers[kind] ?? unsupportedProvider(kind)),
      ),
  });
});

export const layer = Layer.effect(SourceControlProviderRegistry, make());
