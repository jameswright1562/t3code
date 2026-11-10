import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { listMemory, remember } from "../../../memory/AgentMemory.ts";
import { selectMemoryForContext } from "../../../memory/MemoryContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { newCommandId, readCaller, unavailable } from "../../threadAccess.ts";
import { MemoryToolkit } from "./tools.ts";

/** The canonical T3 thread belongs to exactly one project. Never accept a
 *  project ID from the agent or from text returned by a tool. */
const callerContext = Effect.fn("mcp.memory.caller")(function* () {
  const context = yield* readCaller();
  if (context.caller === undefined || context.scope.thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project memory requires a live thread caller.",
    });
  }
  return {
    projectId: context.caller.projectId,
    threadId: context.caller.id,
    sessionId: context.scope.thread.providerSessionId,
    providerInstanceId: context.scope.thread.providerInstanceId,
  };
});

export const layer = McpToolAccess.toLayer(MemoryToolkit, {
  t3_memory_search: McpToolAccess.readsAsCaller(({ query, maxItems }) =>
    Effect.gen(function* () {
      const caller = yield* callerContext();
      const scopes = [
        { scopeType: "project" as const, scopeId: caller.projectId },
        { scopeType: "thread" as const, scopeId: caller.threadId },
      ];
      const stored = yield* listMemory(scopes, 100).pipe(Effect.mapError(unavailable));
      const selected = selectMemoryForContext(stored, {
        query,
        allowedScopes: scopes,
        maxEstimatedTokens: 900,
        maxEntries: maxItems ?? 12,
      });
      return {
        entries: selected.memories.map((entry) => ({
          id: entry.id,
          scope: entry.scopeType === "thread" ? "thread" as const : "project" as const,
          kind: entry.kind,
          content: entry.content,
          sourceRef: entry.sourceRef,
          verification: entry.verification,
        })),
        estimatedTokens: selected.estimatedTokens,
      };
    }),
  ),
  t3_memory_propose: McpToolAccess.actsAsCaller(({ scope, kind, content }) =>
    Effect.gen(function* () {
      const caller = yield* callerContext();
      if (!content.trim()) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Memory content must be nonempty.",
        });
      }
      const id = yield* newCommandId();
      const saved = yield* remember({
        id: `mcp:memory:${id}`,
        eventId: `mcp:memory:created:${id}`,
        scopeType: scope,
        scopeId: scope === "project" ? caller.projectId : caller.threadId,
        kind,
        content,
        sourceRef: `thread:${caller.threadId}:session:${caller.sessionId}`,
        sourceActor: `agent:${caller.providerInstanceId}`,
        verification: "proposed",
      }).pipe(Effect.mapError(unavailable));
      return { id: saved.id, verification: "proposed" as const };
    }),
  ),
});
