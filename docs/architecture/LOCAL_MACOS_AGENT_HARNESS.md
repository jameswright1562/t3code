# Local macOS Agent Harness — Architecture, Durable Memory, Context & Implementation Plan

**Status:** Living implementation specification — PR #3 merged, PR #8 active and not production-ready  
**Base:** fork of [T3 Code](https://github.com/pingdotgg/t3code)  
**Target:** macOS-first, local execution while the Mac is awake  
**Owner repo:** [jameswright1562/t3code](https://github.com/jameswright1562/t3code)  
**Priority order:** durable memory and context → subscription/token efficiency → visible multi-step orchestration → first-class MCP management → native agent interoperability.

> This is a specification and implementation plan, not a claim that every feature below is already implemented. The original fork main was last updated in May 2026. This integration branch is based on upstream commit d756fed (Nov 2026), preserving the old branch and porting the memory work. The May fork's custom OpenCode options must be reconciled before finishing. Keep the fork's earlier OpenCode work intact during that reconciliation.

## Current delivery status — 11 November 2026

**Canonical working PR:** [#8 — macOS harness release gates](https://github.com/jameswright1562/t3code/pull/8) ·
branch `feat/macos-harness-release-gates` · verified implementation commit `448d82d` ·
**draft, unmerged, not production ready**. PR #3 was merged previously. This
section is the current tracker; historical sections below describe earlier
states and must not be read as the latest checklist.

### Implemented and tested in fork-specific CI

- [x] Persistent **project/thread-scoped memory**, source references, proposal
      versus verified status, browser/approval/revision/pinning/forgetting UI,
      bounded context search and injection on fresh native sessions.
- [x] Full **scoped memory backup/restore** with audit events, revision ancestors,
      tombstones, checksum, idempotence and conflict refusal; no external Git objects
      or provider-native sessions are included.
- [x] **Checkpoint capture after finalization**, Git branch/HEAD validation,
      persisted thread event cursor, corrupt-latest fallback, checkpoint history and
      read-only recovery inspector. The inspector **does not** resume execution.
- [x] Configurable shared MCP **registry and Settings UI** for selected providers
      and projects, with conservative URL/stdio validation. This is not a complete
      credentialed MCP connection manager.
- [x] Per-thread **maximum native provider run count** (optional; 0 = unlimited).
      This is **not** a hard cap on native child turns, tokens or subscription usage.
- [x] Offline paired Claude quota **analysis script**, using recorded subscription
      percentages. No real paid-model A/B measurements have been taken.
- [x] **Migration 81 collision handling**: preserve fork memory migrations
      81/82 and install upstream message-search upgrade as 83, with regression tests.
- [x] Durable **revisioned plans** (migration 84), dependency/cycle validation,
      optimistic edit guards, sequential-ready selection and logical checkout-key
      collision refusal. Manual plan editor and authenticated, thread-owned RPCs
      are connected. **No real agent scheduling or filesystem lock is attached.**
- [x] Hosted **macOS unsigned desktop build** and preload smoke, Linux desktop
      build/lint/unused export checks, focused memory/plan/migration tests, server,
      contracts and client typechecks, plus web build.

**CI evidence at `448d82d`:** [fork memory/OpenCode checks](https://github.com/jameswright1562/t3code/actions/runs/43016432685),
[fork desktop/lint checks](https://github.com/jameswright1562/t3code/actions/runs/43016432683) and
[hosted macOS build smoke](https://github.com/jameswright1562/t3code/actions/runs/43016432705)
all completed successfully. General monorepo CI was still **pending**, so these
passing focused checks are not an all-green branch-protection result.

### Unfinished release blockers

| Priority | Requirement                           | Status / acceptance gate                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0       | **Upstream synchronization**          | Fork `main` at `f097733`; upstream `main` at `6700cf6`, **98 newer upstream commits** since `04f6cfc`. Merge/reconcile without rewriting applied fork migrations 81–84; retain OpenCode/MCP customizations, run migrations and full CI, then update fork `main` only through an approved merge.                    |
| P0       | **Real agent plan runner**            | Manual state tracking only. Connect user-initiated provider dispatch, true checkout/worktree identity and filesystem exclusivity, explicit parallelism, child delegation, pause/cancel/retry, artifact provenance and recovery. Do not auto-run after app launch.                                                  |
| P0       | **Crash-safe user-approved resume**   | Add pre-compaction, handoff, delegation and shutdown capture; validate file fingerprints and Git state; reconcile committed events; ledger ambiguous external effects; require explicit resume approval before any retry. Existing read-only recovery is not equivalent.                                           |
| P0       | **MCP credentials and tooling**       | Implement macOS Keychain secret references, OAuth PKCE/state, HTTP and stdio connection test, tool discovery/health/reconnect, provider-project-tool allowlists enforced per invocation. Avoid persisting raw credentials in SQLite or logs.                                                                       |
| P0       | **Token and subscription efficiency** | Add per-step/child/turn/concurrency limits where adapters expose counters, measured versus unknown usage labeling, usage attribution and explicit budget stops. Run controlled native-Claude-versus-T3 macOS A/B with actual five-hour and weekly quota percentages; do not infer subscription meters from tokens. |
| P0       | **Release validation**                | Full monorepo CI, migration replay against fork and upstream DB copies, packaged/signed macOS restart and security tests, credentialed provider/MCP smoke, independent PR review and branch protection. GitHub-hosted unsigned build is not a packaged test.                                                       |

**Local validation limitation:** the connected Mac development machine was offline
when checked on 11 November 2026. Live Keychain/Claude-authenticated benchmarks
and personal packaged-app testing cannot be certified from hosted CI.

**Design invariants:** one integration PR; no automatic triggers; only run while
Mac is active; default to sequential execution; avoid duplicate LLM calls and
silent quota drain; no unauthorized parallel writers; never fabricate usage or
claim exactly-once effects without a proven external effect ledger.

---

### Incremental checkout protection (migration 85; not yet provider-integrated)

- [x] Added a persistent SQLite exclusive checkout lease ledger with canonical
      absolute-path checks, parent/child path overlap refusal, owner verification
      and no automatic lock expiry. A crashed server must not silently release a
      potentially live native child writer. Unit and migration tests cover overlap,
      idempotence, cross-owner release refusal and persistence.
- [ ] Wire trusted realpaths, acquisition and release into provider dispatch,
      finalization, cancellation and crash review. Until that wiring is complete,
      this module **does not protect arbitrary native-provider writes**. The plan
      board remains a manual tracker, not a lock-enforced execution engine.

### Plan-board checkout lease integration (migration 85; requires CI)

Manual step transitions now resolve each checkout from the **trusted host**
project/worktree realpath. The server ignores caller-supplied checkout keys on
creation and edits. Marking a step as running atomically acquires a persistent
exclusive plan lease; completing/failing/cancelling it releases that lease
in the same transaction as the step status update. Parent/child paths and
cross-thread plan writers are blocked. A lease left by a crash does not expire
automatically; a missing lease or moved checkout fails closed for manual review.
**These are plan-board leases only:** existing native provider sessions and
external tool executions are not yet covered by this gate. The UI still marks
steps manually and does not dispatch agents or prove a provider has stopped.

### Upstream native merge diagnostic (11 November 2026)

The full three-way Git-tree comparison from common upstream `3a8c250` to
upstream `6700cf6` found **453 upstream-only path changes** and **13 paths
edited independently in the fork** (all other paths are already identical or
fork-only). The new `.github/workflows/fork-upstream-merge-probe.yml` runs an
actual `git merge --no-commit` on a public runner, prints and uploads any
unresolved hunks, then aborts. It never rewrites fork `main` or pushes an
untested merge. A successful probe only demonstrates mechanical mergeability;
all migrations, MCP behavior, native adapters and full CI must still be checked.

## Historical implementation snapshot — 10 November 2026

**Historical integration branch (since merged):** `feat/macos-orchestrator-upstream-base`, [PR #3](https://github.com/jameswright1562/t3code/pull/3), based on upstream `d756fed7`. The older May 2026 fork main and draft PR #2 are preserved, not overwritten.

**Committed, subject to validation:**

- Additive SQLite migration **081**, registered against upstream migrations 1–80, with memory records, auditable changes and context checkpoints.
- Typed operations for memory creation, scoped retrieval, tombstone and explicit user confirmation. Agent proposals have verification=`proposed` and are **not** added to model prompts before user confirmation.
- Agent-facing `t3_memory_search` and `t3_memory_propose` MCP tools; only the canonical calling thread/project scope is used, without agent-supplied project IDs.
- Context builder selects relevant verified project/thread memories under an estimated 800-token default; injects them only when starting a fresh native provider session.
- Run finalization persists a small checkpoint after T3's durable Git checkpoint capture, indexed by per-thread **run ordinal**. This is **not** yet an event-store replay cursor.
- Ported OpenCode source-checkout launch support and T3 UI custom JSONC injection.
- A dedicated public-runner GitHub Actions workflow runs focused tests and typechecks for memory and OpenCode.

**Incomplete and required before daily use:**

- A graphical Memory Browser to inspect, confirm, edit, export, purge and pin memory; no production UI currently invokes the privileged confirmation operation.
- Full context checkpoint capture **before** a crash or compaction, semantic extraction of durable decisions, artifact references and exact message-level provenance.
- Resumption UI with validation and restart recovery, not simply a checkpoint row in SQLite.
- First-class Settings UI for adding shared stdio and HTTP MCP servers, OAuth and credential storage; current MCP tools are T3's own agent memory tools, not user-configurable external MCP servers.
- Verified task budgets, model routing, quota-drain A/B testing, and fully visible/editable plan execution UX beyond what upstream already supplies.
- Complete monorepo build/lint/test and macOS smoke tests; targeted CI is a preliminary gate only.

No new background triggers, cloud workers, mandatory isolation sandboxes, PostgreSQL, Temporal or NATS are introduced.

---

## 1. Product contract

Build a reliable macOS coding-agent workspace on top of T3 Code. The app coordinates Claude Code, Codex, Cursor, and custom OpenAI-compatible models, with OpenCode as an optional model-flexible runtime. A user must be able to hand off a request, inspect or edit a real plan, watch multiple agents complete dependent steps, choose local worktree or direct checkout execution, and return to the exact saved state later.

It runs only while the Mac is active. **No cloud orchestrator, no webhook trigger engine, no security sandbox or container requirement**. External services such as GitHub, Figma, and Slack can be tools that the user invokes, not automatic initiators.

Product promises:

1. **Never lose a committed step** merely because the app crashes, restarts, or a provider session stops.
2. **Memory survives model windows and provider changes**. Never rely solely on an LLM's current conversation context.
3. **Source-backed context**: every factual/project memory links to the file, conversation event, tool result, or user instruction that supports it.
4. **No silent memory invention**: proposed memory derived by an LLM is distinguishable from verified evidence and user-confirmed facts.
5. **Predictable agent spending**: token and quota visibility plus configurable hard limits on the harness's own activity.
6. **Native subscriptions first**: Claude Code, Codex, Cursor use their respective native execution/authentication paths; custom APIs use an appropriate compatible runtime.
7. **User-editable plans**: steps, dependencies, assignees, status, approvals, and artifacts visible in the UI.
8. **Configurable shared MCP servers** through the T3 UI, including HTTP and local stdio.
9. **No unapproved shared-checkout races**: serialized writes to the same path or isolation via optional worktrees.
10. **Reproducibility**: transitions, inputs, and tool effects have durable identifiers and can be audited.

## 2. What to reuse from T3 Code

Do not rebuild T3's Electron app, provider adapters, git UX, conversation projections, or event-oriented storage. Favor extending existing service contracts, SQLite migrations, UI settings patterns, and message/event projections.

Upstream already has newer Orchestration V2, cross-harness delegation, session adapters and quota presentation. This fork currently predates much of that work. **The first integration task is to compare fork main to upstream main** and rebase or selectively port while preserving the fork's OpenCode configuration injection and checkout-launch changes. Keep the fork's current main branch untouched until reviewed.

Upstream references worth reviewing and cherry-picking or reproducing:

- T3 Orchestration V2: task delegation, child threads, status, cancellation, task messages and graph.
- T3 Claude entrypoint fix: [PR #28410](https://github.com/pingdotgg/t3code/pull/28410), merged 2026-11-02.
- T3 Claude subagent cache TTL: [PR #22841](https://github.com/pingdotgg/t3code/pull/22841).
- T3 shared MCP proposal: [PR #16466](https://github.com/pingdotgg/t3code/pull/16466), **closed without merging**. Reference only; do not uncritically copy its credential or authorization design.

Our new modules should remain orthogonal to the provider runner, so they can be rebased onto newer upstream abstractions.

## 3. Architecture

```text
T3 Code macOS Desktop
  ├─ Thread UI / plan board / usage dashboard
  ├─ Settings / MCP registry / memory browser
  └─ Agent coordinator
       ├─ plan state machine and dependency scheduler
       ├─ execution leases and checkout/worktree mode
       ├─ budget controller and task cancellation
       ├─ context builder and memory checkpoint manager
       ├─ provider adapters
       │    ├─ Claude Code (native subscription runtime)
       │    ├─ Codex (native app-server/CLI runtime)
       │    ├─ Cursor (native agent runtime)
       │    └─ OpenCode/custom compatible API runtime
       └─ tool router / MCP gateway
            ├─ remote HTTP MCP servers
            ├─ local stdio MCP servers
            └─ optional GitHub, Slack, Figma tools

Local durable persistence (SQLite, WAL)
  ├─ existing orchestration events and projections
  ├─ structured agent/task/plan state
  ├─ durable memory facts and provenance
  ├─ context checkpoints and retrieval records
  ├─ token allocations/usage observations
  ├─ MCP server metadata (not plaintext secrets)
  └─ idempotency records for actions
Local artifact store (files, diffs, large transcripts, hashes)
macOS Keychain (tokens/credentials)
```

Single-user local deployment first. A future team/cloud edition can introduce separate workers, Temporal or a server database, but none are needed for this scope.

## 4. Memory is not one thing

**Four separate layers are required.**

### 4.1 Immutable conversation/event history

Keep the raw user messages, tool call metadata, significant tool results, agent replies and task transitions in an append-only event stream. Retention must be explicit and configurable. Do not substitute a summary for event history.

### 4.2 Durable structured memory

Facts, decisions, user preferences, project conventions, file references, constraints, failed approaches and unresolved questions are individually queryable records with scope, source, validity, confidence and revision history. A model may _propose_ a memory; it cannot silently mark a proposal as verified.

### 4.3 Context checkpoints

Persist a compact machine-readable snapshot of the task before compaction, provider switch, application shutdown, model failure or agent handoff. Checkpoints contain state references, not wholesale duplicated histories.

### 4.4 Ephemeral execution context

The current model's messages, prompt cache, tool exposure, speculative reasoning and local working buffer are ephemeral. Rebuild these from durable state when needed. Never treat cache hits as an integrity guarantee.

**Core rule:** the authoritative repository working tree, event log, plan state, and source-backed memories win over summaries if they disagree.

## 5. Memory taxonomy and scope

Types:

| Kind            | Examples                                                      | Typical retention                 |
| --------------- | ------------------------------------------------------------- | --------------------------------- |
| fact            | A service is written in C#; a repository contains a component | Until contradicted or expired     |
| decision        | The team chose a provider adapter and why                     | Durable with supersession         |
| preference      | Coding conventions, preferred review style                    | User/project scoped, editable     |
| constraint      | Do not modify production resources                            | Task/project until revoked        |
| file_reference  | Path, symbol, commit, design frame                            | Verify staleness before reuse     |
| failed_approach | A migration strategy failed and its failure mode              | Durable until obsolete            |
| open_question   | A design decision is unresolved                               | Until answered                    |
| procedure       | Verified command or workflow                                  | Versioned; never assume universal |
| outcome         | Tests passed at commit X                                      | Immutable evidence scoped to X    |

Scopes, in order of isolation:

- **Global**: explicit user-level preferences, never automatically derived from a private work project.
- **Workspace**: a configured repository set or organization/workspace identifier.
- **Project**: one repository or project root, using a stable project ID.
- **Thread**: one conversation.
- **Task**: one orchestration task and its child agents.

A memory is visible only when its scope is explicitly in the current retrieval context. Project A must never leak into Project B because names happen to match. Global promotion requires a conscious user action.

Each memory requires: stable ID, kind, text or structured value, scope type and ID, provenance refs, source actor, verification state, confidence (where meaningful), creation time, last verification time, supersession/tombstone status and schema version.

**Security and privacy policy** still apply even though user-requested sandboxing does not. Memory protection is separate from process sandboxing: store secrets in Keychain and never in memory/context, exclude credential material and optionally redact sensitive content. The app should expose memory deletion and export.

## 6. Memory lifecycle

### Capture

Capture from explicit user instructions, accepted plan changes, verified tool output, reviewed code changes and significant agent outcomes. Before an agent-proposed memory is saved, deduplicate by source identity or semantic similarity and check for scope conflicts.

### Verification

A tool-observed file path is not automatically a permanent fact. Store commit hash, file mtime or source version. On retrieval, mark it potentially stale if the source changes. User-confirmed preferences and project decisions are higher authority than model guesses.

### Retrieval

Use a deterministic candidate filter first:

1. match authorized scope(s);
2. remove tombstoned/superseded and expired records;
3. prefer exact source/project/file matches;
4. rank by relevance to the task, verification, recency and explicit user pinning;
5. account for token budget and deduplicate;
6. attach IDs and source links to the retrieved context.

A local SQLite FTS5 index is a good first retrieval method. Optional embeddings can improve semantic recall later, but the system must work offline without them. Avoid a large vector database at this scale.

### Contradiction handling

Conflicting facts should not silently overwrite each other. Supersede with an explicit replacement relationship, preserve history, and show conflicts in the memory browser. New tool output supersedes old source snapshots only after verification.

### Compaction

At milestone boundaries or projected context exhaustion, write a checkpoint first; verify it can be read; only then trim active context. Do not discard source event history because a summary was generated.

### Forget/delete

Users can inspect, pin, edit, delete and export memories. Deletion marks the item tombstoned and removes it from all retrieval paths. Physical purge of local memory, backups and derived indexes must be a separate explicit operation with clear effects. No auto-resurrection from old transcripts without a new capture event.

## 7. Checkpoint contract

A checkpoint is a versioned, durable snapshot of sufficient state to safely resume.

```json
{
  "checkpointId": "cp_...",
  "schemaVersion": 1,
  "workspaceId": "workspace_...",
  "projectId": "project_...",
  "threadId": "thread_...",
  "taskId": "task_...",
  "agentRunId": "run_...",
  "eventSequence": 418,
  "savedAt": "2026-11-10T19:00:00Z",
  "objective": "Implement the change with tests",
  "plan": {
    "planId": "plan_...",
    "revision": 5,
    "completedStepIds": ["step_1"],
    "runningStepIds": ["step_2"],
    "pendingStepIds": ["step_3"]
  },
  "state": {
    "done": ["Inspect existing implementation"],
    "next": ["Implement patch", "Run tests"],
    "blocked": [],
    "openQuestions": []
  },
  "workingTree": {
    "mode": "checkout",
    "repoId": "repo_...",
    "branch": "feat/example",
    "baseCommit": "abc...",
    "diffArtifactRef": "artifact://..."
  },
  "decisionMemoryIds": ["mem_..."],
  "contextArtifactRefs": ["artifact://..."],
  "sourceEventRefs": ["evt_..."],
  "provider": {
    "runtime": "claude",
    "nativeSessionId": "opaque-provider-session-id"
  },
  "tokenLedger": {
    "taskBudget": null,
    "spentKnown": 18342,
    "spentEstimated": 0
  }
}
```

Checkpoint writes must be atomic: either the old checkpoint remains valid or a complete new checkpoint appears. Append-only checkpoints are preferable. The latest is determined by sequence/revision, not solely timestamps. Recover from the last valid checkpoint and replay later events.

**On restart:** open database → check schema → replay any unapplied events → restore the plan graph and pending steps → inspect Git state → reattach provider sessions if supported → offer a visible Resume action. Never automatically repeat a potentially side-effecting operation without verifying its prior result.

## 8. Context-builder contract

The coordinator builds provider-neutral context in ordered layers:

1. immutable agent/task policy and tool boundaries;
2. user-approved objective and current plan revision;
3. minimal authoritative task state, scoped workspace/repository context;
4. verified memories with source refs;
5. current checkpoint and unresolved questions;
6. freshly retrieved files or external artifacts;
7. high-fidelity recent messages;
8. immediate user request.

Do not paste the full shared transcript into every child agent. Delegate only relevant context plus references that the child can query. A child should return a concise result with changed files, artifact refs, tests, decisions and unresolved issues, not a giant transcript.

Track:

- projected next-call context size versus model usable limit;
- tokens allocated to plan, implementation, review and memory;
- source refs actually retrieved;
- checkpoint age / last successful recovery;
- truncation and compaction events;
- provider-native and harness-generated token usage separately.

**Budget policy:** honor a per-call context limit, per-agent task budget and global task budget. A software spending cap must not be labeled hard if the provider does not expose timely usage or may bill in opaque subscription units. In that case stop conservatively by turn count, estimated tokens and concurrency.

## 9. Multi-step orchestration and visible plans

A task is a graph of steps with explicit dependencies. The plan belongs to the app, not to a transient prompt.

Each step has: id, title, acceptance criteria, state (proposed / approved / ready / running / blocked / complete / failed / canceled), dependencies, assigned provider/model, execution mode, context refs, artifacts, estimated and observed token usage, and attempts.

The UI must show:

- a plan board with checkboxes, dependencies and progress;
- ability to edit, reorder or approve plan steps;
- which agent/model is running and why;
- thread activity, delegation and messages;
- files changed, diffs, tests, errors, and completed artifacts;
- task budget and provider quota indicators;
- Pause, Resume, Cancel and Retry, each with clear semantics.

Default scheduler: sequential unless steps are provably independent. Run a reviewer when a risk or change-size policy asks for one. Execute deterministic checks (tests/lint/types) before spending model tokens on a second agent. When two agents may edit the same checkout, acquire a per-repo write lease or use separate Git worktrees.

No autonomous Slack events or recurring triggers. User explicitly starts a task, and its approved steps run while T3 is active.

## 10. Native provider and subscription adapters

Keep native execution modes distinct from raw API calls. A subscription-authenticated Claude/Codex/Cursor execution is **not** interchangeable with an Anthropic/OpenAI API-key call. Model name equality does not imply quota, capabilities, pricing or prompt semantics equality.

Suggested adapter contract:

```ts
interface NativeAgentAdapter {
  start(run: AgentRunRequest): Promise<AgentSession>;
  resume(nativeSessionId: string, input: AgentInput): Promise<AgentResult>;
  cancel(nativeSessionId: string): Promise<void>;
  getCapabilities(): Promise<AgentCapabilities>;
  getUsage?(nativeSessionId: string): Promise<ObservedUsage | undefined>;
}
```

For providers without reliable native session export, store a durable harness-owned handoff packet. Label imported summaries clearly; do not claim lossless resumption.

Custom OpenAI-compatible APIs should use OpenCode or a purpose-built runtime. Keep model catalog, base URL, context window, tool calling, cost, thinking flags and reasoning models configurable. Never force custom models into the Claude or Cursor subscription path.

## 11. Token and quota efficiency — release blocker

A historical T3 issue caused significantly greater consumption of Claude's five-hour quota through its Agent SDK invocation compared with interactive Claude Code on equivalent workloads. Upstream merged entrypoint labeling changes in Nov 2026. Carry that fix into this fork and benchmark it on the target setup before declaring it solved.

Metrics to surface separately:

- observed input/output/cache-read/cache-write tokens;
- requests and tools per agent and task;
- native five-hour/weekly subscription quota utilization, if provider exposes it;
- API monetary costs, where actual billing data is available;
- estimated costs when actual values are not exposed, explicitly labeled;
- planning/review/delegation overhead versus useful coding activity.

Never make an inference call solely to refresh a quota meter without the user opting in.

**Benchmark gate**: A/B test T3 and native interactive Claude Code with the same model, effort, cached context and comparable prompts. Run multiple alternating trials and record pre/post 5h and weekly utilization. The result must be close enough to native for user acceptance; don't publish an invented universal threshold.

Efficiency features:

- avoid default duplicate planners/reviewers;
- reuse native provider sessions when viable;
- lazy-load MCP tool schemas rather than listing all tools in every turn;
- don't feed every child the whole task transcript;
- avoid auto retrying model calls on malformed results more than a bounded number;
- expose cache TTL controls rather than enforcing one globally;
- require explicit consent to exceed task budget.

## 12. Shared MCP management through the UI

This is a core feature, not manual JSON editing.

**Settings → Integrations → MCP Servers**:

- Add local stdio command/arguments/working directory/environment references.
- Add remote Streamable HTTP MCP endpoint (with compatibility fallback if appropriate).
- Name/description, enable/disable, edit, remove, duplicate.
- Test connection, protocol version and discovered tools.
- OAuth sign-in and refresh; API token/header options; never display stored secrets.
- Agent enablement matrix: Claude, Codex, Cursor, OpenCode/custom.
- Global/project/thread scopes and tool allowlists/denylists.
- Show connection health and errors without leaking credentials.
- Prevent duplicate registrations and accidental injection on reconnect.
- OAuth identity must be visible: an environment-shared credential cannot be misrepresented as the individual user running a thread.
- Clearly distinguish T3's own orchestration MCP from user-installed MCP servers.

For stdio, use direct managed child-process lifecycle with timeouts and clean shutdown. For HTTP, a local proxy is acceptable when an agent runtime cannot accept the user's endpoint directly; scope each proxy credential to a thread and tool permissions.

PR #16466 is a useful reference implementation, **not merged**; its review raised correctness and credential-behavior concerns. Implement tests around credential redaction, OAuth callbacks, tool routing, reconnect and per-agent permissions.

## 13. Durable storage design

Use T3's SQLite database with WAL and migrations. Large artifacts go on disk with checksums and stable references, not into giant database rows. Use transactions for committed memory changes, checkpoint updates, event/audit append and task-state changes.

Initial proposed tables:

```sql
CREATE TABLE agent_memory_items (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_actor TEXT NOT NULL,
  verification TEXT NOT NULL,
  confidence REAL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  superseded_by TEXT,
  tombstoned_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_memory_checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  task_id TEXT,
  sequence INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_memory_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
```

Add scope, status, chronological and checkpoint indexes. Use FTS5 in a follow-up migration if the bundled SQLite build supports it; retain non-FTS fallback.

The initial migration is intentionally additive and does not rewrite T3's core orchestration tables. Provider/session integration occurs through a service API, never direct ad-hoc SQL from UI components.

## 14. Repository and task memory

When opening a project, the context-builder should be able to read a **versioned workspace profile**:

- repository name/root, language and framework;
- instructions from AGENTS.md/CLAUDE.md and user-approved conventions;
- build/test/lint commands and required tools;
- recent relevant commits or changed files;
- verified architectural decisions and known failure modes;
- index of important symbols/files;
- active plan and latest valid checkpoint.

Do not store entire repository files as permanent memories. Store file references with revisions and retrieve current content on demand. Provide a per-project **Memory** screen where the user can inspect, correct, pin and remove records.

The system should learn useful context during actual work, not continuously crawl every private repository without the user asking.

## 15. Recovery semantics and idempotency

Failures to test:

- app killed before checkpoint write;
- app killed immediately after checkpoint commit;
- provider responds then connection drops;
- tool write succeeds but acknowledgment times out;
- half-completed plan step;
- duplicate callback or user Retry;
- changed Git HEAD during a paused task;
- stale memory from a previous branch;
- canceled agent continues producing output;
- unreadable provider-native session;
- corrupted or unsupported checkpoint schema.

Every side-effecting operation gets an operation ID and durable status. Before retrying a write, verify whether the effect already happened. A resumption prompts for review when the filesystem or Git base has diverged.

Memory and context data should always be exportable into a versioned JSON/Markdown bundle and restorable with clear scope mapping. Include backup checksums and restoration tests.

## 16. Acceptance tests

**Memory:**

- Save a verified project decision, restart T3, retrieve the same ID and provenance.
- Save two conflicting candidate facts; neither silently deletes the other.
- A task for Project B cannot retrieve Project A facts without an explicit shared scope.
- Delete a memory and verify it is excluded from retrieval, checkpoint assembly and UI.
- Checkpoint twice, crash, recover the later complete checkpoint.
- Simulate corrupted checkpoint JSON; fall back to last valid checkpoint.
- Export/reimport and verify content IDs, provenance and tombstones.
- Save large raw tool artifacts externally and retrieve by checksum.

**Context:**

- A delegated agent gets a bounded context payload, not the full history.
- Provider change preserves plan, decisions and unresolved issues.
- Relevance ordering, pinning and budget limits are deterministic for given inputs.
- Compaction preserves source refs and task outcome.

**MCP:**

- stdio and HTTP connections can be configured from UI without manual JSON.
- Enabled server reaches selected providers only.
- OAuth/header credentials never enter logs or prompt text.
- Bad server/expired token does not crash unrelated agent sessions.
- Reconnection removes stale registrations.

**Orchestration:**

- Plan edit increments revision and invalidates stale scheduled steps.
- Dependent step never runs before prerequisites complete.
- Concurrent same-checkout writers serialize or require worktrees.
- Cancel prevents new work and marks in-flight work accurately.
- Closed/reopened app displays the exact durable plan state.

**Quota:**

- Monitor probes do not silently consume inference tokens.
- Task budget prevents unbounded child spawning.
- Claude 5h usage is benchmarked against native CLI with the merged fix.
- Actual versus estimated token numbers are clearly distinguished.

## 17. Incremental implementation phases

### Phase 0 — current branch: spec and memory persistence foundation

- [x] Create isolated feature branch in the owner's T3 fork.
- [x] Check in this end-to-end architecture specification.
- [x] Add additive SQLite memory/checkpoint/audit migration.
- [x] Add typed memory interfaces and initial persistence functions.
- [x] Add tests for durable write/read, project scope and checkpoint ordering (focused tests passed in CI; typecheck and wider regressions still under validation).
- [x] Add documentation on the exact current implementation status (see fork README).
- [x] Run focused memory and OpenCode tests in GitHub Actions (typecheck validation is a separate pending gate).

### Phase 1 — reconcile upstream safely

- [x] Compare fork's May 2026 base to current upstream and establish a separate integration branch from upstream commit d756fed.
- [x] Port custom OpenCode JSONC UI injection and safe checkout launches to packages/provider-opencode.
- [x] Start from upstream T3 Orchestration V2 at pinned base d756fed instead of trying to replay incompatible May migrations.
- [x] Include upstream's merged Claude entrypoint and cache TTL fixes by basing this work on post-merge upstream; A/B quota benchmark pending.
- [ ] Run existing upstream and fork regression tests.

### Phase 2 — memory/context end-to-end

- [x] Wire bounded verified project/thread memories into fresh provider sessions and checkpoint IDs into run finalization; broader capture/recovery still pending.
- [ ] Persist checkpoint before context compaction, agent delegation and provider switch.
- [ ] Build scoped memory browser with review/confirm/pin/edit/delete/export.
- [ ] Introduce FTS5 retrieval with source-backed relevance and staleness checks.
- [ ] Add robust checkpoint restore and provider-session handoff UI.
- [ ] Add encrypted/Keychain-backed settings when they contain credentials (current memory schema stores no tool secrets).

### Phase 3 — MCP management

- [ ] MCP registry UI for HTTP and stdio.
- [ ] Local MCP process supervision and remote proxy.
- [ ] OAuth and secret handling.
- [ ] Per-provider and per-project selection, tool search/filters.
- [ ] Cross-provider reconnect and failure tests.

### Phase 4 — orchestration UX and budgets

- [ ] Editable plan graph, dependency scheduler and step artifacts.
- [ ] Step and task budget control with subscription-aware reporting.
- [ ] Native/direct checkout versus Git worktree selection.
- [ ] Agent routing defaults, optional review and deterministic verification.
- [ ] Performance A/B benchmark suite and usage dashboard improvements.

### Phase 5 — hardening

- [ ] Crash/restart/duplicate retry matrix.
- [ ] Upstream upgrade compatibility tests.
- [ ] Full local backup, export/import and deletion verification.
- [ ] Load tests for long tasks, MCP catalogs and large memory.
- [ ] One-click macOS developer setup/build instructions.

## 18. Non-goals

- Mandatory OCI sandboxes for local coding agents.
- Multi-user SaaS, remote always-on orchestrator, webhook-triggered tasks.
- Kubernetes, Temporal, PostgreSQL, NATS or Redis for a single Mac.
- Silent scraping of unrelated private projects.
- Invisible automatic cross-project memory sharing.
- Claiming a complete native provider conversation can always be reconstructed.
- Treating subscription quota as a monetary API balance.

## 19. Engineering guidance

1. Prefer a thin vertical slice with persistence, tests and UI over speculative large frameworks.
2. Treat provider-specific behavior as explicit capabilities, not hidden assumptions.
3. Keep migrations additive and idempotent; do not rename T3 tables without a data migration.
4. Never write a model-generated statement to verified memory without evidence or confirmation.
5. Keep checkpoints small, structured, versioned, replayable and independent of model format.
6. Store source references and actual runtime identity for every agent action.
7. Use visible errors for uncertainty, stale context and unverifiable quota.
8. Do not merge an old fork with upstream without reviewing the diff and resolving custom changes.
9. Maintain at least one test for each lost-context or quota-drain regression.
10. Update this document after shipping each vertical slice: specification boxes are not implementation evidence.

## 20. Definition of done

The first usable release must let the user start a multi-step task in T3 on macOS, edit the plan, select Claude/Codex/Cursor/custom models, choose direct checkout or worktree, configure MCP servers via UI, and pause/restart/recover with intact approved plan, source-backed memories, selected files and task status. It must expose accurate token/quota measurements where available and not knowingly reproduce the historical accelerated Claude five-hour drain.

**Memory durability and context recovery are release blockers.** A pretty plan board without those guarantees is not a finished harness.

---

## 21. Consolidated PR #3 gap closure and release gates (2026-11-10)

Historical consolidation note: PR #3 has merged. Continue all release-gate implementation in **draft PR #8**; do not open competing feature PRs. Issues #4–#7 remain tracked requirements, not proof that any feature is complete. Do not merge this draft just because a particular focused test passes.

### Verified implementation increments

- Checkpoint reader now supports `recoverCheckpoint({ projectId, threadId })` with an exact project/thread predicate, schema-version validation, and fallback to a previous valid snapshot when later JSON is corrupt. The result reports how many later snapshots were rejected. This **does not** reconstruct side effects, provider session state, or replay events.
- The legacy `latestCheckpoint(threadId)` is preserved for existing call sites, but host-facing recovery should use the scoped API.
- `exportMemory(scopes)` exports bounded, non-deleted records for explicitly authorized scopes and preserves source references. This is a **live-memory snapshot**, not a full backup/restore with tombstones, event history or artifact files.
- New tests exercise corrupt-latest fallback, cross-project checkpoint isolation, and memory export scope isolation. CI remains the authority for passing status.

### Required before production-ready claim

| Area             | Required implementation                                                                                                                                                                    | Gate                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Memory UI        | Accessible browser, authenticated confirm/decline, edit-as-revision, pin, supersede, tombstone, full export/import with audit and source links                                             | Browser E2E + scope/privilege/restart tests                                                         |
| MCP UI           | UI CRUD/test/health for HTTP + stdio, canonical server-scoped credential references via macOS Keychain, OAuth PKCE/state, explicit provider/project authorization and tool allowlists      | Real stdio/HTTP integration tests, credential redaction, disconnect/reconnect, cross-provider tests |
| Crash resilience | Checkpoint before compaction/delegation/handoff and at safe boundaries, event cursor, idempotent effect ledger, Git HEAD/file fingerprint check, checkpoint browser + user-approved Resume | Kill/relaunch matrix at every side-effect boundary, corruption and divergent HEAD tests             |
| Plans            | Persist editable plan steps/revisions/dependencies/artifacts; scheduler rejects stale revisions, defaults sequential; checkout locks/worktree isolation; cancellation/retry semantics      | Deterministic state machine and concurrent-writer tests                                             |
| Token efficiency | Separate native subscription vs metered API paths, per-run/task/child hard caps where observable, provider-specific telemetry with unknown labels, no token-spending polling               | Controlled Claude Code vs T3 A/B macOS runs; no unaudited inference/background agents               |
| Compatibility    | Source-checkout and packaged Mac smoke runs; Cursor/OpenCode/Claude/Codex/custom routes; full mono-repo typecheck/lint/tests and upstream integration audit                                | Required CI green plus manual Mac launch and provider smoke tests                                   |

### Explicit recovery decision model

1. Identify the canonical project and thread from the trusted host, **not** model-provided IDs.
2. Select the newest compatible checkpoint under that exact scope. If corrupt, show a warning and offer the last valid one; retain invalid rows for forensic inspection.
3. Compare saved branch, HEAD and referenced artifacts with the actual working tree. Never silently execute a stale plan.
4. Replay only committed canonical events after the snapshot's event cursor **once that cursor has been implemented**. A run ordinal is not an event cursor.
5. Determine which external tool operations committed. Require human review for any ambiguous write/side effect; never blindly retry.
6. Resume a compatible native provider session if verifiable, otherwise show a bounded, source-backed handoff packet and explicitly label it lossy.
7. The user confirms Resume; do not start agents autonomously on app launch.

### Security constraints on MCP and memory

- Only trusted host-authenticated UI calls may confirm or mutate user-trusted memories. Agent MCP tools may only propose/search within their canonical scope.
- Store credentials by opaque Keychain reference; never in SQLite, audit payloads, shell history, model prompts, logs, exports, or shared MCP server descriptions.
- Enforce tool visibility and invocation permissions on **every call**, not just when presenting the tool catalog. A provider cannot self-assign access.
- Reject unsafe stdio command arguments and unknown working directories at the UI boundary. Local stdio processes run with the user's OS permissions; clearly display that risk.
- Audit edits, grants, revocations and side effects with stable operation identifiers and source provenance. Treat untrusted tool output as data rather than instructions.
- Do not auto-share private-project memories with global/workspace scopes or other projects.

### Operating and token-drain defaults

- No scheduled triggers and no always-on background orchestration. Work proceeds only during a user-started task while the Mac is active.
- Sequential steps and maximum one active writer per checkout by default. Parallelism requires disjoint operations or isolated worktrees.
- No duplicate plan/review/critique model calls unless explicitly requested. Cache compact context by source revision and inject only on fresh sessions.
- Enforce adapter-visible turn/delegation/parallelism caps even when native providers do not report authoritative token usage. Where a strict token cap cannot be measured, mark it **unavailable**, never pretend to enforce one.
- Do not claim Claude five-hour subscription quota parity until controlled A/B telemetry is recorded; estimated tokens are not subscription quota percentages.

---

## 22. Post-merge work (PR #3 merged; new release-gates branch)

The merged PR #3 supplies the memory browser, live-only export, scoped checkpoint inspection and a configurable MCP registry. Those are foundations, **not** production release gates.

The new `feat/macos-harness-release-gates` branch adds a **full memory ledger backup/restore** distinct from the older live-only export. The version-2 scoped JSON includes source provenance, audit events, all revision ancestors, superseded entries, tombstones, and project-scoped checkpoint rows (not external Git artifacts or provider-native sessions). The import path checks a SHA-256 integrity checksum, requires an exact selected scope, rejects conflicting IDs, is atomic across entries/events, and is safe to retry. Its frontend is exposed under project Memory settings. A checksum prevents accidental corruption; it does not authenticate an untrusted backup. Backup remains a manual user action; it never copies one project's data into another.

New tests cover tombstoned/revised history, project checkpoint restoration, scoped checkpoint history browsing with corrupt-entry fallback, repeated import, corruption, and cross-project restore refusal. Memory UI filters now include kind, verification, and pinned status; checkpoint selection is inspection only, not execution resume. CI results and a real macOS application smoke test are necessary before treating these as validated.

A read-only checkpoint inspector now compares the saved HEAD and branch with the current trusted project worktree and marks a mismatch or dirty checkout. It reports unverified state if the saved commit or current Git state cannot be read, and never resumes/replays agent work.

New final-run context checkpoints also record the Git HEAD SHA when the local checkout is readable. This is evidence for a future divergence check, **not** automatic recovery approval or a substitute for changed-file fingerprints.

**Still required:** native macOS Keychain/OAuth MCP support and health checks; pre-handoff checkpoints, event-cursor replay and Git divergence guards; persisted editable dependency plans, scheduling and checkout locks; trustworthy turn budgets and a measured native Claude A/B comparison; full release smoke and security verification. Do not mark these complete just because memory backup has landed.

## 23. Further post-merge safeguards

- Final-run memory checkpoints now record the canonical thread event high-water
  mark (separate from the run ordinal), as well as Git HEAD when available.
  This allows future recovery to replay only later committed events, but does
  **not** imply automatic side-effect-safe replay.
- The UI offers project- and thread-scoped memory browsing. Common plaintext
  credentials are refused during memory creation, revision and backup import;
  this is a heuristic safety guard, not full DLP or a replacement for Keychain.
- The optional persisted **maximum native provider runs per thread** setting
  stops further native run starts once the canonical run ordinal exceeds the
  cap. Zero is unlimited. Native child turns within one provider run, task-wide
  budgets, cancellation and delegation concurrency are not yet capped.
- `scripts/claudeQuotaBenchmark.ts` accepts recorded native Claude Code/T3
  subscription meter deltas in paired, alternating order, with identical model,
  effort, prompt/context fingerprints and token telemetry. It never calls a
  model or converts token counts into subscription quota claims. The actual
  macOS A/B data has not been collected; no quota parity is claimed.

**Release blockers remain:** upstream Mac smoke tests, shared credentialed
MCP/OAuth and health, pre-handoff/compaction/shutdown capture, safe user-approved
resume with file/side-effect verification, editable dependency scheduler and
native child-agent budgets. Keep PR #8 draft until real validation passes.

## 24. Upstream migration collision (11 November 2026)

Upstream introduced `081_ProjectionMessageSearchText` after this fork assigned
migration 81 to AgentMemory and 82 to AgentMemorySearch. **Do not overwrite the
fork's migration 81**: existing users have already committed that history.
This branch carries the upstream message-search upgrade as fork migration 83,
including idempotent search-text backfill and trigger recreation. A database
whose migration journal contains upstream `81_ProjectionMessageSearchText`
is explicitly reconciled by creating the fork's memory tables before migration
82, without rewriting its journal. Unknown divergent histories still fail closed.

This migration is necessary for upstream compatibility but does **not** mean
all upstream commits have been merged. After an upstream merge, retain these
fork migration IDs, audit the newest upstream migration manifest for further
collisions, and run migration tests on a copy of both fork-upgraded and
upstream-upgraded SQLite databases before release.

## 25. Persisted plan state-machine foundation (11 November 2026)

Migration 84 stores scoped, revisioned multi-step plans per thread. The pure
state-machine rejects cycles, missing dependencies, stale revisions, deleting
active/completed steps and simultaneous writers in one checkout. The default
ready queue is sequential. Explicit parallel selection requires independent
steps and distinct host-verified checkout identities. Persisted changes use an
optimistic expected-revision guard. Tests exercise dependency order, persistence
and isolation. **This does not launch agents, lock a real filesystem, cancel a
provider or provide the editable plan UI.** Those remain P0 release blockers.

## 26. User-facing plan editor (11 November 2026)

Authenticated, project/thread-verified RPC endpoints expose create/read/edit and
state transitions for revisioned harness plans. The project Settings plan editor
can create a linear plan, edit pending steps and track step status. Host-side
scope checks enforce thread ownership before reading or writing plan data.
This is **manual plan tracking**, not automatic provider execution or native
subagent delegation. No on-launch auto-run, automatic triggers, or background
agent is introduced. Real agent scheduler integration and crash-safe resume
remain release blockers.

## 27. Hosted macOS build gate (11 November 2026)

A dedicated `.github/workflows/fork-macos-smoke.yml` workflow compiles the
desktop using a GitHub-hosted macOS runner and validates its preload bundle
plus plan/migration/memory regressions. This requires no credentials and does
not call paid agents. Passing this workflow is **not** equivalent to a signed
macOS package, real Keychain/OAuth tests, provider sessions, crash/restart E2E
or an actual Claude subscription quota benchmark. Those release gates remain.
