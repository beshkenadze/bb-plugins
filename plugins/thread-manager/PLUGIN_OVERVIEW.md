## Restart inside the thread

Click **↻ Restart** in the thread header to release its agent runtime. Current
work stops; the next message restarts the runtime with the same conversation
history. Your unsent draft stays intact. The button becomes a compact icon on
phones, and reports errors when the machine is unavailable or the stop is not
confirmed.

## Threads across projects

Open **Threads** in the sidebar to find and organize BB work. Search titles,
projects, branches, machines, sections, and providers. Switch between active and
archived threads and narrow the list by status, project, unread, or pinned.

## Organize individual threads or a page

Open a thread in a split, rename it, pin it, mark it read, or move it into an
existing section. Select rows on the current page to pin, mark read, or move
several threads together. Changing filters, sort order, or page clears the
selection. Failed updates remain selected for retry.

## Archives and confirmation

Archive and delete actions use BB's own confirmation flows. Restore brings an
archived thread back through BB's unarchive API. There is no bulk archive or
delete. Archives load in pages; load more to expand search coverage. Counts
always describe loaded threads.

## Requirements and data

Requires BB 0.45+ and Plugin SDK 0.6.15+. The page works with BB's live thread
cache and public SDK. It owns no thread database, background worker, or agent
session, and it keeps your existing sidebar list provider.
