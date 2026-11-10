/**
 * Deterministic, provider-neutral memory selection for an agent context.
 * Caller MUST authorize scopes before passing them. Token count is an
 * approximation, not a billable usage figure or a strict model tokenizer.
 */
import type { MemoryEntry, MemoryScope } from "./AgentMemory.ts";

export interface SelectMemoryOptions {
  readonly query: string;
  readonly allowedScopes: readonly MemoryScope[];
  readonly maxEstimatedTokens: number;
  readonly maxEntries?: number;
  readonly includeProposed?: boolean;
}

export interface MemorySelection {
  readonly memories: readonly MemoryEntry[];
  readonly estimatedTokens: number;
  readonly eligibleCount: number;
  readonly excludedCount: number;
}

const terms = (text: string): Set<string> =>
  new Set(
    (text.toLocaleLowerCase("en").match(/[a-z0-9_.-]{3,}/g) ?? []).filter(
      (word) => !["the", "and", "for", "with", "from", "this", "that", "into", "are"].includes(word),
    ),
  );

export const estimateMemoryTokens = (entry: MemoryEntry): number =>
  Math.ceil(
    (entry.content.length + entry.sourceRef.length + entry.kind.length + entry.id.length) / 4,
  ) + 24;

/**
 * Stable rank: preference for pinned, verified, directly relevant evidence.
 * Do not use time-dependent scoring so recovery is reproducible.
 */
export const selectMemoryForContext = (
  entries: readonly MemoryEntry[],
  options: SelectMemoryOptions,
): MemorySelection => {
  const allowed = new Set(options.allowedScopes.map((scope) => scope.scopeType + ":" + scope.scopeId));
  const requestedTerms = terms(options.query);
  const eligible = entries.filter((entry) => {
    if (!allowed.has(entry.scopeType + ":" + entry.scopeId)) return false;
    if (entry.tombstonedAt !== null || entry.supersededBy !== null) return false;
    if (entry.verification === "proposed" && options.includeProposed !== true) return false;
    return true;
  });

  const scored = eligible.map((entry) => {
    const haystack = terms(entry.content + " " + entry.sourceRef);
    let overlap = 0;
    for (const word of requestedTerms) if (haystack.has(word)) overlap++;
    const score =
      overlap * 10 +
      (entry.pinned ? 20 : 0) +
      (entry.verification === "user_confirmed" ? 8 : 0) +
      (entry.verification === "verified" ? 4 : 0) +
      (entry.kind === "constraint" || entry.kind === "decision" ? 3 : 0);
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id));

  const maxEstimatedTokens = Math.max(0, Math.floor(options.maxEstimatedTokens));
  const maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 30));
  const selected: MemoryEntry[] = [];
  let used = 0;
  for (const { entry } of scored) {
    if (selected.length >= maxEntries) break;
    const tokens = estimateMemoryTokens(entry);
    if (used + tokens > maxEstimatedTokens) continue;
    selected.push(entry);
    used += tokens;
  }
  return {
    memories: selected,
    estimatedTokens: used,
    eligibleCount: eligible.length,
    excludedCount: entries.length - eligible.length,
  };
};
