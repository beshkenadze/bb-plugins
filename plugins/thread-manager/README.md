# Thread Manager

A dedicated **Threads** page in BB to search, filter, and organize threads across
projects, with a **Restart** button inside each thread. Requires BB 0.45+ with
Plugin SDK 0.6.15+.

## Restart inside a thread

Click **↻ Restart** in the thread header (icon-only on phones). It interrupts
current work and releases the loaded agent runtime. Your next message starts
the runtime again, resuming the same provider conversation and history. The
unsent draft stays in the composer. It does not resend a previous request,
clear model context, or reload the BB app.

The button checks the current thread and verifies its stopped status before
showing success. An unavailable machine or unconfirmed stop produces an error.

## Use

Open **Threads** from BB's sidebar, or `/plugins/thread-manager/threads`.

- Switch between Active, Archived, and All threads.
- Search titles and ids, project/provider/section names, machines, environment
  names and paths, and branches. Multiple words must all match.
- Filter by project, provider, machine, section, execution status, unread, or
  pinned. Root-only and hidden-thread filters are optional.
- Sort by recent updates, creation date, or title.
- Open a thread or split, rename it, pin/unpin, mark read/unread, copy its link,
  move it into a section, archive, restore, or request deletion.
- Select up to 50 rows on the current page to pin/unpin, mark read/unread, or
  move them together. Filter, sort, and page changes clear the selection.

Archiving and deletion use BB's native confirmation flows, including handling
child threads. There is no bulk archive or delete. Failed bulk operations leave
only failed threads selected so you can retry them.

Active threads update through BB's realtime cache. Archived threads load in
pages; choose **Load more archived threads** to expand search coverage. Search,
counts, and filtering describe loaded threads, not archives that have not been
loaded yet. Hidden helper threads are excluded by default.

Thread Manager adds a navigation page and thread-header action, leaving your selected sidebar provider
in place. It uses BB's own thread data and APIs. It does not add a separate thread
database, background jobs, an agent tool, or a CLI command.

## Install from source

```sh
cd plugins/thread-manager
npm install --include=dev
bb plugin build
bb plugin install path:$PWD
```

Once this change is published to the repository:

```sh
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin thread-manager
```

## Develop and verify

```sh
npm test
npm run typecheck
bb plugin types --check
bb plugin build
bb plugin dev
```

Focused SDK-harness tests cover filtering, selection scope, pagination, bulk
failure recovery, rename/move/restore contracts, host confirmation actions,
and restart scope, stop verification, duplicate-click protection, and drafts.
The public-SDK scanner checks that the package has no private BB imports.

## License

Original plugin code is MIT licensed. Vendored BB controls retain their
upstream license and notice; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
