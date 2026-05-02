import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, vi } from "vitest";
import type { VcsError } from "@t3tools/contracts";

import { VcsProcess, type VcsProcessInput, type VcsProcessOutput } from "../vcs/VcsProcess.ts";
import * as BitbucketCli from "./BitbucketCli.ts";

const processOutput = (stdout: string): VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<(input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>>();

const layer = BitbucketCli.layer.pipe(
  Layer.provide(
    Layer.mock(VcsProcess)({
      run: mockRun,
    }),
  ),
);

afterEach(() => {
  mockRun.mockReset();
});

describe("BitbucketCli.layer", () => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              id: 42,
              title: "Add Bitbucket provider",
              state: "OPEN",
              updated_on: "2026-01-02T00:00:00.000Z",
              links: {
                html: {
                  href: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
                },
              },
              source: {
                branch: { name: "feature/source-control" },
                repository: {
                  full_name: "octocat/t3code",
                  workspace: { slug: "octocat" },
                },
              },
              destination: {
                branch: { name: "main" },
                repository: {
                  full_name: "pingdotgg/t3code",
                  workspace: { slug: "pingdotgg" },
                },
              },
            }),
          ),
        ),
      );

      const bb = yield* BitbucketCli.BitbucketCli;
      const result = yield* bb.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add Bitbucket provider",
        url: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
        baseRefName: "main",
        headRefName: "feature/source-control",
        state: "open",
        updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/t3code",
        headRepositoryOwnerLogin: "octocat",
      });
      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "BitbucketCli.execute",
        command: "bb",
        args: ["pr", "view", "42", "--json"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists pull requests with Bitbucket state and source branch arguments", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              values: [
                {
                  id: 7,
                  title: "Merged work",
                  state: "MERGED",
                  links: {
                    html: {
                      href: "https://bitbucket.org/pingdotgg/t3code/pull-requests/7",
                    },
                  },
                  source: {
                    branch: { name: "feature/merged" },
                    repository: { full_name: "pingdotgg/t3code" },
                  },
                  destination: {
                    branch: { name: "main" },
                    repository: { full_name: "pingdotgg/t3code" },
                  },
                },
              ],
            }),
          ),
        ),
      );

      const bb = yield* BitbucketCli.BitbucketCli;
      const result = yield* bb.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        state: "merged",
        limit: 10,
      });

      assert.strictEqual(result[0]?.state, "merged");
      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "BitbucketCli.execute",
        command: "bb",
        args: [
          "pr",
          "list",
          "--head",
          "feature/merged",
          "--state",
          "merged",
          "--limit",
          "10",
          "--json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs and default branch", () =>
    Effect.gen(function* () {
      const repositoryJson = JSON.stringify({
        full_name: "pingdotgg/t3code",
        links: {
          html: { href: "https://bitbucket.org/pingdotgg/t3code" },
          clone: [
            { name: "https", href: "https://bitbucket.org/pingdotgg/t3code.git" },
            { name: "ssh", href: "git@bitbucket.org:pingdotgg/t3code.git" },
          ],
        },
        mainbranch: { name: "main" },
      });
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput(repositoryJson)));
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput(repositoryJson)));

      const bb = yield* BitbucketCli.BitbucketCli;
      const cloneUrls = yield* bb.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "pingdotgg/t3code",
      });
      const defaultBranch = yield* bb.getDefaultBranch({ cwd: "/repo" });

      assert.deepStrictEqual(cloneUrls, {
        nameWithOwner: "pingdotgg/t3code",
        url: "https://bitbucket.org/pingdotgg/t3code.git",
        sshUrl: "git@bitbucket.org:pingdotgg/t3code.git",
      });
      assert.strictEqual(defaultBranch, "main");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests using provider-neutral branch names", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const bb = yield* BitbucketCli.BitbucketCli;
      yield* bb.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "owner:feature/provider",
        title: "Provider PR",
        bodyFile: "/tmp/body.md",
      });

      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "BitbucketCli.execute",
        command: "bb",
        args: [
          "pr",
          "create",
          "--destination",
          "main",
          "--source",
          "feature/provider",
          "--title",
          "Provider PR",
          "--body-file",
          "/tmp/body.md",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("passes --force when checking out pull requests with force enabled", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const bb = yield* BitbucketCli.BitbucketCli;
      yield* bb.checkoutPullRequest({
        cwd: "/repo",
        reference: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
        force: true,
      });

      assert.deepStrictEqual(mockRun.mock.calls[0]?.[0], {
        operation: "BitbucketCli.execute",
        command: "bb",
        args: ["pr", "checkout", "42", "--force"],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );
});
