# Developing agent-kanban

[English](Develop.md) · [中文](Develop_zh.md) · [User guide](README.md) · [用户指南](README_zh.md)

Architecture, build, release, and the verification harness.

---

## Stack

| Piece | Choice | Why |
|---|---|---|
| Runtime | Bun ≥ 1.4.2 | Compiles TypeScript directly; `bun build --compile` produces a standalone binary |
| Language | TypeScript (strict) | — |
| Storage | SQLite in WAL mode | Single file, no daemon, survives `docker stop` |
| HTTP | Bun.serve | No framework; the surface is small enough to read in one sitting |
| Frontend | React 19 + Vite + Tailwind v4 + shadcn/ui | — |
| Tests | `bun test` | — |

## Layout

```
src/
  cli.ts              command routing, global flag extraction, exit-code mapping
  commands/           argument parsing → build an Op → call Backend → format
    context.ts        openCtx / closeCtx / resolveSessionId  (NOT the recovery command)
    recovery.ts       `context` / `resume` / `doctor` commands
  core/               all business logic — shared by local and remote backends
    schema.sql        the whole database definition
    db.ts             connection, migrations, BEGIN IMMEDIATE helpers
    tasks.ts          state machine, leases, dependency readiness
    handoff.ts        handoff creation and consumption
    plans.ts          versioned plans
    rebuild.ts        event replay and drift detection
    ops.ts            the Op protocol (the single write surface)
    backend.ts        local Backend
    backend-remote.ts HTTP Backend
  server/
    http.ts           routes, auth, SSE, static assets
    admin-page.ts     self-contained /admin HTML
    assets.generated.ts   embedded frontend manifest (COMMITTED — see below)
  types/assets.d.ts  module declarations for embedded files
web/                  separate Vite app; `bun --cwd web`
scripts/              verification and build helpers
test/                 bun test suites
docs/plan/            design docs
docs/note/            implementation notes and post-mortems
```

### The layering rule

`cli.ts` routes. `commands/` parse and format. `core/` does the work. Nothing below `core/` knows whether it is talking to a local file or an HTTP server.

That is what makes local and remote mode behaviourally identical. It is a structural guarantee, not a convention anyone has to remember.

**Watch out:** `src/commands/context.ts` is the connection/session context helper. `src/commands/recovery.ts` is the command that implements `kanban context`. They are unrelated and the names are misleading.

## Data model

Five ideas worth knowing before you touch anything:

**Events are the source of truth.** Every mutation appends to `events`; `tasks`, `plans`, `handoffs`, and `task_deps` are projections. If you add a field to a projection, you must also emit enough payload on the corresponding event or `rebuild` will report drift.

**Project key is in every business table.** Project isolation is enforced in the schema, not in application code. Task IDs are unique per project (`T-0001` restarts in each one). Sessions stay global because one agent can work across projects.

**Ownership is a lease.** `tasks.owner_session_id` plus `lease_expires_at`. Reaping an expired lease preserves progress and checklist items — only ownership moves.

**Handoffs come in two kinds.** Voluntary (written by an agent before stopping) and crash-generated. `resume` prefers voluntary; the crash variant is a fallback and always says the previous holder is unreachable. A voluntary handoff also lets another session take over a task whose lease has *not* expired — writing a handoff means yielding. "Yields" covers the handoff being unconsumed *or* already consumed by the session now taking over: otherwise the standard MCP flow (`bootstrap` consumes, then `resume`) would hit a conflict and push the agent toward `--force`.

**`BEGIN IMMEDIATE`, always.** Writers take the write lock up front rather than upgrading mid-transaction, which avoids `SQLITE_BUSY` deadlocks between the lease reaper and normal traffic.

## Setup

```bash
bun install
cd web && bun install && cd ..

bun run verify:all    # all 13 gates in one run, with a summary
bun run web:dev      # Vite on :5173
bun run serve        # backend + built frontend on :7788
```

`serve` needs `web/dist` to exist for the UI; without it you get a placeholder page telling you to build.

## Build

```bash
bun run web:build      # vite build, then gen:assets
bun build --compile src/cli.ts --outfile dist/kanban
```

Or both at once:

```bash
bun run build:binary
```

### Order is not optional

`web:build` must run before `bun build --compile`, and `gen:assets` must run between them:

```
vite build  →  gen:assets  →  bun build --compile
```

`gen:assets` scans `web/dist` and writes `src/server/assets.generated.ts` with one static `import ... with { type: "file" }` per asset. This is required because Bun's embedded-file imports must be literal paths, and Vite's output filenames contain content hashes that are unknowable before the build.

**Skipping `gen:assets` still compiles successfully.** You get a binary with no web UI, and `/` silently serves the placeholder page. `web:build` runs it for you; if you invoke `vite build` directly, run `bun run gen:assets` yourself.

### `src/server/assets.generated.ts` is committed

Yes, a generated file is in git. It is committed as the **empty placeholder**, because `http.ts` imports it statically and a clean checkout (CI, a new machine) has no `web/dist` and runs no generator. Without it, `tsc --noEmit` fails with TS2307 *before* the frontend build even runs.

