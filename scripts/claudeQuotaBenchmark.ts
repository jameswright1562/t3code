/** Offline Claude subscription A/B. This file NEVER invokes a model or estimates quota from tokens.
 * Collect before/after 5h and weekly percent remaining from the subscription UI,
 * and provider-reported input/output/cache counters for equivalent native vs T3 runs.
 * Alternate native-first and T3-first pairs, same model, effort, prompt and context.
 * Run: node --experimental-strip-types scripts/claudeQuotaBenchmark.ts samples.json
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface Sample {
  pair: string;
  adapter: "native" | "t3";
  order: 1 | 2;
  model: string;
  effort: string;
  promptHash: string;
  contextHash: string;
  fiveHourBefore: number;
  fiveHourAfter: number;
  weeklyBefore: number;
  weeklyAfter: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}
const fail = (reason: string): never => {
  throw new Error(reason);
};
const percentage = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
const tokenCount = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const hash = (n: unknown) => typeof n === "string" && /^[0-9a-f]{64}$/i.test(n);

export function analyzeQuota(input: unknown) {
  if (!Array.isArray(input) || input.length < 4 || input.length > 200)
    return fail("Expected 2–100 native/T3 pairs.");
  const groups = new Map<string, Sample[]>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("Invalid sample");
    const s = raw as Record<string, unknown>;
    if (
      typeof s.pair !== "string" ||
      !/^[\w-]{1,48}$/.test(s.pair) ||
      (s.adapter !== "t3" && s.adapter !== "native") ||
      (s.order !== 1 && s.order !== 2) ||
      typeof s.model !== "string" ||
      !s.model.trim() ||
      typeof s.effort !== "string" ||
      !s.effort.trim() ||
      !hash(s.promptHash) ||
      !hash(s.contextHash)
    )
      return fail("Invalid sample identity");
    for (const key of ["fiveHourBefore", "fiveHourAfter", "weeklyBefore", "weeklyAfter"])
      if (!percentage(s[key])) return fail("Invalid quota meter percentage " + key);
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])
      if (!tokenCount(s[key])) return fail("Missing token telemetry " + key);
    if (
      (s.fiveHourAfter as number) > (s.fiveHourBefore as number) ||
      (s.weeklyAfter as number) > (s.weeklyBefore as number)
    )
      return fail("Quota reset occurred during run; repeat the sample");
    const key = s.pair as string;
    groups.set(key, [...(groups.get(key) ?? []), s as unknown as Sample]);
  }
  if (groups.size < 2) return fail("At least two comparable pairs needed");
  const pairs = [...groups].map(([id, samples]) => {
    const first = samples.find((s) => s.order === 1);
    const second = samples.find((s) => s.order === 2);
    if (
      samples.length !== 2 ||
      !first ||
      !second ||
      first.adapter === second.adapter ||
      first.model !== second.model ||
      first.effort !== second.effort ||
      first.promptHash !== second.promptHash ||
      first.contextHash !== second.contextHash
    )
      return fail("Incomparable pair: " + id);
    const native = samples.find((s) => s.adapter === "native")!;
    const t3 = samples.find((s) => s.adapter === "t3")!;
    return {
      id,
      first: first.adapter,
      nativeFiveHour: native.fiveHourBefore - native.fiveHourAfter,
      t3FiveHour: t3.fiveHourBefore - t3.fiveHourAfter,
      nativeWeekly: native.weeklyBefore - native.weeklyAfter,
      t3Weekly: t3.weeklyBefore - t3.weeklyAfter,
      nativeInputTokens: native.inputTokens,
      t3InputTokens: t3.inputTokens,
    };
  });
  const avg = (fn: (p: (typeof pairs)[number]) => number) =>
    pairs.reduce((sum, p) => sum + fn(p), 0) / pairs.length;
  return {
    pairs,
    alternating: pairs.every((p, i) => i === 0 || p.first !== pairs[i - 1]!.first),
    fiveHourDifference: avg((p) => p.t3FiveHour - p.nativeFiveHour),
    weeklyDifference: avg((p) => p.t3Weekly - p.nativeWeekly),
  };
}
export function reportQuota(input: ReturnType<typeof analyzeQuota>): string {
  return [
    "# Observed Claude subscription A/B (native vs T3)",
    "Pairs: " + input.pairs.length + "; order alternated: " + input.alternating,
    "T3 minus native five-hour consumption: " +
      input.fiveHourDifference.toFixed(2) +
      " percentage points",
    "T3 minus native weekly consumption: " +
      input.weeklyDifference.toFixed(2) +
      " percentage points",
    "Provider tokens are diagnostic only. Quota is NEVER estimated from token counts.",
    "Rounded meters, resets or concurrent usage can make small samples inconclusive.",
  ].join("\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) {
    process.stderr.write(
      "Usage: node --experimental-strip-types scripts/claudeQuotaBenchmark.ts samples.json\n",
    );
    process.exitCode = 2;
  } else {
    readFile(process.argv[2], "utf8")
      .then((data) => reportQuota(analyzeQuota(JSON.parse(data))))
      .then((report) => process.stdout.write(report + "\n"))
      .catch((error: unknown) => {
        process.stderr.write((error instanceof Error ? error.message : "Invalid input") + "\n");
        process.exitCode = 1;
      });
  }
}
