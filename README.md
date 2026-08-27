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

Recovery and release behavior lives in `@benchi/operations`. Authenticated Backup Sets restore with both Admission gates closed, replay every Recovery Safety Record, and require read and scheduling Admission to be opened independently. Upgrades verify signed release metadata, run schema preflight, preserve a rollback boundary until explicit finalization, and leave scheduling closed after finalization. Support bundles redact credential-bearing fields recursively.

## Reference project

The previous standalone implementation is available locally at `.eval-new/`. It is intentionally excluded from this repository and should be treated as read-only reference material.
