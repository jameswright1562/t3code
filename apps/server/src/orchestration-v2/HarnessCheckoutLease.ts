import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class HarnessCheckoutLeaseError extends Schema.TaggedError<HarnessCheckoutLeaseError>()(
  "HarnessCheckoutLeaseError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface HarnessCheckoutLease {
  readonly leaseId: string;
  readonly checkoutPath: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly acquiredAt: string;
}

type LeaseOwner = Pick<
  HarnessCheckoutLease,
  "leaseId" | "projectId" | "threadId" | "planId" | "stepId"
>;
type AcquireLeaseInput = LeaseOwner & {
  readonly checkoutPath: string;
  readonly acquiredAt?: string;
};

const reject = (detail: string) => new HarnessCheckoutLeaseError({ detail });

/**
 * Called ONLY with a host-resolved realpath, never an LLM- or UI-supplied key.
 * Case folding over-locks on case-sensitive volumes, which is safer than
 * treating aliases as independent worktrees.
 */
export function normalizeCheckoutRealPath(path: string): string {
  if (
    !path ||
    path.length > 4096 ||
    path.includes("\0") ||
    !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/u.test(path)
  ) {
    throw reject("A trusted absolute checkout realpath is required.");
  }
  const segments = path.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw reject("Noncanonical checkout path; resolve symlinks and dot segments first.");
  }
  const folded = path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return /^[a-z]:$/u.test(folded) ? folded + "/" : folded || "/";
}

export function checkoutPathsOverlap(left: string, right: string): boolean {
  const a = normalizeCheckoutRealPath(left);
  const b = normalizeCheckoutRealPath(right);
  return (
    a === b ||
    a.startsWith(b.endsWith("/") ? b : b + "/") ||
    b.startsWith(a.endsWith("/") ? a : a + "/")
  );
}

const rows = Effect.fn("HarnessCheckoutLease.rows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly leaseId: string;
    readonly checkoutPath: string;
    readonly projectId: string;
    readonly threadId: string;
    readonly planId: string;
    readonly stepId: string;
    readonly acquiredAt: string;
  }>`
    SELECT lease_id AS "leaseId", checkout_path AS "checkoutPath",
      project_id AS "projectId", thread_id AS "threadId",
      plan_id AS "planId", step_id AS "stepId",
      acquired_at AS "acquiredAt" FROM harness_checkout_leases
  `;
});

const sameOwner = (left: LeaseOwner, right: LeaseOwner) =>
  left.leaseId === right.leaseId &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId &&
  left.planId === right.planId &&
  left.stepId === right.stepId;

/**
 * These mutations MUST be called under the same SQL transaction as the plan
 * step status change. SQLite's writer lock serializes the overlap check and
 * insertion; the unique index also rejects exact-path races. In-memory locks
 * or expirations would permit double writes after a server crash.
 */
export const acquireCheckoutLease = Effect.fn("HarnessCheckoutLease.acquire")(function* (
  input: AcquireLeaseInput,
) {
  if (
    [input.leaseId, input.projectId, input.threadId, input.planId, input.stepId].some(
      (id) => id.trim().length === 0 || id.length > 256,
    )
  )
    return yield* reject("Invalid checkout lease identity.");
  const canonical = yield* Effect.try({
    try: () => normalizeCheckoutRealPath(input.checkoutPath),
    catch: () => reject("Invalid host checkout realpath."),
  });
  const active = yield* rows();
  const existing = active.find((row) => row.leaseId === input.leaseId);
  if (existing) {
    if (!sameOwner(existing, input) || existing.checkoutPath !== canonical) {
      return yield* reject("A lease ID is already owned by a different execution.");
    }
    return existing;
  }
  if (active.some((row) => checkoutPathsOverlap(row.checkoutPath, canonical))) {
    return yield* reject("Checkout is held by another plan step; do not start a parallel writer.");
  }
  const sql = yield* SqlClient.SqlClient;
  const acquiredAt = input.acquiredAt ?? DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO harness_checkout_leases
      (lease_id, checkout_path, project_id, thread_id, plan_id, step_id, acquired_at)
    VALUES (
      ${input.leaseId}, ${canonical}, ${input.projectId}, ${input.threadId},
      ${input.planId}, ${input.stepId}, ${acquiredAt}
    )
  `;
  return { ...input, checkoutPath: canonical, acquiredAt } satisfies HarnessCheckoutLease;
});

export const releaseCheckoutLease = Effect.fn("HarnessCheckoutLease.release")(function* (
  input: LeaseOwner,
) {
  const active = yield* rows();
  const existing = active.find((row) => row.leaseId === input.leaseId);
  if (!existing) return yield* reject("Checkout lease is missing; manual recovery is required.");
  if (!sameOwner(existing, input)) {
    return yield* reject("Checkout lease owner mismatch; refusing an unsafe release.");
  }
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM harness_checkout_leases
    WHERE lease_id = ${input.leaseId}
      AND project_id = ${input.projectId}
      AND thread_id = ${input.threadId}
      AND plan_id = ${input.planId}
      AND step_id = ${input.stepId}`;
  return true as const;
});

/** Active leases are deliberately retained across crashes for human review. */
export const listActiveCheckoutLeases = rows;
