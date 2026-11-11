/**
 * Lightweight defence-in-depth guard against accidentally persisting obvious
 * credentials as agent memory. Returns a category only: never echo input.
 *
 * This is not a secret scanner or DLP guarantee. Keep dedicated credentials
 * exclusively in the host secret store, and never treat memory as trusted.
 */
const patterns = [
  ["private key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["OpenAI-style API token", /\bsk-(?:proj-)?[a-z0-9_-]{20,}/i],
  ["GitHub token", /\b(?:gh[pousr]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{35,})/i],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["URL userinfo", /\bhttps?:\/\/[^\/\s:@]+:[^@\s/]+@/i],
  ["plaintext credential assignment", /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{20,}/i],
] as const;

export function potentialSecretCategory(value: string): string | null {
  for (const [category, regex] of patterns) {
    if (regex.test(value)) return category;
  }
  return null;
}
