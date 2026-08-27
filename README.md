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

## Reference project

The previous standalone implementation is available locally at `.eval-new/`. It is intentionally excluded from this repository and should be treated as read-only reference material.
