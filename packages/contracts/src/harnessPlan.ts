import * as Schema from "effect/Schema";

export const HarnessPlanStepStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const HarnessPlanStepDraft = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  checkoutKey: Schema.String,
  provider: Schema.String,
  model: Schema.optional(Schema.NullOr(Schema.String)),
  acceptanceCriteria: Schema.String,
});
export type HarnessPlanStepDraft = typeof HarnessPlanStepDraft.Type;
export const HarnessPlanStep = Schema.Struct({
  ...HarnessPlanStepDraft.fields,
  status: HarnessPlanStepStatus,
  artifactRefs: Schema.Array(Schema.String),
  dispatchMessageId: Schema.optional(Schema.String),
});
export type HarnessPlanStep = typeof HarnessPlanStep.Type;
export const HarnessPlan = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  planId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  revision: Schema.Number,
  steps: Schema.Array(HarnessPlanStep),
  updatedAt: Schema.String,
});
export type HarnessPlan = typeof HarnessPlan.Type;
export const HarnessPlanReadInput = Schema.Struct({
  projectId: Schema.String,
  threadId: Schema.String,
});
export const HarnessPlanCreateInput = Schema.Struct({
  ...HarnessPlanReadInput.fields,
  planId: Schema.String,
  steps: Schema.Array(HarnessPlanStepDraft),
});
export const HarnessPlanMutationInput = Schema.Struct({
  ...HarnessPlanReadInput.fields,
  expectedRevision: Schema.Number,
  change: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("edit"),
      steps: Schema.Array(HarnessPlanStepDraft),
    }),
    Schema.Struct({
      type: Schema.Literal("transition"),
      stepId: Schema.String,
      next: HarnessPlanStepStatus,
      allowParallel: Schema.optional(Schema.Boolean),
    }),
  ]),
});
export const HarnessPlanDispatchInput = Schema.Struct({
  ...HarnessPlanReadInput.fields,
  stepId: Schema.String,
  expectedRevision: Schema.Int,
});

export class HarnessPlanError extends Schema.TaggedError<HarnessPlanError>()("HarnessPlanError", {
  message: Schema.String,
}) {}
