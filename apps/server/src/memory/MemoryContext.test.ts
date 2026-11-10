import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "./AgentMemory.ts";
import { estimateMemoryTokens, selectMemoryForContext } from "./MemoryContext.ts";

const memory = (id: string, changes: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  scopeType: "project",
  scopeId: "project-a",
  kind: "fact",
  content: "The build command is bun run test",
  sourceRef: "README.md@123",
  sourceActor: "tool",
  verification: "verified",
  confidence: 0.95,
  pinned: false,
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T11:00:00.000Z",
  lastVerifiedAt: "2026-11-10T11:00:00.000Z",
  supersededBy: null,
  tombstonedAt: null,
  ...changes,
});

describe("MemoryContext", () => {
  it("never retrieves unapproved scopes, tombstones or proposed memories by default", () => {
    const items = [
      memory("a"),
      memory("b", { scopeId: "project-b", pinned: true }),
      memory("c", { tombstonedAt: "2026-11-10T12:00:00.000Z" }),
      memory("d", { verification: "proposed" }),
      memory("e", { supersededBy: "a" }),
    ];
    const selected = selectMemoryForContext(items, {
      query: "build command",
      allowedScopes: [{ scopeType: "project", scopeId: "project-a" }],
      maxEstimatedTokens: 1000,
    });
    expect(selected.memories.map((entry) => entry.id)).toEqual(["a"]);
    expect(selected.eligibleCount).toBe(1);
    expect(selected.excludedCount).toBe(4);
  });

  it("ranks relevant/pinned facts and never exceeds estimated token allowance", () => {
    const items = [
      memory("irrelevant", { content: "Remote staging network diagrams" }),
      memory("relevant", { content: "Build command should run tests" }),
      memory("pinned", {
        content: "Build command is always bun run test",
        pinned: true,
        verification: "user_confirmed",
      }),
    ];
    const selected = selectMemoryForContext(items, {
      query: "build command",
      allowedScopes: [{ scopeType: "project", scopeId: "project-a" }],
      maxEstimatedTokens: estimateMemoryTokens(items[2]!),
      maxEntries: 1,
    });
    expect(selected.memories.map((entry) => entry.id)).toEqual(["pinned"]);
    expect(selected.estimatedTokens).toBeLessThanOrEqual(estimateMemoryTokens(items[2]!));
  });

  it("returns nothing when no scope is explicitly allowed", () => {
    expect(
      selectMemoryForContext([memory("a")], {
        query: "build",
        allowedScopes: [],
        maxEstimatedTokens: 500,
      }).memories,
    ).toEqual([]);
  });
});