After `web:build` the file is rewritten to the real manifest and will show as modified. That is expected — do not commit the built version.

The same reasoning applies to `schema.sql` and `package.json`, which are embedded for a different reason: the compiled binary must work with no source tree beside it.

## Testing

```bash
bun test                    # 97 tests
bunx tsc --noEmit           # backend
cd web && bun run typecheck # frontend
```

### The verification scripts

Unit tests cover logic. The scripts below boot real servers, spawn real processes, and assert on real HTTP. They catch the failures that only appear across process and environment boundaries.

| Script | What it proves |
|---|---|
| `verify-web.ts` | Static assets, SPA fallback, path traversal, API, auth, SSE, cache headers, **task-detail Op contract** |
| `verify-web-ui.ts` | Headless Chrome **really clicks a card**: detail sheet opens, all three tabs have data, no runtime exceptions |
| `verify-binary.ts` | The compiled binary is genuinely self-contained |
| `verify-deploy.ts` | Dockerfile, compose, and `.env` structure |
| `verify-deps.ts` | No undeclared ("phantom") dependencies |
| `verify-workflows.ts` | Workflow files parse and keep their required structure |
| `verify-docs.ts` | Docs still match the code: exit codes, env vars, flags, command and script names |
| `verify-mcp.ts` | The MCP server works over real stdio JSON-RPC, contract §3.4 recovery flow |
| `verify-backup.ts` | export → import on a second machine restores the board losslessly |
| `verify-all.ts` | Runs every gate above in one go; the summary answers "what is still red" |
| `verify-auth.ts` | Token scoping and project isolation |
| `verify-remote.ts` | Local and remote backends behave identically |
| `verify-recovery.ts` | Lease expiry, handoff, `context`, `resume`, `doctor` |
| `verify-rebuild.ts` | Deliberately corrupts the projection, then repairs it atomically |

```bash
bun run verify:web
bun run verify:web:ui   # needs Chrome/Edge locally; skips when absent
bun run verify:deps
bun run verify:workflows
bun run verify:docs
bun run verify:deploy
bun run verify:mcp
bun run verify:backup
bun run verify:all    # the lot, with a summary
```

Documentation rot is silent. Renaming a command or reassigning an exit code breaks nothing at runtime, it just quietly makes the docs wrong, and nobody reads them twice. `verify-docs.ts` diffs the claims in the four documents against the actual source: every exit code, environment variable, global flag, top-level command, npm script, and referenced file path.

## Documentation layout

- `README.md` / `README_zh.md` for **users**: features, the problem it solves, how to deploy and configure. English is the default (`README.md`); the Chinese version lives in `README_zh.md`.
- `Develop.md` / `Develop_zh.md` for **developers**: architecture, build, release, verification.
- All four cross-link at the top, so readers can switch languages at any point.

## Tests and SQLite

Tests that exercise lease expiry depend on real time, so they run serially (`bunfig.toml` sets `coverage = false` and the suites are written to avoid wall-clock races). Do not "fix" a slow test by parallelising it.

## Release

Tag-driven. Push `vX.Y.Z` and the workflow:

1. Asserts the tag equals `package.json.version`, so the version has exactly one source
2. Runs typecheck, tests, and the end-to-end scripts
3. Compiles self-contained binaries for 5 platforms and smoke-tests each one **on the target platform** (arm64 goes through QEMU, because an arm64 binary cannot run on an x64 runner)
4. Builds and pushes `linux/amd64` + `linux/arm64` images to GHCR and Docker Hub
5. Creates the GitHub Release with binaries and SHA-256 checksums

**Before your first tag:** confirm `package.json.version`, run the full verification list, and make sure `web/dist` builds. The version check is a hard gate — a mismatched tag fails the whole run.

## Deployment shape

One `kanban serve` process per deployment, many projects inside it, each isolated by project key and scoped tokens.

```bash
cp .env.example .env      # set KANBAN_ADMIN_TOKEN (openssl rand -hex 16)
docker compose up -d
docker compose exec kanban kanban admin project add my-app
```

- **No reverse proxy or TLS in the compose file.** Most deployments already sit behind HTTPS. Shipping a certificate-renewing container adds a failure mode (expired cert means total outage) that most users do not need. `KANBAN_BIND` defaults to `127.0.0.1`; expose deliberately.
- **Tokens travel in plaintext without TLS.** This is the one real risk in the design, so it is stated in the README, in `.env.example`, and in the compose comments. Do not skip the TLS terminator when exposing the server beyond localhost.
- **No bootstrap service.** Creating a project and issuing a token are two commands, not a container with its own state, health checks, and idempotency rules.
- **The Docker image does not compile a binary.** `bun build --compile` links a copy of the Bun runtime into the artifact, and an image based on `oven/bun` already has one. Running the sources directly means one runtime, a smaller image, and no build step that can silently go stale.

## Design docs

- `docs/plan/001-总体设计.md` — architecture, data model, ADRs
- `docs/plan/002-接口契约.md` — HTTP API, Op protocol, exit codes, web theme tokens
- `docs/plan/003-实施计划.md` — milestones and status
- `docs/note/` — per-feature implementation notes, including the post-mortems worth reading before touching the same area
