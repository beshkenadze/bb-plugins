import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export const projects: PluginSidebarProject[] = [
  { id: "project-a", name: "Alpha", isPersonal: false, href: "/projects/project-a", settingsHref: "/projects/project-a/settings" },
  { id: "project-b", name: "Beta", isPersonal: false, href: "/projects/project-b", settingsHref: "/projects/project-b/settings" },
];
export const sections = [{ id: "later", name: "Later", createdAt: 1, updatedAt: 1 }];
export function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId: "project-a", title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "codex",
    status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false,
    activity: { backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0, workflows: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/projects/project-a/threads/${id}`, isHidden: false, environment: null,
    host: { id: "mac", name: "Mac mini" }, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000,
    lastReadAt: null, latestAttentionAt: 1_790_000_000_000, ...overrides,
  };
}
