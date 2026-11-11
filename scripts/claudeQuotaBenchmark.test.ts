import { describe, expect, it } from "@effect/vitest";
import { analyzeQuota, reportQuota } from "./claudeQuotaBenchmark.ts";
const base = {
  model: "same-model",
  effort: "same-effort",
  promptHash: "a".repeat(64),
  contextHash: "b".repeat(64),
  fiveHourBefore: 80,
  fiveHourAfter: 78,
  weeklyBefore: 60,
  weeklyAfter: 59,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 500,
  cacheWriteTokens: 10,
};
const samples = [
  { ...base, pair: "one", adapter: "native", order: 1 },
  { ...base, pair: "one", adapter: "t3", order: 2, fiveHourAfter: 76 },
  { ...base, pair: "two", adapter: "t3", order: 1, fiveHourAfter: 77 },
  { ...base, pair: "two", adapter: "native", order: 2 },
];
describe("offline subscription quota A/B", () => {
  it("compares measured meter changes, not tokens", () => {
    const r = analyzeQuota(samples);
    expect(r.alternating).toBe(true);
    expect(r.fiveHourDifference).toBe(1.5);
    expect(reportQuota(r)).toContain("1.50 percentage points");
  });
  it("refuses incomparable pairs and quota resets", () => {
    expect(() => analyzeQuota([{ ...samples[0], weeklyAfter: 90 }, ...samples.slice(1)])).toThrow(
      /reset/,
    );
    expect(() =>
      analyzeQuota([samples[0], { ...samples[1], model: "different" }, ...samples.slice(2)]),
    ).toThrow(/Incomparable/);
  });
});
