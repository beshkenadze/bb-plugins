import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const nameOrder = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function sortProjects(projects: readonly PluginSidebarProject[]): PluginSidebarProject[] {
  return [...projects].sort((a, b) => nameOrder.compare(a.name, b.name) || compareIds(a.id, b.id));
}

/**
 * The thread at the top of the project's group in bb's sidebar under its
 * default sort: a visible top-level thread in bb's own order. bb lists pinned
 * threads under Pinned instead, so they count only when the project has nothing else.
 */
export function firstThreadId(threads: readonly PluginSidebarThread[], projectId: string): string | null {
  // As in bb's list, a child of a thread that is not shown is a top-level row.
  const shown = new Set(threads.filter((thread) => !thread.isHidden).map((thread) => thread.id));
  let first: PluginSidebarThread | null = null;
  for (const thread of threads) {
    if (thread.projectId !== projectId || thread.isArchived || !shown.has(thread.id)) continue;
    if (thread.parentThreadId !== null && shown.has(thread.parentThreadId)) continue;
    if (first === null || ranksBefore(thread, first)) first = thread;
  }
  return first?.id ?? null;
}

/** bb's sidebar order: active threads first, newest created first; then latest attention. */
function ranksBefore(a: PluginSidebarThread, b: PluginSidebarThread): boolean {
  if (a.isPinned !== b.isPinned) return b.isPinned;
  const activeA = a.status === "active";
  const activeB = b.status === "active";
  if (activeA !== activeB) return activeA;
  if (!activeA && a.latestAttentionAt !== b.latestAttentionAt) return a.latestAttentionAt > b.latestAttentionAt;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return compareIds(a.id, b.id) < 0;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function matchesSearch(name: string, search: string): boolean {
  return name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
}
