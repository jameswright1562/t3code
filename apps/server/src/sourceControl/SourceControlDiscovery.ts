import {
  type SourceControlDiscoveryResult,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderKind,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
};

type ProviderProbe = DiscoveryProbe & {
  readonly kind: SourceControlProviderKind;
};

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  {
    kind: "jj",
    label: "Jujutsu",
    executable: "jj",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  },
  {
    kind: "sapling",
    label: "Sapling",
    executable: "sl",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Sapling (`sl`) from https://sapling-scm.com/.",
  },
];

const SOURCE_CONTROL_PROVIDER_PROBES: ReadonlyArray<ProviderProbe> = [
  {
    kind: "github",
    label: "GitHub",
    executable: "gh",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install GitHub CLI with `brew install gh` or from https://cli.github.com/.",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    executable: "glab",
    versionArgs: ["--version"],
    implemented: false,
    installHint:
      "Install GitLab CLI with `brew install glab` or from https://gitlab.com/gitlab-org/cli.",
  },
  {
    kind: "azure-devops",
    label: "Azure DevOps",
    executable: "az",
    versionArgs: ["--version"],
    implemented: true,
    installHint:
      "Install Azure CLI with `brew install azure-cli`, then add Azure DevOps support with `az extension add --name azure-devops`.",
  },
  {
    kind: "bitbucket",
    label: "Bitbucket",
    executable: "bb",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install a Bitbucket CLI (`bb`) and authenticate it for your Bitbucket workspace.",
  },
];

function firstNonEmptyLine(text: string): Option.Option<string> {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? Option.none() : Option.some(line);
}

function detailFromCause(cause: unknown): Option.Option<string> {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return Option.some(cause.message.trim());
  }
  return Option.none();
}

export interface SourceControlDiscoveryShape {
  readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
}

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  SourceControlDiscoveryShape
>()("t3/source-control/SourceControlDiscovery") {}

export const layer = Layer.effect(
  SourceControlDiscovery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const process = yield* VcsProcess.VcsProcess;

    const probe = <Kind extends VcsDriverKind | SourceControlProviderKind>(
      input: DiscoveryProbe & { readonly kind: Kind },
    ) =>
      process
        .run({
          operation: "source-control.discovery.probe",
          command: input.executable,
          args: input.versionArgs,
          cwd: config.cwd,
          timeoutMs: 5_000,
          maxOutputBytes: 8_000,
          truncateOutputAtMaxBytes: true,
        })
        .pipe(
          Effect.map((result) => ({
            kind: input.kind,
            label: input.label,
            executable: input.executable,
            implemented: input.implemented,
            status: "available" as const,
            version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
              firstNonEmptyLine(result.stderr),
            ),
            installHint: input.installHint,
            detail: Option.none<string>(),
          })),
          Effect.catch((cause) =>
            Effect.succeed({
              kind: input.kind,
              label: input.label,
              executable: input.executable,
              implemented: input.implemented,
              status: "missing" as const,
              version: Option.none<string>(),
              installHint: input.installHint,
              detail: detailFromCause(cause),
            }),
          ),
        );

    return SourceControlDiscovery.of({
      discover: Effect.all({
        versionControlSystems: Effect.all(
          VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
          { concurrency: "unbounded" },
        ),
        sourceControlProviders: Effect.all(
          SOURCE_CONTROL_PROVIDER_PROBES.map((entry) => probe(entry)) as ReadonlyArray<
            Effect.Effect<SourceControlProviderDiscoveryItem>
          >,
          { concurrency: "unbounded" },
        ),
      }),
    });
  }),
);
