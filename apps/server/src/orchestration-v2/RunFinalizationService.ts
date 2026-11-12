import { CheckpointScopeId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { listMemory, saveCheckpoint } from "../memory/AgentMemory.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import { checkpointHarnessPlan } from "./HarnessPlan.ts";
import { listActiveCheckoutLeases, releaseCheckoutLease } from "./HarnessCheckoutLease.ts";
import { readHarnessPlan, settleNativeHarnessStep } from "./HarnessPlanStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class RunFinalizationError extends Schema.TaggedError<RunFinalizationError>()(
  "RunFinalizationError",
  {
    threadId: ThreadId,
    runId: RunId,
    scopeId: CheckpointScopeId,
    operation: Schema.Literals(["capture-checkpoint", "refresh-workspace"]),
    cause: Schema.Defect(),
  },
) {}

export class RunFinalizationRefreshError extends Schema.TaggedError<RunFinalizationRefreshError>()(
  "RunFinalizationRefreshError",
  { cwd: Schema.String, cause: Schema.Defect() },
) {}

export class RunFinalizationObserver extends Context.Reference<{
  readonly refreshAfterTurn: (projectId: ProjectId) => Effect.Effect<void>;
  readonly refresh: (input: {
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, RunFinalizationRefreshError>;
}>("t3/orchestration-v2/RunFinalizationObserver", {
  defaultValue: () => ({ refresh: () => Effect.void, refreshAfterTurn: () => Effect.void }),
}) {}

export class RunFinalizationService extends Context.Service<
  RunFinalizationService,
  {
    readonly finalize: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly scopeId: CheckpointScopeId;
    }) => Effect.Effect<void, RunFinalizationError>;
  }
>()("t3/orchestration-v2/RunFinalizationService") {}

