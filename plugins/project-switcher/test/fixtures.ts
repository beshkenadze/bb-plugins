import type { PluginSidebarProject, PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export function project(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false, href: `/projects/${id}`, settingsHref: `/projects/${id}/settings` };
}

export function thread(id: string, overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id, projectId: "alpha", title: id, titleFallback: null, displayTitle: id,
    parentThreadId: null, lifecycleOwnerThreadId: null, sourceThreadId: null,
    sectionId: null, originKind: null, originPluginId: null, providerId: "codex",
    status: "idle", runtimeStatus: "idle", queuedWork: "none", hasPendingInteraction: false,
    activity: { backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0, workflows: 0 },
    indicator: "none", indicatorLabel: null, isUnread: false, isPinned: false,
    pinnedAt: null, pinSortKey: null, isArchived: false, archivedAt: null,
    href: `/projects/alpha/threads/${id}`, isHidden: false, environment: null,
    host: null, createdAt: 1_000, updatedAt: 1_000, lastReadAt: null, latestAttentionAt: 1_000,
    ...overrides,
  };
}
