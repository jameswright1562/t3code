import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AzureDevOpsCli } from "./AzureDevOpsCli.ts";
import { GitHubCli } from "./GitHubCli.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const processResult = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeRegistry(input: {
  readonly originUrl?: string | null;
  readonly remoteVerboseOutput?: string;
}) {
  const gitLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
    readConfigValue: (_cwd, key) =>
      key === "remote.origin.url" ? Effect.succeed(input.originUrl ?? null) : Effect.succeed(null),
    execute: () => Effect.succeed(processResult(input.remoteVerboseOutput ?? "")),
  });

  return SourceControlProviderRegistry.make().pipe(
    Effect.provide(
      Layer.mergeAll(gitLayer, Layer.mock(AzureDevOpsCli)({}), Layer.mock(GitHubCli)({})),
    ),
  );
}

it.effect("routes GitHub remotes to the GitHub provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      originUrl: "git@github.com:pingdotgg/t3code.git",
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "github");
  }),
);

it.effect(
  "detects GitLab remotes and returns an unsupported provider until one is registered",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({
        originUrl: "git@gitlab.com:group/project.git",
      });

      const provider = yield* registry.resolve({ cwd: "/repo" });

      assert.strictEqual(provider.kind, "gitlab");
      const error = yield* Effect.flip(
        provider.listChangeRequests({
          cwd: "/repo",
          headSelector: "feature/source-control",
          state: "open",
        }),
      );

      assert.strictEqual(error.provider, "gitlab");
    }),
);

it.effect("routes Azure DevOps remotes to the Azure DevOps provider", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      originUrl: "https://dev.azure.com/acme/project/_git/repo",
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);

it.effect("falls back to remote verbose output when origin is not configured", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry({
      originUrl: null,
      remoteVerboseOutput: [
        "upstream\thttps://dev.azure.com/acme/project/_git/repo (fetch)",
        "upstream\thttps://dev.azure.com/acme/project/_git/repo (push)",
      ].join("\n"),
    });

    const provider = yield* registry.resolve({ cwd: "/repo" });

    assert.strictEqual(provider.kind, "azure-devops");
  }),
);
