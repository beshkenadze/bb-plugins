import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp, experimental_usePluginId, experimental_useSidebarThreads, useBbContext, useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { firstThreadId, sortProjects } from "./model";
import { ProjectSwitcher } from "./project-switcher";
import { cancelReveal, closeMobileSidebar, revealProject, useSidebarMount } from "./sidebar";

function SidebarProjectSwitcher() {
  const mount = useSidebarMount();
  const pluginId = experimental_usePluginId();
  const { projects, threads } = experimental_useSidebarThreads();
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const sorted = useMemo(() => sortProjects(projects), [projects]);
  useEffect(() => cancelReveal, []);
  if (mount === null) return null;
  const open = (project: PluginSidebarProject) => {
    const threadId = firstThreadId(threads, project.id);
    if (threadId === null) navigate.toCompose({ projectId: project.id, focusPrompt: true });
    else navigate.toThread(threadId);
    revealProject(project);
    closeMobileSidebar();
  };
  // The same scope bb puts around slot content, so app.css applies outside the slot.
  return createPortal(
    <div data-bb-plugin-root="" data-bb-plugin={pluginId} className="px-2 pb-1">
      <ProjectSwitcher projects={sorted} activeProjectId={projectId} onSelect={open} />
    </div>,
    mount,
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "sidebar-project-switcher", component: SidebarProjectSwitcher });
});
