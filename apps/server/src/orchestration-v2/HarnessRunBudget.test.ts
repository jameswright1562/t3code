import { describe, expect, it } from "@effect/vitest";
import { evaluateDelegatedChildBudget, evaluateThreadRunBudget } from "./HarnessRunBudget.ts";

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

describe("app-owned delegated child concurrency", () => {
  it("allows a new child below the limit", () => {
    expect(evaluateDelegatedChildBudget({ activeChildren: 0, maxConcurrentChildren: 1 }).allowed).toBe(true);
    expect(evaluateDelegatedChildBudget({ activeChildren: 3, maxConcurrentChildren: 4 }).allowed).toBe(true);
  });
  it("refuses another child at the concurrency cap", () => {
    const result = evaluateDelegatedChildBudget({ activeChildren: 4, maxConcurrentChildren: 4 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("4");
  });
  it("refuses an invalid cap or invalid active-child count", () => {
    expect(evaluateDelegatedChildBudget({ activeChildren: -1, maxConcurrentChildren: 4 }).allowed).toBe(false);
    expect(evaluateDelegatedChildBudget({ activeChildren: 0, maxConcurrentChildren: 0 }).allowed).toBe(false);
    expect(evaluateDelegatedChildBudget({ activeChildren: 0, maxConcurrentChildren: 33 }).allowed).toBe(false);
  });
});