const make = Effect.gen(function* () {
  const checkpointCapture = yield* CheckpointCapture.CheckpointCaptureServiceV2;
  const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
  const fileSystemOption = yield* Effect.serviceOption(FileSystem.FileSystem);
  const gitOption = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const observer = yield* RunFinalizationObserver;

  const finalize: RunFinalizationService["Service"]["finalize"] = Effect.fn(
    "RunFinalizationService.finalize",
  )(function* (input) {
    yield* checkpointCapture
      .execute(input)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "capture-checkpoint", cause }),
        ),
      );
    const projection = yield* projections
      .getCheckpointContext(input.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new RunFinalizationError({ ...input, operation: "refresh-workspace", cause }),
        ),
      );
    // T3's Git checkpoint is already durable at this point. Add an independent
    // task-context checkpoint with source references, without making a model call.
    // This is deliberately idempotent for effect retries after a crash.
    if (Option.isSome(sqlOption)) {
      yield* Effect.gen(function* () {
        const run = projection.runs.find((candidate) => candidate.id === input.runId);
        if (!run) return;
        const thread = yield* projections.getThread(input.threadId);
        const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
        // Only committed terminal run projections can release a native checkout
        // lease. A missing/corrupt run remains held for explicit operator review.
        const terminalStatus =
          run.status === "completed" || run.status === "failed" || run.status === "cancelled"
            ? run.status
            : null;
        const { runs: fullRuns } = yield* projections.getThreadRecords(input.threadId, ["runs"]);
        const fullRun = fullRuns.find((candidate) => candidate.id === input.runId);
        const planRef = fullRun?.sourcePlanRef;
        const trustedCheckoutPath =
          terminalStatus !== null && cwd !== undefined && Option.isSome(fileSystemOption)
            ? yield* fileSystemOption.value.realPath(cwd).pipe(Effect.orElseSucceed(() => null))
            : null;
        const planSettled =
          terminalStatus !== null &&
          planRef?.threadId === input.threadId &&
          trustedCheckoutPath !== null
            ? yield* settleNativeHarnessStep({
                projectId: thread.projectId,
                threadId: input.threadId,
                planId: planRef.planId,
                messageId: fullRun!.userMessageId,
                next: terminalStatus,
                trustedCheckoutPath,
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Native plan step settlement requires review", {
                    threadId: input.threadId,
                    runId: input.runId,
                    cause,
                  }).pipe(Effect.as(false)),
                ),
              )
            : false;
        // Ordinary T3 provider turns also acquire durable checkout leases.
        // Only their exact own ID may be released, and only after finalization.
        if (terminalStatus !== null && !planSettled) {
          const leaseId = "native-run:" + run.id;
          const activeLeases = yield* listActiveCheckoutLeases();
          if (activeLeases.some((lease) => lease.leaseId === leaseId)) {
            yield* sqlOption.value
              .withTransaction(
                releaseCheckoutLease({
                  leaseId,
                  projectId: thread.projectId,
                  threadId: input.threadId,
                  planId: leaseId,
                  stepId: "provider-root",
                }),
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Native checkout lease release requires review", {
                    threadId: input.threadId,
                    runId: input.runId,
                    cause,
                  }),
                ),
              );
          }
        }
        const scopes = [
          { scopeType: "project" as const, scopeId: thread.projectId },
          { scopeType: "thread" as const, scopeId: input.threadId },
        ];
        const memory = yield* listMemory(scopes, 50);
        // Capture only the canonical saved plan for this thread and project.
        // A malformed or absent plan must not prevent a source-backed checkpoint.
        const plan = yield* readHarnessPlan({
          projectId: thread.projectId,
          threadId: input.threadId,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not include plan in task-context checkpoint", {
              threadId: input.threadId,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        const planContext = plan === null ? {} : checkpointHarnessPlan(plan);
        // Unlike run.ordinal, this is a canonical committed event sequence.
        // Capture before saving the checkpoint so future recovery can replay
        // events strictly newer than this high-water mark.
        const eventRows = yield* sqlOption.value<{ readonly eventCursor: number | null }>`
        SELECT MAX(sequence) AS "eventCursor"
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
          AND stream_id = ${input.threadId}
      `;
        const eventCursor = eventRows[0]?.eventCursor ?? 0;
        // Git is the authoritative worktree state, not a model-generated note.
        // Save a concrete HEAD fingerprint for later divergence verification.
        // Bare/uninitialized/non-Git workspaces retain a checkpoint without HEAD.
        const headCommit =
          cwd !== undefined && Option.isSome(gitOption)
            ? yield* gitOption.value.resolveCommit({ cwd, revision: "HEAD" }).pipe(
                Effect.map((value) => value.commitSha),
                Effect.orElseSucceed(() => null),
              )
            : null;
        yield* saveCheckpoint({
          id: `t3-memory:${input.threadId}:${run.ordinal}`,
          projectId: thread.projectId,
          threadId: input.threadId,
          // Per-thread checkpoint ordering uses run ordinal; replay uses eventCursor.
          sequence: run.ordinal,
          checkpoint: {
            schemaVersion: 1,
            objective: thread.title || "Coding task",
            eventCursor,
            ...planContext,
            ...(thread.branch === null ? {} : { branch: thread.branch }),
            ...(headCommit === null ? {} : { headCommit }),
            sourceEventRefs: [`t3:run:${input.runId}`],
            decisionMemoryIds: memory
              .filter((entry) => entry.verification !== "proposed" && entry.kind === "decision")
              .map((entry) => entry.id),
          },
        });
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sqlOption.value),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not persist durable task-context checkpoint", {
            threadId: input.threadId,
            runId: input.runId,
            cause,
          }),
        ),
      );
    }
    const cwd = projection.checkpointScopes.find((scope) => scope.id === input.scopeId)?.cwd;
    if (cwd !== undefined) {
      // Retrying a display refresh after the checkpoint is durable blocks the next turn.
      yield* observer.refresh({ cwd, threadId: input.threadId, runId: input.runId }).pipe(
        Effect.catchTags({
          RunFinalizationRefreshError: (cause) =>
            Effect.logWarning("Failed to refresh workspace after checkpoint capture", {
              ...input,
              cause,
            }),
        }),
      );
    }
  });
  return RunFinalizationService.of({ finalize });
});

export const layer = Layer.effect(RunFinalizationService, make);

export const layerObserver = Layer.effect(
  RunFinalizationObserver,
  Effect.gen(function* () {
    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
    const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const pullRequests = yield* PullRequestService.PullRequestService;
    const pullRequestLookups = yield* FiberMap.make<string>();
    return {
      refreshAfterTurn: pullRequests.refreshAfterTurn,
      refresh: Effect.fn("RunFinalizationService.refresh")(
        function* ({ cwd, threadId, runId }) {
          const [, local] = yield* Effect.all(
            [workspaceEntries.refresh(cwd), vcsStatus.refreshLocalStatus(cwd)],
            { concurrency: "unbounded" },
          );
          if (local.refName === null || local.isDefaultRef) return;
          const thread = yield* projections.getThreadShell(threadId);
          if (!thread || thread.branch !== local.refName) return;
          if (thread.activeRunId !== null && thread.activeRunId !== runId) return;
          // The forge CLI can take minutes, so the next turn must not wait for it. A newer
          // turn's lookup replaces a running one instead of queueing behind the cwd's lock.
          yield* vcsStatus.refreshPullRequestStatus(cwd).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to refresh pull request status after run completion", {
                threadId,
                cwd,
                detail: error.message,
              }),
            ),
            FiberMap.run(pullRequestLookups, cwd),
          );
        },
        (effect, { cwd }) =>
          effect.pipe(Effect.mapError((cause) => new RunFinalizationRefreshError({ cwd, cause }))),
      ),
    };
  }),
);
