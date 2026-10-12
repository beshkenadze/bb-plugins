import type { PluginSidebarProject, PluginSidebarSection, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type Lifecycle = "active" | "archived" | "all";
export type Preset = "all" | "running" | "attention" | "unread" | "pinned" | "failed" | "idle";
export type Sort = "updated" | "created" | "title";
export interface Filters {
  lifecycle: Lifecycle;
  query: string;
  projectId: string;
  sectionId: string;
  providerId: string;
  hostId: string;
  preset: Preset;
  sort: Sort;
  showHidden: boolean;
  rootsOnly: boolean;
}
export const DEFAULT_FILTERS: Filters = {
  lifecycle: "active", query: "", projectId: "", sectionId: "", providerId: "",
  hostId: "", preset: "all", sort: "updated", showHidden: false, rootsOnly: false,
};
export const PAGE_SIZE = 50;
export const UNSECTIONED = "__unsectioned__";

export function isRunning(thread: PluginSidebarThread): boolean {
  return ["starting", "active", "stopping"].includes(thread.status);
}
export function needsAttention(thread: PluginSidebarThread): boolean {
  return thread.hasPendingInteraction || thread.status === "error" || thread.queuedWork === "failed";
}
export function matchesPreset(thread: PluginSidebarThread, preset: Preset): boolean {
  switch (preset) {
    case "running": return isRunning(thread);
    case "attention": return needsAttention(thread);
    case "unread": return thread.isUnread;
    case "pinned": return thread.isPinned;
    case "failed": return thread.status === "error" || thread.queuedWork === "failed";
    case "idle": return thread.runtimeStatus === "idle" && thread.queuedWork === "none" && !needsAttention(thread);
    default: return true;
  }
}
export function statusLabel(thread: PluginSidebarThread): string {
  if (thread.isArchived) return "Archived";
  if (thread.hasPendingInteraction) return "Needs input";
  if (thread.queuedWork === "failed") return "Queue failed";
  switch (thread.runtimeStatus) {
    case "active": return "Running";
    case "starting": return "Starting";
    case "stopping": return "Stopping";
    case "error": return "Failed";
    case "pending": return "Pending";
    case "provisioning": return "Provisioning";
    case "waiting-for-host": return "Waiting for host";
    default:
      switch (thread.status) {
        case "active": return "Running";
        case "starting": return "Starting";
        case "stopping": return "Stopping";
        case "error": return "Failed";
        case "pending": return "Pending";
        default: return thread.queuedWork === "waiting" ? "Queued" : "Idle";
      }
  }
}

export function filterThreads(
  threads: readonly PluginSidebarThread[],
  filters: Filters,
  projects: readonly PluginSidebarProject[],
  sections: readonly PluginSidebarSection[],
  providerNames: ReadonlyMap<string, string>,
): PluginSidebarThread[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const sectionNames = new Map(sections.map((section) => [section.id, section.name]));
  const words = filters.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = threads.filter((thread) => {
    if (!filters.showHidden && thread.isHidden) return false;
    if (filters.lifecycle !== "all" && thread.isArchived !== (filters.lifecycle === "archived")) return false;
    if (filters.rootsOnly && thread.parentThreadId !== null) return false;
    if (filters.projectId && thread.projectId !== filters.projectId) return false;
    if (filters.providerId && thread.providerId !== filters.providerId) return false;
    if (filters.hostId && thread.host?.id !== filters.hostId) return false;
    if (filters.sectionId === UNSECTIONED && thread.sectionId !== null) return false;
    if (filters.sectionId && filters.sectionId !== UNSECTIONED && thread.sectionId !== filters.sectionId) return false;
    if (!matchesPreset(thread, filters.preset)) return false;
    if (words.length === 0) return true;
    const haystack = [thread.id, thread.displayTitle, projectNames.get(thread.projectId),
      thread.providerId, providerNames.get(thread.providerId), thread.host?.name,
      thread.environment?.name, thread.environment?.branchName, thread.environment?.path,
      thread.sectionId ? sectionNames.get(thread.sectionId) : "", statusLabel(thread)]
      .join(" ").toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return matches.sort((a, b) => {
    const difference = filters.sort === "title" ? a.displayTitle.localeCompare(b.displayTitle)
      : filters.sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt;
    return difference || a.id.localeCompare(b.id);
  });
}

// Always re-resolve selection against the current visible page before a write.
// Filter changes and realtime removals can never expand the mutation's scope.
export function selectedOnPage(page: readonly PluginSidebarThread[], ids: ReadonlySet<string>) {
  return page.filter((thread) => ids.has(thread.id));
}

export async function updateMany(
  threads: readonly PluginSidebarThread[],
  update: (thread: PluginSidebarThread) => Promise<unknown>,
): Promise<{ succeeded: number; failedIds: string[]; firstError: string | null }> {
  const results = await Promise.allSettled(threads.map(async (thread) => update(thread)));
  const failedIds: string[] = [];
  let firstError: string | null = null;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    const thread = threads[index];
    if (thread) failedIds.push(thread.id);
    firstError ??= result.reason instanceof Error ? result.reason.message : String(result.reason);
  });
  return { succeeded: threads.length - failedIds.length, failedIds, firstError };
}
