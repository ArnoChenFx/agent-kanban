# Developing agent-kanban

[English](Develop.md) · [中文](Develop-zh.md) · [User guide](README.md) · [用户指南](README-zh.md)

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

**Watch out:** `src/commands/context.ts` is the connection/session context helper. `src/commands/recovery.ts` is the command that implements `agent-kanban context`. They are unrelated and the names are misleading.

### Frontend copy (i18n)

Both the board (`web/`) and the admin page (`/admin`) speak Chinese and English, and they **share one convention and one `localStorage` key** (`kanban.locale`) — a single origin should not carry two language states.

`web/src/lib/i18n.tsx` is the board side's **only** entry point for UI copy. Three hard rules:

1. **No Chinese string literals in components.** Get `const { t } = useI18n()` and call `t("board.newTask")`. When a pure function needs copy — `web/src/lib/status.ts` and friends — pass `t` itself down: `canMove(from, to, t)`, `relativeTime(ts, t)`.
2. **`zh` is the single source of keys.** `en` is typed `Record<MessageKey, string>`, so a missing translation is a `tsc` error instead of a raw key surfacing in the English UI. **Do not change it to `satisfies`** — that is not an exhaustiveness check.
3. **Comments in Chinese, copy in the dictionary.** The only Chinese left in `web/src/**/*.tsx` belongs in comments — a new hit from `rg '[\x{4e00}-\x{9fff}]' web/src` is an untranslated string.

`web/src/lib/status.ts` imports no React; it just receives a locale-bound `t`, so it stays testable outside the UI. `web/src/lib/api.ts` is a pure request layer too and translates its own error copy through `tActive()` (a module-level translator exported from `i18n.tsx`).

The admin page (`src/server/admin-page.ts`) is a template string with no type-level exhaustiveness check: static copy is marked with `data-i18n` / `data-i18n-ph` and applied in one pass, dynamic copy goes through an inline `t()`.

Copy that arrives as **user data** from the backend (task titles, handoff bodies) is not translated — that is content, not chrome. Backend-*generated* advice (`next_actions`) used to be the awkward exception: it is a Chinese string written for an agent, yet the sidebar painted it straight onto the board, so the English UI quietly showed Chinese. The fix was not an English gloss per Chinese string (a second source of truth that drifts the moment the backend rewords); the backend now also ships a structured `next_action_items` (`{ code, args }`) and the UI picks its own dictionary entry per `code`. The Chinese string is rendered from those same items, so the two can never disagree. The mapping lives in `web/src/lib/next-actions.ts` (no React, unit-testable).

Session heartbeat was the same problem earlier: `sessionToJson` also ships `last_seen_at` (a ms timestamp), and the UI formats that itself rather than displaying the backend's Chinese `fresh` string.

Adding a language: on the board, extend `LOCALES`, fill in `HTML_LANG` / `LOCALE_NAME`, and write a dictionary with the same keys (the type will tell you which ones you are missing); on the admin page, add one `DICT.<lang>`.

> ⚠ When editing the inline JS inside `src/server/admin-page.ts`, audit backslashes and backticks as if they were escaped one extra time: the template literal consumes a layer first (`\w` → `w` silently breaks a regex; a backtick terminates the template string outright). Interpolation uses `split`/`join` rather than a regex precisely to avoid this.

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
bun build --compile src/cli.ts --outfile dist/agent-kanban
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
| `verify-install.ts` | The install scripts really work: asset names match the release matrix, and each script installs a runnable binary end-to-end |
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
bun run verify:install
bun run verify:docs
bun run verify:deploy
bun run verify:mcp
bun run verify:backup
bun run verify:all    # the lot, with a summary
```

Documentation rot is silent. Renaming a command or reassigning an exit code breaks nothing at runtime, it just quietly makes the docs wrong, and nobody reads them twice. `verify-docs.ts` diffs the claims in the four documents against the actual source: every exit code, environment variable, global flag, top-level command, npm script, and referenced file path.

### Demo board for screenshots

`seed-demo.ts` seeds a **simulated** board — 18 cards, 5 sessions, a dependency graph, handoffs, plan versions, one crashed-and-reclaimed card — into any database you point it at. It exists so the README, the release notes and the project intro can be illustrated with a board that looks like a real one instead of a hand-drawn mock-up.

```bash
bun run seed:demo                     # into .kanban/kanban.db (this repo)
bun run seed:demo --db /tmp/demo.db   # into a throwaway database
bun run seed:demo --reset             # wipe the target database first
```

Three properties make the result usable rather than decorative:

- It writes through the **same core API the CLI uses** (`createTask`, `claimTask`, `transition`, `writeHandoff`, `savePlan`, …), so the event journal, the leases and the projection all agree. `doctor` is clean; `rebuild` replays it.
- Timestamps are injected through the logical clock, so the board is spread over the last two weeks instead of showing eighteen cards created at the same instant.
- It refuses to touch a database that already has tasks unless you pass `--reset`, so it cannot quietly overwrite a real board.

Screenshots need a database that is *the same shape* every time, so two things are deliberately non-default: every session that is still working gets a fresh heartbeat, and one is already finished and one has already crashed — otherwise the next command reaps the stale ones and the board rearranges itself between the screenshot and your eye. Re-run the seed right before shooting; details in `docs/plan/005-演示数据种子脚本.md`.

## Documentation layout

- `README.md` / `README-zh.md` for **users**: features, the problem it solves, how to deploy and configure. English is the default (`README.md`); the Chinese version lives in `README-zh.md`.
- `Develop.md` / `Develop-zh.md` for **developers**: architecture, build, release, verification.
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

One `agent-kanban serve` process per deployment, many projects inside it, each isolated by project key and scoped tokens.

```bash
cp .env.example .env      # set KANBAN_ADMIN_TOKEN (openssl rand -hex 16)
docker compose up -d
docker compose exec kanban agent-kanban admin project add my-app
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
