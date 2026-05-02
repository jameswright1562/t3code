import { Context, Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import { TrimmedNonEmptyString, type VcsError } from "@t3tools/contracts";

import { VcsProcess, type VcsProcessOutput } from "../vcs/VcsProcess.ts";
import {
  decodeBitbucketPullRequestJson,
  decodeBitbucketPullRequestListJson,
  formatBitbucketJsonDecodeError,
  type NormalizedBitbucketPullRequestRecord,
} from "./bitbucketPullRequests.ts";
import type { SourceControlRefSelector } from "./SourceControlProvider.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export class BitbucketCliError extends Schema.TaggedErrorClass<BitbucketCliError>()(
  "BitbucketCliError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Bitbucket CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export interface BitbucketRepositoryCloneUrls {
  readonly nameWithOwner: string;
  readonly url: string;
  readonly sshUrl: string;
}

export interface BitbucketCliShape {
  readonly execute: (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
  }) => Effect.Effect<VcsProcessOutput, BitbucketCliError>;

  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedBitbucketPullRequestRecord>, BitbucketCliError>;

  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketCliError>;

  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<BitbucketRepositoryCloneUrls, BitbucketCliError>;

  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, BitbucketCliError>;

  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, BitbucketCliError>;

  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, BitbucketCliError>;
}

export class BitbucketCli extends Context.Service<BitbucketCli, BitbucketCliShape>()(
  "t3/source-control/BitbucketCli",
) {}

function errorText(error: VcsError | unknown): string {
  if (typeof error === "object" && error !== null) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "";
    const detail = "detail" in error && typeof error.detail === "string" ? error.detail : "";
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return [tag, detail, message].filter(Boolean).join("\n");
  }

  return String(error);
}

function normalizeBitbucketCliError(
  operation: "execute",
  error: VcsError | unknown,
): BitbucketCliError {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes("command not found: bb") || lower.includes("enoent")) {
    return new BitbucketCliError({
      operation,
      detail:
        "Bitbucket CLI (`bb`) is required but not available on PATH. Install a gh-style Bitbucket CLI and retry.",
      cause: error,
    });
  }

  if (
    lower.includes("bb auth login") ||
    lower.includes("not logged in") ||
    lower.includes("authentication failed") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return new BitbucketCliError({
      operation,
      detail: "Bitbucket CLI is not authenticated. Run `bb auth login` and retry.",
      cause: error,
    });
  }

  if (lower.includes("pull request") && lower.includes("not found")) {
    return new BitbucketCliError({
      operation,
      detail: "Pull request not found. Check the PR number or URL and try again.",
      cause: error,
    });
  }

  return new BitbucketCliError({
    operation,
    detail: text,
    cause: error,
  });
}

function normalizeChangeRequestId(reference: string): string {
  const trimmed = reference.trim().replace(/^#/, "");
  const urlMatch = /(?:pull-requests|pullrequests|pull-request|pull|pr)\/(\d+)(?:\D.*)?$/i.exec(
    trimmed,
  );
  return urlMatch?.[1] ?? trimmed;
}

function normalizeSourceBranch(headSelector: string): string {
  const trimmed = headSelector.trim();
  const ownerSelector = /^([^:/\s]+):(.+)$/u.exec(trimmed);
  return ownerSelector?.[2]?.trim() ?? trimmed;
}

function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

function toBitbucketState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "open";
    case "closed":
      return "declined";
    case "merged":
      return "merged";
    case "all":
      return "all";
  }
}

const RawBitbucketRepositorySchema = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  links: Schema.Struct({
    html: Schema.optional(
      Schema.Struct({
        href: TrimmedNonEmptyString,
      }),
    ),
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
  mainbranch: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: TrimmedNonEmptyString,
      }),
    ),
  ),
});

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawBitbucketRepositorySchema>,
): BitbucketRepositoryCloneUrls {
  const httpClone =
    raw.links.clone?.find((entry) => entry.name.toLowerCase() === "https")?.href ??
    raw.links.html?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;

  return {
    nameWithOwner: raw.full_name,
    url: httpClone ?? raw.links.html?.href ?? raw.full_name,
    sshUrl: sshClone ?? httpClone ?? raw.full_name,
  };
}

function decodeBitbucketJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: "getRepositoryCloneUrls" | "getDefaultBranch",
  invalidDetail: string,
): Effect.Effect<S["Type"], BitbucketCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new BitbucketCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

export const make = Effect.fn("makeBitbucketCli")(function* () {
  const process = yield* VcsProcess;

  const execute: BitbucketCliShape["execute"] = (input) =>
    process
      .run({
        operation: "BitbucketCli.execute",
        command: "bb",
        args: input.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      .pipe(Effect.mapError((error) => normalizeBitbucketCliError("execute", error)));

  return BitbucketCli.of({
    execute,
    listPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          sourceBranch(input),
          "--state",
          toBitbucketState(input.state),
          "--limit",
          String(input.limit ?? 20),
          "--json",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeBitbucketPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new BitbucketCliError({
                        operation: "listPullRequests",
                        detail: `Bitbucket CLI returned invalid PR list JSON: ${formatBitbucketJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "view", normalizeChangeRequestId(input.reference), "--json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          Effect.sync(() => decodeBitbucketPullRequestJson(raw)).pipe(
            Effect.flatMap((decoded) => {
              if (!Result.isSuccess(decoded)) {
                return Effect.fail(
                  new BitbucketCliError({
                    operation: "getPullRequest",
                    detail: `Bitbucket CLI returned invalid pull request JSON: ${formatBitbucketJsonDecodeError(decoded.failure)}`,
                    cause: decoded.failure,
                  }),
                );
              }

              return Effect.succeed(decoded.success);
            }),
          ),
        ),
      ),
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeBitbucketJson(
            raw,
            RawBitbucketRepositorySchema,
            "getRepositoryCloneUrls",
            "Bitbucket CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--destination",
          input.target?.refName ?? input.baseBranch,
          "--source",
          sourceBranch(input),
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeBitbucketJson(
            raw,
            RawBitbucketRepositorySchema,
            "getDefaultBranch",
            "Bitbucket CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map((repository) => repository.mainbranch?.name ?? null),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "checkout",
          normalizeChangeRequestId(input.reference),
          ...(input.force ? ["--force"] : []),
        ],
      }).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(BitbucketCli, make());
