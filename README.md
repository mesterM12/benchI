# benchI

Monorepo for an agent evaluation and benchmarking platform.

## Development

Install the pinned toolchain and workspace dependencies:

```sh
mise install
pnpm install
```

Run tasks across the workspace with `pnpm build`, `pnpm test`, `pnpm lint`, or `pnpm check`.

Applications belong in `apps/`; shared packages belong in `packages/`.

## Local web

Set `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`, then initialize PostgreSQL and bootstrap the first Admin:

```sh
pnpm --filter @benchi/web migrate
pnpm --filter @benchi/web bootstrap-admin admin@example.test 'replace-this-password'
pnpm --filter @benchi/web dev
```

Public signup is disabled. Admins create Member accounts through Better Auth's Admin API. Connected CLI commands use `BENCHI_SERVER` and an authenticated `BENCHI_SESSION` cookie.

## Compose Installation

Copy `.env.example` to `.env`, replace every placeholder, then start the supported installation:

```sh
docker compose up --build -d
```

The one-shot `bootstrap` service migrates PostgreSQL and creates the first Admin before `web` starts. PostgreSQL and object storage use named volumes; web, orchestrator, and worker containers are read-only and disposable.

### Execution tracer

`docker compose up --wait` does not report ready until PostgreSQL, object storage, orchestrator, and worker are ready. With an authenticated Admin session in `BENCHI_SESSION` and a Git-backed `made-up-opencode.yaml` Eval Suite, this unattended command creates, freezes, starts, waits for, and verifies a passing Eval Run:

```sh
docker compose up --build --wait
export BENCHI_SERVER=http://localhost:3000
export BENCHI_SESSION='better-auth.session_token=replace-with-authenticated-admin-session'
pnpm --filter @benchi/cli exec benchi suite create made-up-opencode.yaml --idempotency-key tracer-suite-create
RUN_ID="$(pnpm --filter @benchi/cli exec benchi run freeze made-up-opencode --revision 1 --idempotency-key tracer-freeze | node -e 'let text=""; process.stdin.on("data", (chunk) => text += chunk); process.stdin.on("end", () => console.log(JSON.parse(text).id))')"
pnpm --filter @benchi/cli exec benchi run start "$RUN_ID" --idempotency-key tracer-start
pnpm --filter @benchi/cli exec benchi run follow "$RUN_ID"
pnpm --filter @benchi/cli exec benchi run inspect "$RUN_ID" | node -e 'let text=""; process.stdin.on("data", (chunk) => text += chunk); process.stdin.on("end", () => { const run = JSON.parse(text); if (!run.trialAttempts?.every((attempt) => attempt.result?.outcome === "passed" && attempt.result.execution?.acceptance?.exitCode === 0)) process.exit(1); })'
```

The suite's Git source must be reachable from worker. `run inspect` retains evidence including `sandcastle-result.json`, `sandcastle.log`, and `mutated-repository.tar` for each passing Eval Trial.

Recovery and release behavior lives in `@benchi/operations`. Authenticated Backup Sets restore with both Admission gates closed, replay every Recovery Safety Record, and require read and scheduling Admission to be opened independently. Upgrades verify signed release metadata, run schema preflight, preserve a rollback boundary until explicit finalization, and leave scheduling closed after finalization. Support bundles redact credential-bearing fields recursively.

### Release acceptance

Release acceptance uses PostgreSQL and S3-compatible object storage from the supported Compose Installation. It runs cancellation/commit races, worker-death lease recovery, bounded infrastructure retries, retained-artifact loss, secret-grant and Secret Version revocation, Backup Set restore, interrupted upgrades, retained-content provider conformance, worker lifecycle conformance, and real OpenCode characterization. Deterministic adapters cover repeatable release behavior; OpenCode remains a separate real-provider characterization.

Set an authenticated OpenCode model supported by the installed OpenCode provider, then run this uncached command. It fails when any scenario fails; it does not skip the real OpenCode characterization.

```sh
OPENCODE_CHARACTERIZATION_MODEL='provider/model' docker compose --profile acceptance build --no-cache release-acceptance
OPENCODE_CHARACTERIZATION_MODEL='provider/model' docker compose --profile acceptance run --rm -v "$HOME/.local/share/opencode/auth.json:/tmp/.local/share/opencode/auth.json:ro" release-acceptance
```

Verified claims: retained Git inputs, attempt evidence, PostgreSQL-backed leases, S3-compatible retained content, recovery safety gates, and signed upgrade rollback boundaries. benchI does not claim host isolation beyond configured Sandcastle behavior, identical outcome reproduction for nondeterministic providers, or reconstruction after deleted/tombstoned required artifacts.

## Reference project

The previous standalone implementation is available locally at `.eval-new/`. It is intentionally excluded from this repository and should be treated as read-only reference material.
