# Project Switcher

A project dropdown at the top of BB's sidebar. It lists every project
alphabetically; type to filter, pick one, and BB opens that project's first
thread. Requires BB 0.46+ with Plugin SDK 0.6.49+.

## Use

The dropdown sits under **New thread**, above the thread list, and shows the
project you are in. Click it (or tab to it and press Enter), type part of a
name, and choose a project with the mouse or the arrow keys and Enter.

- **First thread** means the top row of the project's group under BB's default
  sidebar sort (**Updated**): running threads first (newest first), then the
  thread with the latest activity. Archived, hidden, and nested threads are
  skipped. BB lists pinned threads under **Pinned**, so a pinned thread opens
  only when the project has no other threads. With another sidebar sort, the
  switcher still opens the most recently active thread.
- When the sidebar is organized **By project**, it scrolls so the project's
  group sits at the top of the thread list (or as high as the end of the list
  allows). The personal project scrolls to BB's **Threads** section.
- A project with no threads opens **New thread** with that project selected.
- On a phone the list opens as a bottom sheet, and the sidebar drawer closes
  after you pick a project.

## How it works

The plugin is frontend-only. It reads projects and threads from BB's live
sidebar cache (`experimental_useSidebarThreads`) and navigates with
`useBbNavigate`. It owns no storage, settings, background work, CLI command, or
agent tool, and it keeps whichever sidebar thread list you use.

BB has no plugin slot above the sidebar thread list, so an app-wide overlay
(`experimental_appOverlay`) portals the dropdown into a row placed right before
`[data-testid="app-sidebar-body"] > [data-sidebar="content"]`, and follows the
sidebar when BB re-renders it. This depends on BB's sidebar markup: if a BB
update changes it, the dropdown disappears rather than breaking the sidebar.

## Install from source

```sh
cd plugins/project-switcher
npm install --include=dev
bb plugin build
bb plugin install path:$PWD
```

From the repository:

```sh
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin project-switcher
```

## Develop

```sh
npm test            # vitest + jsdom
npm run typecheck
bb plugin dev       # rebuild and reload on save (after installing the path)
```
