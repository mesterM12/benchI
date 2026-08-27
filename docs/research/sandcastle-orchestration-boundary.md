# Sandcastle orchestration boundary

Research question: [benchI issue #5](https://github.com/mesterM12/benchI/issues/5)

## Decision

benchI should treat Sandcastle as its **coding-agent execution and workspace runtime**, not as its benchmark scheduler or system of record.

Delegate to Sandcastle: coding-agent CLI adaptation, sandbox creation, git worktree/branch mechanics, prompt-file expansion, lifecycle setup, live agent-output parsing, idle/completion timeouts, session capture/resume/fork where supported, commit collection, and structured-output extraction.

Keep in benchI: benchmark/run/case identity, dataset and prompt assembly, matrix expansion, concurrency and queueing, retries caused by infrastructure or benchmark policy, cancellation state and enforcement, scoring/judging, cost calculation and budgets, durable event/result storage, artifact retention, cross-run aggregation, and safe fan-out/merge policy.

The narrow integration should call Sandcastle's public TypeScript API and translate its results/events into benchI's domain. It should not invoke Sandcastle templates as an internal protocol or depend on Effect services and unexported classes.

## Scope and revision

Research was performed by direct inspection of `mattpocock/sandcastle`, updated under `~/.btca/agent/sandbox/sandcastle`, at commit [`e99f832f26dc9d245c019a9ddd19fa5dee792427`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427), package version `0.12.0` ([package manifest](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json#L1-L35)). All source citations below are pinned to that revision. The repository and its ADRs are primary sources; no third-party descriptions were used.

## Public APIs benchI can rely on

The root package exports the following relevant API ([public barrel](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/index.ts#L1-L100)):

| API | Sandcastle ownership | Recommended benchI use |
| --- | --- | --- |
| `run(options)` | One-shot sandbox/worktree lifecycle, agent iterations, completion detection, commits and optional typed output | Default primitive for an independent benchmark case |
| `createSandbox(options)` | Explicit-branch, long-lived sandbox with `run`, `interactive`, `exec`, `close`, async disposal | Multi-turn cases or implement/verify/review inside one warm environment |
| `createWorktree(options)` | Long-lived worktree with `run`, `interactive`, `createSandbox`, `close` | Only when benchI must retain workspace identity across sandbox sessions |
| `interactive(options)` | Agent TUI plus the same workspace/commit lifecycle | Human investigation, not unattended benchmark execution |
| `Output.object/string` | XML-tag extraction, Standard Schema validation, optional same-session correction retries | Machine-readable agent outputs; benchI still owns scoring |

`run()` returns iterations, matched completion signal, combined stdout, commits, branch, optional log path/preserved worktree, and conditional `resume`/`fork` methods ([types](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L332-L479)). `createSandbox()` exposes direct `exec`; non-zero exit is returned rather than thrown ([handle contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.ts#L219-L263)). benchI should inspect `exitCode` for gates.

Branch strategies are:

- `head`: writes into the host checkout; bind-mount/no-sandbox only.
- `merge-to-head`: temporary worktree/branch, then merge and delete.
- `branch`: named persistent branch, optionally based on `baseBranch`.

The types and restrictions are authoritative in [`SandboxProvider.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L243-L303). For benchmark isolation, benchI should normally assign a unique named branch per case. It should avoid `head`, and use `merge-to-head` only for deliberately serialized workflows.

## All built-in coding-agent harnesses

Six agent factories are exported: `claudeCode`, `codex`, `copilot`, `cursor`, `opencode`, and `pi` ([exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/index.ts#L54-L73)). Each adapts command construction and JSONL parsing behind `AgentProvider`, whose extension contract is `name`, `env`, `captureSessions`, optional `sessionStorage`, print/interactive command builders, stream parser, and optional session usage parser ([interface](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L202-L277)).

| Harness | Main options | Resume/session | Usage surfaced |
| --- | --- | --- | --- |
| Claude Code | model, effort, permission mode, env | Yes; file capture, resume and fork; capture default on | Four raw token counters parsed from captured session |
| Codex | model, effort, approvals reviewer, env | Yes; file capture, resume and fork; capture default on | Four normalized counters from `turn.completed` |
| Pi | model, thinking, env | Yes; file capture and resume; capture default on | None |
| Cursor | model, env | No | None |
| OpenCode | model, variant, internal agent/mode, env | No; SQLite-backed state deliberately unsupported | None |
| GitHub Copilot CLI | model, effort, env | No; session file alone is insufficient because of its index | None |

Provider source: Pi ([factory](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L613-L665)), Codex ([factory and stream usage](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L699-L825)), Cursor and OpenCode ([factories](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L827-L998)), Copilot ([factory](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L1101-L1149)), Claude Code ([factory and usage parser](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L1155-L1267)).

Important constraints:

- Cursor and Copilot pass prompts in argv and reject prompts over 120 KiB; other built-ins use stdin ([Cursor guard](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L123-L136), [Copilot guard](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L1004-L1019)). benchI must preflight or choose a compatible harness for large contexts.
- Sandcastle's resumability rule is intentionally filesystem-backed per-session state; database internals are not an extension target ([ADR 0016](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0016-resume-requires-filesystem-backed-sessions.md#L3-L22)).
- `resumeSession` is restricted to one iteration. `resume()` and `fork()` are convenience methods on successful results when a session ID was captured ([validation and result types](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L431-L478)).
- The generic result builder exposes `fork()` for any provider with session storage, including Pi, but Pi's command builder ignores `forkSession` and uses `--session` ([Pi command](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L628-L653)). benchI may rely on fork isolation only for Claude Code and Codex at this revision.

benchI should use these adapters rather than shelling out to agent CLIs or parsing each vendor's events itself. It should record provider/model/options as benchmark configuration, because Sandcastle does not define benchmark equivalence among them.

## All built-in sandbox harnesses and directives

The package exports five sandbox entry points ([package exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json#L8-L32)):

| Sandbox | Type | Relevant directives |
| --- | --- | --- |
| Docker | Bind mount | image, UID/GID, mounts/read-only, SELinux label, env, networks, groups, devices, CPU limit, retained output-tail size |
| Podman | Bind mount | image, rootless user namespace, UID/GID, mounts/read-only, SELinux label, env, networks, groups, devices, CPU limit, output tail |
| Vercel | Isolated | source, ports, timeout, vCPUs, runtime/template, network policy, project/team/token, env, output tail |
| Daytona | Isolated | API key/URL/target, SDK image/snapshot creation options, env, output tail |
| No-sandbox | Host process | env, output tail; no container isolation |

The exact option surfaces are in [Docker](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/docker.ts#L37-L147), [Podman](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/podman.ts#L36-L164), [Vercel](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/vercel.ts#L25-L138), [Daytona](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/daytona.ts#L25-L95), and [no-sandbox](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/no-sandbox.ts#L24-L52).

Generic run directives worth delegating are `cwd`, branch strategy, prompt source/args, max iterations, hooks, logging, completion signals, idle/completion timeouts, `copyToWorktree`, lifecycle timeouts, resume signal, abort signal, and structured output ([`RunOptions`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L320-L427)). Environment is merged from `.sandcastle/.env`, agent-provider env, and sandbox-provider env before launch ([implementation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L618-L626)). benchI should provide secrets through this supported env path but own secret lookup/redaction policy.

Prompt-file directives are:

- `{{KEY}}` substitution, plus reserved `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}`.
- ``!`command` `` expansion inside the sandbox after setup hooks; expansions run in parallel and fail the run on non-zero exit.
- Inline prompts are literal and reject `promptArgs`.
- Completion text defaults to `<promise>COMPLETE</promise>` but is only detected, never injected.

These semantics are documented and implemented in the upstream README ([prompt rules](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L645)). benchI should assemble benchmark prompts and explicit completion instructions, then let Sandcastle perform sandbox-local expansion.

## Lifecycle and events

Public lifecycle hooks are only:

- `host.onWorktreeReady[]`: sequential host commands after worktree/copies.
- `host.onSandboxReady[]`: host commands after sandbox setup.
- `sandbox.onSandboxReady[]`: sandbox commands, with optional `sudo`.

Each hook accepts `command` and optional `timeoutMs`; sandbox hooks additionally accept `sudo`. The two `onSandboxReady` groups run concurrently, while commands within each group are assembled as independent concurrent effects, despite comments describing arrays sequentially ([hook types and execution](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L86-L141), [ready execution](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L266-L365)). Therefore hooks must not depend on order. There are no public before/after-iteration, commit, merge, teardown, or error callbacks. benchI owns those workflow events around calls.

Sandcastle performs safe-directory/git identity setup, runs ready hooks, records base HEAD, invokes work, syncs isolated files, merges where applicable, and collects commits ([lifecycle](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L178-L544)). `createSandbox` and `createWorktree` handles support explicit and `await using` cleanup; dirty worktrees are preserved ([worktree cleanup](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createWorktree.ts#L258-L278)). benchI should always close handles in `finally`/`await using` and persist any preservation path as an artifact.

## Streaming

`logging: { type: "file", path, onAgentStreamEvent, verbose }` is the only public typed event callback. The callback receives:

- `{ type: "text", message, iteration, timestamp }`
- `{ type: "toolCall", name, formattedArgs, iteration, timestamp }`
- `{ type: "raw", line, iteration, timestamp }`

The schema is [`AgentStreamEvent`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentStreamEmitter.ts#L3-L35). Raw is emitted before provider parsing; typed tool calls are provider-normalized and sometimes allowlisted ([orchestrator emission](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L418-L456)). Callback failures are swallowed, and the callback is unavailable in stdout logging mode ([handler](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L217-L291)).

This is an observability stream, not a durable lifecycle protocol: it has no run ID, sequence number, usage/result/session/commit/error event, async backpressure, replay, or delivery guarantee. benchI should attach its own IDs and sequence/timestamp envelope, persist events, derive lifecycle events around API calls, and treat typed text/tool events as display data. Capture `raw` only under an explicit debug/retention policy because it may contain sensitive prompts or tool output.

Provider `exec` implementations must stream line by line for live feedback and idle timeout enforcement ([provider contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L23-L63)). Built-ins bound retained streamed stdout/stderr tails while still delivering all lines, so `result.stdout` is not necessarily a complete raw transcript for very large output; benchI should persist callback events when full observability is required.

## Usage and cost

`IterationUsage` contains only `inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, and `outputTokens` ([schema](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L225-L231)). At this revision:

- Claude usage is read from the last assistant message in its captured JSONL.
- Codex usage is read from `turn.completed`; cached input is split from total input to avoid double counting.
- Other built-ins return no usage.
- Usage is per iteration and optional; no aggregate is returned.
- There is no currency, price, billed-token, context-window-size, duration, or provider request metadata.

Upstream explicitly rejected context percentages because no reliable context limit is available ([ADR](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0005-usage-raw-tokens-no-percentage.md#L1-L13)). benchI must own usage normalization, aggregation, model/provider pricing tables with effective dates, monetary cost, budget enforcement, and an `unknown` state rather than treating missing usage as zero.

## Cancellation and timeout behavior

The intended public cancellation contract is `signal?: AbortSignal` on run/interactive operations, not on `createSandbox`/`createWorktree`: pre-abort rejects before setup; mid-operation rejects with `signal.reason`; worktrees are preserved; reusable handles remain caller-owned ([ADR 0004](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0004-abort-signal-on-run-and-interactive.md#L1-L11), [`RunOptions`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L399-L409)). Sandcastle also provides:

- Idle timeout, default 600 seconds, reset by each stdout line; expiry fails.
- Completion timeout, default 60 seconds after a completion signal, reset by later lines; expiry succeeds with buffered output.
- Hook timeout, default 60 seconds per hook.
- Configurable copy, git setup, commit collection, and merge timeouts.

The idle/completion race is implemented in [`Orchestrator.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L20-L244); lifecycle defaults are in [`SandboxLifecycle.ts`](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L19-L27).

**Cancellation caveat at this revision:** the ADR says the in-flight subprocess is killed, but the public provider `exec` contract has no `AbortSignal` or kill method ([contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L23-L63)). Agent cancellation races the exec promise against a deferred abort ([source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L123-L138), [race](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts#L221-L243)); interactive reusable-sandbox cancellation similarly rejects without calling a provider kill primitive ([source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.ts#L629-L663)). Built-in Docker and no-sandbox `exec` spawn child processes but expose no abort listener in their handles ([Docker](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/docker.ts#L247-L300), [no-sandbox](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/sandboxes/no-sandbox.ts#L54-L135)).

Consequently benchI can rely on prompt rejection and Sandcastle cleanup/error paths, but should **not yet claim hard process termination**, especially for reusable sandboxes or no-sandbox runs. benchI should own cancellation state, stop scheduling follow-on work, pass the signal, close disposable sandboxes where safe, apply an outer deadline, and record a distinct `cancelling`/`cancelled` outcome. If hard kill is required, upstream needs an abort-capable provider-handle contract and end-to-end tests; benchI should not patch individual providers privately.

## Extension seams

Intended seams to use:

- **Custom agent provider:** implement `AgentProvider`; resumable providers additionally own session storage, transfer and stream session IDs. This is explicitly designed to be additive ([ADR 0012](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0012-agent-provider-owned-session-storage.md#L3-L17), [consequence](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0012-agent-provider-owned-session-storage.md#L25-L32)).
- **Custom sandbox provider:** use `createBindMountSandboxProvider` or `createIsolatedSandboxProvider` and implement the small Promise API for create/exec/stream/copy/close ([factories](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts#L305-L330)).
- **Workflow composition:** ordinary TypeScript around `run`, `createSandbox`, and `createWorktree`; Sandcastle templates demonstrate this but are scaffolding, not runtime plugins.
- **Observability:** file-mode `onAgentStreamEvent`, supplemented by result/error wrapping in benchI.
- **Structured output:** Standard Schema through `Output.object`, with optional same-session retries ([API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Output.ts#L7-L47)).

Seams not present: scheduler/queue adapter, benchmark/test-case interface, judge/scorer, durable event store, pricing adapter, artifact backend, general middleware, arbitrary lifecycle callback, cancellation driver, or merge coordinator. Those belong in benchI.

## Delegation matrix

| Concern | Delegate to Sandcastle | benchI owns |
| --- | --- | --- |
| Agent invocation | Built-in/custom `AgentProvider`, CLI flags, JSONL parsing | Provider/model selection policy and compatibility metadata |
| Isolation | Provider creation, mounts/copy/sync/close | Security profile, capacity placement, credentials policy |
| Git | Worktree, branch strategy, merge, commit discovery | Unique branch naming, concurrency safety, retention and final integration policy |
| Prompt execution | File resolution, substitutions, sandbox command expansion | Dataset/context selection, prompt templates/versioning, completion instruction |
| Iteration | `maxIterations`, completion and idle timers | Case-level retry policy and attempt identity |
| Session | Capture/resume/fork for Claude/Codex/Pi | Whether continuity is valid for a benchmark; lineage in durable records |
| Structured result | Tag extraction/schema validation/correction retry | Benchmark result schema version, judge and score |
| Stream | Text/tool/raw callback | Durable event envelope, replay, redaction, lifecycle events |
| Usage | Optional raw token counters | Aggregation, missing-data semantics, prices, currency and budgets |
| Cancellation | Pass signal; operation rejection and cleanup paths | State machine, outer deadline, hard-kill assurance, scheduler propagation |
| Workflow | Warm sandbox/worktree primitives | DAG, fan-out/fan-in, queue, rate/concurrency limits, retry/backoff |

## Integration rules for benchI

1. Pin `@ai-hero/sandcastle` and feature-detect only through public types/results; revisit this boundary on every upgrade because the package is pre-1.0.
2. Allocate a unique named branch and benchI run/case/attempt ID for every concurrent unit. Never concurrently fork on `head` or `merge-to-head`: session fork does not isolate branches or sandboxes ([ADR 0018](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0018-fork-is-session-only.md#L1-L15)).
3. Prefer one-shot `run()`; use `createSandbox()` only when warm state is part of the case. Always dispose handles.
4. Pass file-mode logging with a stream callback, attach benchI IDs, and persist lifecycle events around the call. Do not use Sandcastle logs as benchI's database.
5. Store raw optional usage and compute cost externally. Missing means unknown.
6. Pass an `AbortSignal`, stop downstream scheduling immediately, and treat hard termination as unproven until upstream's provider contract supports it.
7. Add new runtime/agent support through Sandcastle's provider seams. Do not duplicate its worktree, sandbox, session-transfer, stream-parser, or agent-command code in benchI.
8. Keep scoring, orchestration DAGs, retries, budgets, and records above Sandcastle. Its own README states prompts impose no workflow/task/context-source opinions ([primary documentation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L563)).
