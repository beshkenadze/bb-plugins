See and run your project's Kaban board inside BB, and let agents keep it
current while they work.

## What you get

- A **Kaban** page in the sidebar with the board of any BB project: columns,
  WIP limits, cards with assignees and labels. Drag cards between columns, add,
  edit, complete, or delete tasks.
- **Start thread on this task**: one click spawns a BB agent thread that works
  on the task, links the thread to the card, and moves the task to In Progress.
- A **Kaban board** tab in every thread's side panel, showing the board the
  thread works against, with link/unlink actions for that thread.
- Linked threads appear on their cards with a live status dot; click to open.
- A `bb kaban` command and a bundled skill, so agents find the next task,
  link themselves, and move tasks to Review or Done when they finish.
- Live updates: changes from the Kaban TUI, the CLI, or agents show up on open
  boards automatically.

## How it works

The board stays where Kaban keeps it — `.kaban/board.db` in the project
checkout. The plugin runs your installed `kaban` CLI on the machine that holds
that checkout, so it works with remote machines too and never forks the data.
Threads in worktrees use the project checkout's board on their machine. Only
thread links are stored by BB.

## Requirements

The Kaban CLI on each machine with a project checkout:
`npm i -g @kaban-board/cli` or `brew install beshkenadze/tap/kaban`. Set
**Kaban command** in the plugin settings to use something else, such as
`bunx @kaban-board/cli`.
