---
name: thread-manager
description: Use Thread Manager to restart an agent from its thread header, or find and organize BB threads across projects.
---

# Thread Manager

The **↻ Restart** button in each thread header releases that thread's agent
runtime, interrupting current work. The next user message resumes the existing
provider conversation. It preserves thread history and the unsent draft; it
does not clear context or resend the last prompt. The button checks the current
thread and confirms that stopping settled before reporting success.

Open the **Threads** sidebar page, at `/plugins/thread-manager/threads`.

Search matches loaded thread titles and ids, project/provider/section names,
machines, environment names, paths, and branches. Active threads update from
BB's realtime cache. Archived threads load in pages; **Load more archived
threads** expands search coverage. Counts always describe loaded threads.

Filter by lifecycle, project, provider, machine, section, status, unread, or
pinned. Hidden threads are opt-in. The table shows 50 matches per page.

Individual actions open/split, rename, pin/unpin, mark read/unread, move to a
section, archive, restore, or request deletion. Archiving and deletion use
BB's native confirmation flows. Restoration follows BB's unarchive behavior.

Bulk pin/unpin, read/unread, and move affect only selected rows on the current
page. Filter, sort, and page changes clear selection. Failed bulk writes remain
selected and display an error. There is no bulk archive or delete.

The plugin does not add agent tools, a CLI command, background services, or
its own thread database. Use core `bb thread` commands for terminal operations.
