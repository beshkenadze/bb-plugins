---
name: kaban
description: "Track work on the project's Kaban board (.kaban/board.db) from a BB thread: find the next task, link this thread to it, and keep its column current with `bb kaban`."
---

# Kaban board

Kaban is a kanban board stored in the project checkout (`.kaban/board.db`).
In BB, use `bb kaban` instead of the plain `kaban` CLI: it always targets the
project's real board on the right machine, even when this thread runs in a
worktree that has no (or a stale) `.kaban/` copy, and it records which agent
acted.

## Work a task

1. If this thread was started from a task, its task is already linked and
   named in your instructions. Otherwise check:

   ```sh
   bb kaban current            # task linked to this thread, if any
   bb kaban list               # whole board, grouped by column
   bb kaban next               # next actionable task in todo
   ```

2. Before starting work, link the thread and mark the task started — this
   moves it to the start column (default `in_progress`) and assigns it:

   ```sh
   bb kaban link 12 --start    # or: bb kaban next --start
   ```

   A thread can only link tasks on its own board (the one `bb kaban status`
   shows). For a task on another project's board, use `bb kaban start`.

3. Read the task with `bb kaban show 12` (description, labels, linked
   threads). Ask the user when acceptance criteria are unclear.

4. When finished, update the column — never leave a finished task in
   `in_progress`:

   ```sh
   bb kaban move 12 review     # ready for review
   bb kaban done 12            # fully complete
   ```

   If you are blocked, say so to the user and leave the task where it is.

## Capture new work

Add follow-ups instead of silently expanding scope:

```sh
bb kaban add "Handle expired tokens" --description "Found while fixing #12" --column backlog
```

Kaban refuses near-duplicate titles; check `bb kaban list` first, and pass
`--force` only when it really is a different task. `--link` links this thread
to the new task.

## Delegate

`bb kaban start 12` spawns a new BB thread that works on task 12 on the
board's machine, links it, and moves the task to the start column. Use it only
when the user asks for parallel work.

## Conventions

- Task refs: `12`, `#12`, or a task id (`01J…`) all work.
- Column ids are lowercase with underscores: `backlog`, `todo`,
  `in_progress`, `review`, `done` (boards can customize them; `bb kaban status`
  lists them).
- Outside a BB thread, pass `--project <projectId>`; the command never guesses
  a board from the current directory.
- Add `--json` when the output drives further commands; failures then print
  `{"ok":false,"error":{"code","message","hint"}}`.
- `bb kaban --help` and `bb kaban <command> --help` list every option.
- No board yet? `bb kaban init` creates one in the project checkout (ask the
  user first).
