#!/bin/sh
set -eu

: "${OPENCODE_CHARACTERIZATION_MODEL:?set OPENCODE_CHARACTERIZATION_MODEL}"

export DATABASE_URL="${DATABASE_URL:-postgres://benchi:${POSTGRES_PASSWORD:-benchi-local}@postgres:5432/benchi}"
export TEST_DATABASE_URL="$DATABASE_URL"
export TEST_OBJECT_STORAGE_ENDPOINT="${OBJECT_STORAGE_ENDPOINT:-http://object-storage:9000}"
export TEST_OBJECT_STORAGE_ACCESS_KEY="${OBJECT_STORAGE_ACCESS_KEY:-${MINIO_ROOT_USER:-benchi}}"
export TEST_OBJECT_STORAGE_SECRET_KEY="${OBJECT_STORAGE_SECRET_KEY:-${MINIO_ROOT_PASSWORD:-benchi-local}}"
export RUN_OPENCODE_CHARACTERIZATION=1

pnpm --filter @benchi/artifact-repository test
pnpm --filter @benchi/secret-custody test
pnpm --filter @benchi/run-orchestration test
pnpm --filter @benchi/operations exec vitest run src/index.test.ts
pnpm --filter @benchi/worker-runtime test
pnpm --filter @benchi/web exec vitest run system/eval-runs.system.test.ts
