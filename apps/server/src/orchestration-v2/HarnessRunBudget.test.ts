import { describe, expect, it } from "@effect/vitest";
import { evaluateThreadRunBudget } from "./HarnessRunBudget.ts";

describe("per-thread provider-start budget", () => {
  it("allows unlimited or under-budget runs", () => {
    expect(evaluateThreadRunBudget({ maxRuns: 0, runOrdinal: 200 }).allowed).toBe(true);
    expect(evaluateThreadRunBudget({ maxRuns: 10, runOrdinal: 10 }).allowed).toBe(true);
  });
  it("blocks the next run, including a retried provider start", () => {
    const result = evaluateThreadRunBudget({ maxRuns: 10, runOrdinal: 11 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("10");
  });
  it("fails closed for bad configuration, not silently unlimited", () => {
    expect(evaluateThreadRunBudget({ maxRuns: -1, runOrdinal: 1 }).allowed).toBe(false);
    expect(evaluateThreadRunBudget({ maxRuns: 1.5, runOrdinal: 2 }).allowed).toBe(false);
  });
});
