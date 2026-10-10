// Resolve which directory on which machine holds a project's Kaban board.
//
// Kaban keeps one `.kaban/board.db` per project checkout. BB threads often run
// in managed worktrees, which either lack `.kaban/` (gitignored) or carry a
// stale committed copy. So the board always resolves to the project's own
// checkout (project source) on the thread's machine, and only falls back to
// the thread's workspace when the project has no checkout on that machine.
import type { BoardTarget } from "./model.js";
import { KabanError } from "./kaban-client.js";

interface SourceLike {
  hostId: string;
  path: string;
  isDefault: boolean;
}

interface ProjectLike {
  id: string;
  name: string;
  sources: SourceLike[];
}

/** The slice of `bb.sdk` the locator needs; `PluginBbSdk` satisfies it. */
export interface LocatorSdk {
  projects: {
    get(args: { projectId: string }): Promise<ProjectLike>;
    list(): Promise<ProjectLike[]>;
  };
  threads: {
    get(args: { threadId: string }): Promise<{ projectId: string; environmentId: string | null }>;
  };
  environments: {
    get(args: { environmentId: string }): Promise<{ hostId: string; path: string | null }>;
  };
}

function trimSlashes(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/u, "") : value;
}

/** True when `child` is `parent` or inside it (path-segment aware). */
export function isInside(parent: string, child: string): boolean {
  const base = trimSlashes(parent);
  const target = trimSlashes(child);
  return target === base || target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

export function pickSource(sources: readonly SourceLike[], preferHostId: string | null): SourceLike | null {
  const onHost = preferHostId === null ? [] : sources.filter((source) => source.hostId === preferHostId);
  return (
    onHost.find((source) => source.isDefault) ??
    onHost[0] ??
    (preferHostId === null ? (sources.find((source) => source.isDefault) ?? sources[0]) : undefined) ??
    null
  );
}

export class BoardLocator {
  constructor(private readonly sdk: () => LocatorSdk) {}

  /** The board for a project, preferring its checkout on `preferHostId`. */
  async forProject(projectId: string, preferHostId: string | null = null): Promise<BoardTarget> {
    const project = await this.sdk().projects.get({ projectId });
    const source = pickSource(project.sources, preferHostId) ?? pickSource(project.sources, null);
    if (source === null) {
      throw new KabanError(
        "no_project_source",
        `Project "${project.name}" has no local checkout, so it has no Kaban board location.`,
        "Add a local folder to the project in BB.",
      );
    }
    return {
      projectId: project.id,
      projectName: project.name,
      hostId: source.hostId,
      root: source.path,
      via: "project-source",
    };
  }

  /**
   * Projects whose checkout contains `cwd`, for error hints only.
   *
   * A plugin CLI call does not carry the invoking machine's host id, and two
   * enrolled machines can hold the same path. Resolving a board from cwd would
   * therefore be a guess that could mutate another machine's board, so callers
   * must never use these candidates as a target — only to suggest `--project`.
   */
  async candidatesForCwd(cwd: string): Promise<Array<{ projectId: string; projectName: string; hostId: string; root: string }>> {
    const projects = await this.sdk().projects.list();
    const matches = projects.flatMap((project) =>
      project.sources
        .filter((source) => isInside(source.path, cwd))
        .map((source) => ({ projectId: project.id, projectName: project.name, hostId: source.hostId, root: source.path })),
    );
    return matches.sort((a, b) => b.root.length - a.root.length).slice(0, 5);
  }

  /** The board a thread works against: its project's checkout on the thread's machine. */
  async forThread(threadId: string): Promise<BoardTarget> {
    const thread = await this.sdk().threads.get({ threadId });
    if (thread.environmentId === null) return await this.forProject(thread.projectId);
    const environment = await this.sdk().environments.get({ environmentId: thread.environmentId });
    const project = await this.sdk().projects.get({ projectId: thread.projectId });
    const source = pickSource(project.sources, environment.hostId);
    if (source !== null) {
      return {
        projectId: project.id,
        projectName: project.name,
        hostId: source.hostId,
        root: source.path,
        via: "project-source",
      };
    }
    if (environment.path !== null) {
      return {
        projectId: project.id,
        projectName: project.name,
        hostId: environment.hostId,
        root: environment.path,
        via: "environment",
      };
    }
    return await this.forProject(thread.projectId);
  }
}
