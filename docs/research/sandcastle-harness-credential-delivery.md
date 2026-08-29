# Sandcastle harness credential delivery

Research question: [benchI issue #54](https://github.com/mesterM12/benchI/issues/54)

## Decision

For unattended benchmark runs, benchI should deliver only a per-run, opaque API credential as an environment variable through the relevant public Sandcastle agent factory's `env` option. Do not copy, mount, create, retain, or expose harness credential stores. Do not use OAuth/subscription login as the default automation path. This is research only; it does not implement that policy.

The integration boundary remains public TypeScript API only:

```ts
opencode(model, { env: { OPENCODE_API_KEY: secret } });
codex(model, { env: { OPENAI_API_KEY: secret } });
claudeCode(model, { env: { ANTHROPIC_API_KEY: secret } });
pi(model, { env: { ANTHROPIC_API_KEY: secret } });
```

`env` is a documented public option on all four factories; Sandcastle merges agent, sandbox, and `.sandcastle/.env` values at launch. Its generated `.env.example` contains `ANTHROPIC_API_KEY` and `GH_TOKEN`; it is not a suitable benchmark secret store. [Sandcastle types](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L613-L998), [merge implementation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L618-L626), and [example](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.sandcastle/.env.example) are pinned to the project dependency version, `@ai-hero/sandcastle` 0.12.0.

## Harness findings

| Harness | Credential stores and format | Non-interactive delivery | OAuth/subscription conclusion |
| --- | --- | --- | --- |
| OpenCode | OpenCode's authenticated-provider configuration is local state; its official setup directs a user to `/connect` and an API-key paste. API keys are the documented prerequisite. | Deliver the selected provider's documented API-key environment variable, e.g. `OPENCODE_API_KEY` for OpenCode Zen, or the native provider variable such as `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. | Do not automate `/connect` or copy its resulting local state. It is interactive and provider-specific. |
| Codex | Default file store is `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), plaintext and token-bearing; `cli_auth_credentials_store` may instead select OS keyring or `auto`. Session transcripts are JSONL under `~/.codex/sessions`. | `OPENAI_API_KEY` may be piped to `codex login --with-api-key`; for Sandcastle, inject `OPENAI_API_KEY` directly. Enterprise access tokens can also be piped to `codex login --with-access-token`; workload identity is preferred when available. | Browser OAuth is interactive; device-code still requires a human. A copied `auth.json` is supported only for trusted private automation, requires persistence/serialization for refresh, and is not the default. |
| Claude Code | macOS uses Keychain; Linux uses mode-0600 `~/.claude/.credentials.json`; Windows uses `%USERPROFILE%\\.claude\\.credentials.json`. `CLAUDE_CONFIG_DIR` relocates the file on Linux/Windows. Sandcastle captures Claude session JSONL separately under `.claude/projects`. | `ANTHROPIC_API_KEY` is always used in `-p` mode. `ANTHROPIC_AUTH_TOKEN` and `apiKeyHelper` are alternatives; the latter supports rotation. `CLAUDE_CODE_OAUTH_TOKEN` is a long-lived token intended for CI/scripts. | `/login` and `claude setup-token` require browser approval. `setup-token` makes later delivery non-interactive, but its token is still an opaque secret, never a benchmark artifact. |
| Pi | `~/.pi/agent/auth.json`, mode 0600, stores API-key entries and OAuth credentials; Pi sessions are JSONL in `~/.pi/agent/sessions`. `PI_CODING_AGENT_DIR` relocates config. | Deliver the selected provider's env key, e.g. `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Sandcastle's Pi adapter invokes `pi -p --mode json` and accepts factory `env`. | `/login` is interactive and writes refreshable OAuth state. Do not provision or transfer that state for benchmark execution. |

OpenCode sources: [intro and `/connect`](https://opencode.ai/docs/), [provider configuration](https://opencode.ai/docs/providers/). Codex sources: [authentication and stores](https://developers.openai.com/codex/auth), [trusted CI `auth.json` pattern](https://developers.openai.com/codex/auth/ci-cd-auth). Claude Code source: [authentication, precedence, stores, and CI token](https://docs.anthropic.com/en/docs/claude-code/authentication). Pi sources: [providers, auth file, keys, and precedence](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [sessions and CLI environment](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).

## Evidence and redaction

1. Treat every credential value, OAuth refresh/access token, bearer token, API key, `auth.json`, `.credentials.json`, keyring export, and dynamic-helper output as secret material. Never commit, attach, display, or log it.
2. Treat the listed credential and session directories as sensitive by default. Claude/Codex/Pi session JSONL can contain prompts, tool inputs/outputs, and provider metadata; Sandcastle's captured Claude/Codex/Pi sessions are not safe benchmark evidence without a reviewed redaction policy.
3. Sandcastle's public stream callback can emit raw provider lines; file logging with `verbose: true` appends every raw line. Disable raw/verbose capture for credentialed runs. Redact structured text, tool arguments, stderr, and log paths before retention because harnesses may echo environment-derived failures or user-supplied secrets.
4. Evidence may retain credential-free metadata only: harness, exact CLI/package version, model identifier, delivery mechanism name (not value), secret reference/version identifier if non-sensitive, start/end/outcome, and a redaction-policy version.

## Consequences

- Initial supported benchI credential contracts should be API-key environment variables, plus Claude's CI OAuth token only when a subscription credential is intentionally selected. Codex access-token/workload-identity support is a separate enterprise contract, not a reason to transport `auth.json`.
- The runner must inject values only into the sandboxed agent process and remove them on teardown. It must not place values in repository files, `copyToWorktree`, prompt arguments, command arguments, branch names, result records, or artifacts.
- Sandcastle's public `env` option is sufficient for this research scope. benchI must not access Sandcastle private services, templates, provider internals, or create custom shell invocation paths to manipulate credential files.

## Limits

This records current vendor and Sandcastle behavior, not a durability guarantee. Revalidate credential-store and OAuth behavior on every Sandcastle or harness upgrade, especially because Sandcastle is pre-1.0.
