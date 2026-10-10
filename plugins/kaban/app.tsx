// bb-plugin-kaban — frontend entry (`bb.app`).
//
// - "Kaban" sidebar page: the board of a chosen project (deep link
//   /plugins/kaban/board/<projectId>), with a project picker in the header.
// - "Kaban board" thread panel tab: the board of the thread's project on the
//   thread's machine, with link/unlink actions for that thread.
import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectSummary } from "./src/model";
import type { rpcContract } from "./src/rpc";
import { EmptyState, KabanBoard } from "./ui/board";
import { errorMessage } from "./ui/use-board";

const PANEL_PATH = "board";

function useProjects() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc.call("projects_list").then(
      (result) => setProjects(result.projects),
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }, [rpc]);
  return { projects, error };
}

function useLastProject() {
  const pluginId = experimental_usePluginId();
  return useMemo(() => {
    const key = `${pluginId}:last-project`;
    return {
      read: () => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      write: (projectId: string) => {
        try {
          window.localStorage.setItem(key, projectId);
        } catch {
          // storage unavailable: the picker still works for this session
        }
      },
    };
  }, [pluginId]);
}

function BoardPage({ subPath }: { subPath: string }) {
  const { projects, error } = useProjects();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const last = useLastProject();
  const projectId = subPath.split("/")[0] || null;

  // Without a project in the URL, open the current/last/first project.
  useEffect(() => {
    if (projectId !== null || projects === null || projects.length === 0) return;
    const known = (id: string | null) => (id !== null && projects.some((project) => project.id === id) ? id : null);
    const next = known(context.projectId) ?? known(last.read()) ?? projects[0]?.id;
    if (next !== undefined) navigate.toPluginPanel(PANEL_PATH, { subPath: next, replace: true });
  }, [projectId, projects, context.projectId, last, navigate]);

  useEffect(() => {
    if (projectId !== null) last.write(projectId);
  }, [projectId, last]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col p-4 md:p-5">
      {error !== null ? (
        <EmptyState>{error}</EmptyState>
      ) : projects !== null && projects.length === 0 ? (
        <EmptyState>No BB projects with a local folder yet. Add a project to see its Kaban board.</EmptyState>
      ) : projectId === null ? (
        <EmptyState>Loading projects…</EmptyState>
      ) : (
        <KabanBoard key={projectId} scope={{ projectId, threadId: null }} />
      )}
    </div>
  );
}

function ProjectPicker({ subPath }: { subPath: string }) {
  const { projects } = useProjects();
  const navigate = useBbNavigate();
  const projectId = subPath.split("/")[0] || undefined;
  if (projects === null || projects.length < 2) return null;
  return (
    <Select value={projectId} onValueChange={(next) => navigate.toPluginPanel(PANEL_PATH, { subPath: next })}>
      <SelectTrigger className="h-8 w-48" aria-label="Project">
        <SelectValue placeholder="Project" />
      </SelectTrigger>
      <SelectContent align="end">
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ThreadBoardPanel({ threadId }: { threadId: string }) {
  return <KabanBoard scope={{ projectId: null, threadId }} threadId={threadId} stacked />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Kaban",
    icon: "LayoutGrid",
    path: PANEL_PATH,
    component: BoardPage,
    headerContent: ProjectPicker,
  });
  app.slots.threadPanelAction({
    id: "thread-board",
    title: "Kaban board",
    icon: "LayoutGrid",
    component: ThreadBoardPanel,
  });
});
