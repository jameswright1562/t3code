import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MemoryKind = Schema.Literals([
  "fact",
  "decision",
  "preference",
  "constraint",
  "file_reference",
  "failed_approach",
  "open_question",
  "procedure",
  "outcome",
]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  SecureRandom.SecureRandom,
  SqlClient.SqlClient,
];

const MemoryEntry = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["project", "thread"]),
  kind: MemoryKind,
  content: Schema.String,
  sourceRef: Schema.String,
  verification: Schema.Literals(["proposed", "verified", "user_confirmed"]),
});

const Search = Tool.make("t3_memory_search", {
  description:
    "Find source-backed notes in this thread and project. Results exclude unreviewed proposals and are bounded to avoid context growth.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(1000)),
    maxItems: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  }),
  success: Schema.Struct({
    entries: Schema.Array(MemoryEntry),
    estimatedTokens: Schema.Number,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const Propose = Tool.make("t3_memory_propose", {
  description:
    "Propose saving a useful fact, decision or instruction for this thread or project. Agent proposals are NOT trusted or injected as memory until a user verifies them. Never save secrets.",
  parameters: Schema.Struct({
    scope: Schema.Literals(["project", "thread"]),
    kind: MemoryKind,
    content: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  success: Schema.Struct({ id: Schema.String, verification: Schema.Literal("proposed") }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
}).annotate(Tool.Destructive, true);

export const MemoryToolkit = Toolkit.make(Search, Propose);
