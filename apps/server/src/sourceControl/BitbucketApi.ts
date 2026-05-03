import { Config, Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import {
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import {
  BitbucketPullRequestListSchema,
  BitbucketPullRequestSchema,
  normalizeBitbucketPullRequestRecord,
  type NormalizedBitbucketPullRequestRecord,
} from "./bitbucketPullRequests.ts";
import type {
  SourceControlProviderContext,
  SourceControlRefSelector,
} from "./SourceControlProvider.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

const DEFAULT_API_BASE_URL = "https://api.bitbucket.org/2.0";

const BitbucketApiEnvConfig = Config.all({
  baseUrl: Config.string("T3CODE_BITBUCKET_API_BASE_URL").pipe(
    Config.withDefault(DEFAULT_API_BASE_URL),
  ),
  accessToken: Config.string("T3CODE_BITBUCKET_ACCESS_TOKEN").pipe(Config.option),
  email: Config.string("T3CODE_BITBUCKET_EMAIL").pipe(Config.option),
  apiToken: Config.string("T3CODE_BITBUCKET_API_TOKEN").pipe(Config.option),
});

export class BitbucketApiError extends Schema.TaggedErrorClass<BitbucketApiError>()(
  "BitbucketApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
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

const BitbucketUserSchema = Schema.Struct({
  username: Schema.optional(TrimmedNonEmptyString),
  display_name: Schema.optional(TrimmedNonEmptyString),
  account_id: Schema.optional(TrimmedNonEmptyString),
});

export interface BitbucketRepositoryLocator {
  readonly workspace: string;
  readonly repoSlug: string;
}

export interface BitbucketApiShape {
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
  readonly listPullRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
    readonly state: "open" | "closed" | "merged" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<NormalizedBitbucketPullRequestRecord>, BitbucketApiError>;
  readonly getPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketApiError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketApiError>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly baseBranch: string;
    readonly headSelector: string;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, BitbucketApiError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<string | null, BitbucketApiError>;
  readonly checkoutPullRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, BitbucketApiError>;
}

export class BitbucketApi extends Context.Service<BitbucketApi, BitbucketApiShape>()(
  "t3/source-control/BitbucketApi",
) {}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
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

function sourceWorkspace(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  const ownerSelector = /^([^:/\s]+):(.+)$/u.exec(input.headSelector.trim());
  return ownerSelector?.[1]?.trim();
}

function toBitbucketState(state: "open" | "closed" | "merged" | "all"): string | null {
  switch (state) {
    case "open":
      return "OPEN";
    case "closed":
      return "DECLINED";
    case "merged":
      return "MERGED";
    case "all":
      return null;
  }
}

function parseBitbucketRepositorySlug(value: string): BitbucketRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return null;
  const workspace = parts.at(-2);
  const repoSlug = parts.at(-1);
  return workspace && repoSlug ? { workspace, repoSlug } : null;
}

function parseBitbucketRemoteUrl(remoteUrl: string): BitbucketRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.startsWith("git@")) {
    const pathStart = trimmed.indexOf(":");
    return pathStart < 0 ? null : parseBitbucketRepositorySlug(trimmed.slice(pathStart + 1));
  }

  try {
    return parseBitbucketRepositorySlug(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawBitbucketRepositorySchema>,
): SourceControlRepositoryCloneUrls {
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

function authFromConfig(
  config: Config.Success<typeof BitbucketApiEnvConfig>,
): SourceControlProviderAuth {
  if (Option.isSome(config.accessToken)) {
    return {
      status: "unknown",
      account: Option.none(),
      host: Option.some("bitbucket.org"),
      detail: Option.some("Bitbucket access token is configured."),
    };
  }

  if (Option.isSome(config.email) && Option.isSome(config.apiToken)) {
    return {
      status: "unknown",
      account: config.email,
      host: Option.some("bitbucket.org"),
      detail: Option.some("Bitbucket API token is configured."),
    };
  }

  return {
    status: "unauthenticated",
    account: Option.none(),
    host: Option.some("bitbucket.org"),
    detail: Option.some(
      "Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN, or T3CODE_BITBUCKET_ACCESS_TOKEN.",
    ),
  };
}

function requestError(operation: string, cause: unknown): BitbucketApiError {
  return new BitbucketApiError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function responseError(
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, BitbucketApiError> {
  return response.text.pipe(
    Effect.catch(() => Effect.succeed("")),
    Effect.flatMap((body) =>
      Effect.fail(
        new BitbucketApiError({
          operation,
          status: response.status,
          detail:
            body.trim().length > 0
              ? `Bitbucket returned HTTP ${response.status}: ${body.trim()}`
              : `Bitbucket returned HTTP ${response.status}.`,
        }),
      ),
    ),
  );
}

export const make = Effect.fn("makeBitbucketApi")(function* () {
  const config = yield* BitbucketApiEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsRegistry = yield* VcsDriverRegistry;

  const apiUrl = (path: string) => `${config.baseUrl.replace(/\/+$/u, "")}${path}`;

  const withAuth = (request: HttpClientRequest.HttpClientRequest) => {
    if (Option.isSome(config.accessToken)) {
      return request.pipe(HttpClientRequest.bearerToken(config.accessToken.value));
    }
    if (Option.isSome(config.email) && Option.isSome(config.apiToken)) {
      return request.pipe(HttpClientRequest.basicAuth(config.email.value, config.apiToken.value));
    }
    return request;
  };

  const decodeResponse = <S extends Schema.Top>(
    operation: string,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(schema)(success).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketApiError({
                operation,
                detail: "Bitbucket returned invalid JSON for the requested resource.",
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], BitbucketApiError, S["DecodingServices"]> =>
    httpClient.execute(withAuth(request.pipe(HttpClientRequest.acceptJson))).pipe(
      Effect.mapError((cause) => requestError(operation, cause)),
      Effect.flatMap((response) => decodeResponse(operation, schema, response)),
    );

  const resolveRepository = Effect.fn("BitbucketApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository?: string;
  }) {
    const fromRepository =
      input.repository !== undefined ? parseBitbucketRepositorySlug(input.repository) : null;
    if (fromRepository) return fromRepository;

    const fromContext =
      input.context?.provider.kind === "bitbucket"
        ? parseBitbucketRemoteUrl(input.context.remoteUrl)
        : null;
    if (fromContext) return fromContext;

    const handle = yield* vcsRegistry.resolve({ cwd: input.cwd }).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketApiError({
            operation: "resolveRepository",
            detail: `Failed to resolve VCS repository for ${input.cwd}.`,
            cause,
          }),
      ),
    );
    const remotes = yield* handle.driver.listRemotes(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new BitbucketApiError({
            operation: "resolveRepository",
            detail: `Failed to list remotes for ${input.cwd}.`,
            cause,
          }),
      ),
    );

    for (const remote of remotes.remotes) {
      if (detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== "bitbucket") continue;
      const parsed = parseBitbucketRemoteUrl(remote.url);
      if (parsed) return parsed;
    }

    return yield* new BitbucketApiError({
      operation: "resolveRepository",
      detail: `No Bitbucket repository remote was detected for ${input.cwd}.`,
    });
  });

  const getRepository = (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository?: string;
  }) =>
    resolveRepository(input).pipe(
      Effect.flatMap((repository) =>
        executeJson(
          "getRepository",
          HttpClientRequest.get(
            apiUrl(
              `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}`,
            ),
          ),
          RawBitbucketRepositorySchema,
        ),
      ),
    );

  return BitbucketApi.of({
    probeAuth: executeJson(
      "probeAuth",
      HttpClientRequest.get(apiUrl("/user")),
      BitbucketUserSchema,
    ).pipe(
      Effect.map((user) => ({
        status: "authenticated" as const,
        account: nonEmpty(user.username ?? user.display_name ?? user.account_id),
        host: Option.some("bitbucket.org"),
        detail: Option.none<string>(),
      })),
      Effect.catch(() => Effect.succeed(authFromConfig(config))),
    ),
    listPullRequests: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) => {
          const state = toBitbucketState(input.state);
          const query: Record<string, string> = {
            pagelen: String(Math.max(1, Math.min(input.limit ?? 20, 50))),
            sort: "-updated_on",
            q: `source.branch.name = "${sourceBranch(input).replaceAll('"', '\\"')}"`,
          };
          if (state !== null) {
            query.state = state;
          }

          return executeJson(
            "listPullRequests",
            HttpClientRequest.get(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
              ),
              { urlParams: query },
            ),
            BitbucketPullRequestListSchema,
          );
        }),
        Effect.map((list) => list.values.map(normalizeBitbucketPullRequestRecord)),
      ),
    getPullRequest: (input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "getPullRequest",
            HttpClientRequest.get(
              apiUrl(
                `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests/${encodeURIComponent(normalizeChangeRequestId(input.reference))}`,
              ),
            ),
            BitbucketPullRequestSchema,
          ),
        ),
        Effect.map(normalizeBitbucketPullRequestRecord),
      ),
    getRepositoryCloneUrls: (input) =>
      getRepository(input).pipe(Effect.map(normalizeRepositoryCloneUrls)),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketApiError({
                operation: "createPullRequest",
                detail: `Failed to read pull request body file ${input.bodyFile}.`,
                cause,
              }),
          ),
        );
        const sourceOwner = sourceWorkspace(input);
        const body = {
          title: input.title,
          description,
          source: {
            branch: {
              name: sourceBranch(input),
            },
            ...(sourceOwner
              ? {
                  repository: {
                    full_name: `${sourceOwner}/${input.source?.repository ?? repository.repoSlug}`,
                  },
                }
              : {}),
          },
          destination: {
            branch: {
              name: input.target?.refName ?? input.baseBranch,
            },
          },
        };

        yield* executeJson(
          "createPullRequest",
          HttpClientRequest.post(
            apiUrl(
              `/repositories/${encodeURIComponent(repository.workspace)}/${encodeURIComponent(repository.repoSlug)}/pullrequests`,
            ),
          ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          BitbucketPullRequestSchema,
        );
      }),
    getDefaultBranch: (input) =>
      getRepository(input).pipe(Effect.map((repository) => repository.mainbranch?.name ?? null)),
    checkoutPullRequest: () =>
      Effect.fail(
        new BitbucketApiError({
          operation: "checkoutPullRequest",
          detail:
            "Bitbucket Cloud does not provide an official CLI checkout command. Add VCS-level checkout support for Bitbucket pull request refs before enabling this action.",
        }),
      ),
  });
});

export const layer = Layer.effect(BitbucketApi, make());
