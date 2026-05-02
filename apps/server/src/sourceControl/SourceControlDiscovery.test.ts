import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessSpawnError } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { SourceControlDiscovery, layer } from "./SourceControlDiscovery.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

it.effect("reports implemented tools separately from locally available CLIs", () => {
  const testLayer = layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-control-discovery-" }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git") {
            return Effect.succeed(processOutput("git version 2.51.0\n"));
          }
          if (input.command === "gh") {
            return Effect.succeed(processOutput("gh version 2.83.0\n"));
          }
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: new Error(`${input.command} not found`),
            }),
          );
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
        { kind: "sapling", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "github", implemented: true, status: "available" },
        { kind: "gitlab", implemented: false, status: "missing" },
        { kind: "azure-devops", implemented: true, status: "missing" },
        { kind: "bitbucket", implemented: false, status: "missing" },
      ],
    );
  }).pipe(Effect.provide(testLayer));
});
