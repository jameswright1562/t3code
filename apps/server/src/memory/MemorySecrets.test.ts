import { describe, expect, it } from "@effect/vitest";
import { potentialSecretCategory } from "./MemorySecrets.ts";

describe("memory credential guard", () => {
  it("recognizes obvious credentials without returning their value", () => {
    const values = [
      "Bearer 1234567890abcdefghijKLMNOP",
      "-----BEGIN RSA PRIVATE KEY-----",
      "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyzABCDEFG123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "https://user:verylongsecret@example.com/api",
      "password=abcdefghijklmnopqrstuvwxyz123456",
    ];
    for (const value of values) {
      const category = potentialSecretCategory(value);
      expect(category).toBeTypeOf("string");
      expect(value.includes(category ?? "")).toBe(false);
    }
  });
  it("permits ordinary source references and statements about authentication", () => {
    expect(
      potentialSecretCategory("Use bearer authentication and environment variables"),
    ).toBeNull();
    expect(potentialSecretCategory("file:src/auth/TokenStore.ts@ab123")).toBeNull();
    expect(potentialSecretCategory("https://github.com/example/project#readme")).toBeNull();
  });
});
