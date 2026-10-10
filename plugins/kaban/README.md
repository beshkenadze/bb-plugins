# bb-plugin-kaban

Kaban boards inside [BB](https://getbb.app): a board page, thread-linked
tasks, and a `bb kaban` CLI that agents use to keep tasks current.

## Install

Requires BB ≥ 0.45 with Plugin SDK ≥ 0.6.15, and the Kaban CLI on every
machine that holds a project checkout (`npm i -g @kaban-board/cli` or
`brew install beshkenadze/tap/kaban`). The plugin does not install the CLI
or include your `.kaban/` databases, thread links, or local configuration.

```sh
# from a clone of this repository
bb plugin install path:. --plugin kaban

# or straight from GitHub
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin kaban
```

## Use

| Surface | What it does |
|---|---|
| **Kaban** sidebar page | Board of a BB project (`/plugins/kaban/board/<projectId>`). Drag cards between columns; add, edit, complete, delete; **Start thread on this task**. |
| **Kaban board** thread panel tab | The board this thread works against, with **Link to this thread** / **Unlink**. |
| `bb kaban …` | `status`, `list`, `show`, `add`, `move`, `assign`, `done`, `edit`, `next [--start]`, `link [--start]`, `unlink`, `current`, `start`, `init`. `bb kaban --help` for options; `--json` everywhere. |
| Agent instructions | A thread linked to a task is told which task it owns and how to move it to review/done. |
| Skill `kaban` | Tells agents the workflow above. |

Settings (Settings → Plugins → Kaban, or `bb plugin config kaban`):

| Key | Default | Meaning |
|---|---|---|
| `kabanCommand` | `kaban` | How to run the CLI on each machine, e.g. `bunx @kaban-board/cli` (split on spaces, no shell). |
| `startColumn` | `in_progress` | Column a task moves to when a thread starts on it; empty leaves it in place. |
| `linkedThreadInstructions` | `true` | Add the linked task to agent instructions (new sessions). |

## How it works

```
app.tsx ──rpc──▶ server.ts ──host rpc──▶ host.ts (on the checkout's machine)
bb kaban ─cli──▶   │  KabanService            └─ execFile kaban … --json  (cwd = board root)
agents ──instr──▶  │  BoardLocator            └─ watch .kaban/ → boardChanged signal
                   │  LinkStore (plugin SQLite: thread ↔ task)
                   └─ realtime "board-changed" ◀── signals / mutations (coalesced)
```

- **Board location.** A board is `<checkout>/.kaban` on one machine. A thread
  resolves to its project's checkout on the thread's own machine (worktrees
  often lack `.kaban/` or carry a stale copy); only a machine without a
  checkout falls back to the thread's workspace. A bare cwd is never used to
  pick a board, because a plugin CLI call does not identify the invoking
  machine; outside a thread, pass `--project`.
- **Task threads stay on the board's machine.** *Start thread* pins the new
  thread to the board's host (a managed worktree for git checkouts, otherwise
  the board root), so its `bb kaban` reads the same board.
- **Safe argv.** User text is passed after `--` and options as `--name=value`,
  so a title like `--force` can never become a flag. No shell is involved.
- **Live refresh.** The host watches `.kaban/` (ignoring `board.db-shm`, which
  readers touch) and signals only when `board.db`, its WAL, or `config.json`
  change. Notifications are coalesced per project (leading + trailing edge),
  never dropped.
- **Links** live in the plugin's SQLite database; each link/unlink is one
  transaction, so concurrent requests cannot lose rows. A thread links only to
  a task on its own board (the one its plain `bb kaban` resolves to), because
  its instructions use `bb kaban move <n> review` without `--project`.
- **One kaban process per board.** The kaban CLI runs `PRAGMA integrity_check`
  on every open without a busy timeout, so concurrent opens can be misread as
  corruption and trigger its recovery. The plugin serializes all runs per
  board; a CLI request that disconnects while queued never runs.

## Develop

```sh
cd plugins/kaban
npm install
npm test            # vitest: client, locator, links, host entry, server, UI
npm run typecheck
bb plugin install . # once
bb plugin dev       # rebuild + reload on save
bb plugin logs kaban -f
```

This package is self-contained; no parent workspace packages are required.
For development and tests use Node 22.22.2+ (22.x), Node 24.15.0+ (24.x),
or Node 26+. These are the versions supported by the locked test dependencies;
verification used Node 24 LTS. BB builds the plugin with npm and its own toolchain.

## License

Adapted from the Kaban project's BB integration, MIT licensed, Copyright (c)
2026 Kaban Contributors. See [LICENSE](LICENSE). Copied BB UI components retain
their original MIT notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
