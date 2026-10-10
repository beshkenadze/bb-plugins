// KabanService — the one place that combines board location, the kaban CLI
// client, thread links, and BB threads. RPC handlers, the `bb kaban` CLI, and
// agent instructions are thin adapters over it.
import { type BoardLocator, type LocatorSdk } from "./board-locator.js";
import { type KabanClient, KabanError } from "./kaban-client.js";
import type { LinkStore, TaskLink } from "./links.js";
import type { BoardSnapshot, BoardTarget, KabanTask, LinkedThread } from "./model.js";

/** Explicit scope wins; otherwise a thread resolves before a project. */
export interface Scope {
  projectId?: string | null | undefined;
  threadId?: string | null | undefined;
  cwd?: string | null | undefined;
}

interface ThreadLike {
  id: string;
  projectId: string;
  environmentId: string | null;
  providerId: string;
  title: string | null;
  titleFallback?: string | null;
  status: string;
  archivedAt: number | null;
}

/**
 * Where a task thread runs. Always pinned to the board's machine so the new
 * thread's `bb kaban` resolves to the same board it was started from.
 */
export type TaskThreadEnvironment = {
  type: "host";
  hostId: string;
  workspace: { type: "managed-worktree"; baseBranch: { kind: "default" } } | { type: "unmanaged"; path: string };
};

/** The slice of `bb.sdk` the service needs; `PluginBbSdk` satisfies it. */
export interface ServiceSdk extends LocatorSdk {
  threads: {
    get(args: { threadId: string }): Promise<ThreadLike>;
    spawn(args: {
      projectId: string;
      environment: TaskThreadEnvironment;
      prompt: string;
      title: string;
    }): Promise<{ id: string; providerId: string }>;
  };
}

export interface KabanServiceDeps {
  sdk: () => ServiceSdk;
  client: KabanClient;
  locator: BoardLocator;
  links: LinkStore;
  /** Column a task moves to when a thread starts on it; "" leaves it in place. */
  startColumn: () => string;
  /** Whether a board root is a git checkout (decides worktree vs. in-place). */
  isGitRepo: (target: BoardTarget) => Promise<boolean>;
  /** Renew the host-side file watch for an open board (fire and forget). */
  watch: (target: BoardTarget) => void;
  /** Tell open boards for this project to refetch. */
  publish: (projectId: string) => void;
  warn: (message: string) => void;
}

/**
 * Pin a task thread to the board's machine:
 * - a git project checkout gets its own managed worktree there (the locator
 *   maps that worktree back to the checkout's board);
 * - anything else works in the board root itself, which is exactly where the
 *   locator resolves that thread's board.
 */
export function environmentFor(target: BoardTarget, isGitRepo: boolean): TaskThreadEnvironment {
  if (target.via === "project-source" && isGitRepo) {
    return { type: "host", hostId: target.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
  }
  return { type: "host", hostId: target.hostId, workspace: { type: "unmanaged", path: target.root } };
}

/** Linked threads shown per task card, newest last. */
const THREADS_PER_TASK = 3;
const MAX_LINKED_THREAD_LOOKUPS = 60;

export function taskRef(task: Pick<KabanTask, "id" | "number">): string {
  return task.number === null ? task.id : String(task.number);
}

export function taskLabel(task: Pick<KabanTask, "id" | "number">): string {
  return task.number === null ? task.id.slice(0, 8) : `#${task.number}`;
}

export function buildTaskPrompt(task: KabanTask, note: string | null): string {
  const ref = taskRef(task);
  const lines = [`Work on Kaban task ${taskLabel(task)}: ${task.title}`];
  if (task.description !== null && task.description.trim() !== "") lines.push("", task.description.trim());
  if (task.labels.length > 0) lines.push("", `Labels: ${task.labels.join(", ")}`);
  if (note !== null && note.trim() !== "") lines.push("", note.trim());
  lines.push(
    "",
    `This thread is linked to the task. Re-read it with \`bb kaban show ${ref}\`. ` +
      `When the work is ready for review, run \`bb kaban move ${ref} review\`; ` +
      `when it is fully complete, run \`bb kaban done ${ref}\`.`,
  );
  return lines.join("\n");
}

export function sameBoard(a: Pick<BoardTarget, "hostId" | "root">, b: Pick<BoardTarget, "hostId" | "root">): boolean {
  return a.hostId === b.hostId && a.root === b.root;
}

function describeError(error: KabanError): string {
  return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
}

export class KabanService {
  /** threadId → providerId, used as the acting kaban agent for CLI calls. */
  private readonly providerByThread = new Map<string, string>();

  constructor(private readonly deps: KabanServiceDeps) {}

  get client(): KabanClient {
    return this.deps.client;
  }

  get links(): LinkStore {
    return this.deps.links;
  }

  /**
   * Resolve a board from a trustworthy scope only: a thread (its environment
   * names the machine) or an explicit project. A bare cwd is never used as a
   * target — the invoking machine is unknown and paths can repeat across
   * machines — it only feeds the `--project` suggestion in the error.
   */
  async resolve(scope: Scope): Promise<BoardTarget> {
    if (scope.threadId) return await this.deps.locator.forThread(scope.threadId);
    if (scope.projectId) return await this.deps.locator.forProject(scope.projectId);
    let hint = "Run from a BB agent thread or pass --project <projectId> (see `bb project list`).";
    if (scope.cwd) {
      try {
        const candidates = await this.deps.locator.candidatesForCwd(scope.cwd);
        if (candidates.length > 0) {
          hint = `This folder matches ${candidates
            .map((candidate) => `--project ${candidate.projectId} (${candidate.projectName}, host ${candidate.hostId})`)
            .join("; ")}. Pass --project explicitly.`;
        }
      } catch {
        // Suggestions are best effort; keep the generic hint.
      }
    }
    throw new KabanError("invalid", "No BB thread or project in scope.", hint);
  }

  /** Who is acting, for KABAN_AGENT: the thread's provider, or the CLI default. */
  async agentFor(threadId: string | null | undefined): Promise<string | null> {
    if (!threadId) return null;
    const cached = this.providerByThread.get(threadId);
    if (cached !== undefined) return cached;
    try {
      const thread = await this.deps.sdk().threads.get({ threadId });
      this.providerByThread.set(threadId, thread.providerId);
      return thread.providerId;
    } catch {
      return null;
    }
  }

  async snapshot(scope: Scope): Promise<BoardSnapshot> {
    let target: BoardTarget | null = null;
    try {
      target = await this.resolve(scope);
      const [status, tasks] = await Promise.all([
        this.deps.client.status(target),
        this.deps.client.list(target),
      ]);
      this.deps.watch(target);
      return { state: "ready", target, status, tasks, links: await this.linkedThreads(target.projectId, tasks) };
    } catch (error) {
      if (error instanceof KabanError) {
        return { state: "unavailable", target, code: error.code, message: describeError(error) };
      }
      throw error;
    }
  }

  /** Run a board mutation, then notify open boards. */
  async mutate<T>(target: BoardTarget, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } finally {
      this.deps.publish(target.projectId);
    }
  }

  /**
   * Link a thread to a task on the thread's own board.
   *
   * A link is only meaningful on the board the thread's plain `bb kaban`
   * resolves to: its instructions say `bb kaban move 12 review` without
   * --project. So when the caller resolved a board some other way (`expected`,
   * e.g. from --project), it must be that same board or the link is refused.
   */
  async linkThread(
    threadId: string,
    ref: string,
    options: { expected?: BoardTarget | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<{ link: TaskLink; task: KabanTask; previous: TaskLink | null; target: BoardTarget }> {
    const { expected, signal } = options;
    const target = await this.threadBoard(threadId, expected);
    const task = await this.deps.client.withSignal(signal).get(target, ref);
    signal?.throwIfAborted();
    const link: TaskLink = {
      threadId,
      projectId: target.projectId,
      taskId: task.id,
      number: task.number,
      title: task.title,
      linkedAt: Date.now(),
    };
    const previous = this.deps.links.link(link);
    if (previous !== null && previous.projectId !== target.projectId) this.deps.publish(previous.projectId);
    this.deps.publish(target.projectId);
    return { link, task, previous, target };
  }

  /** The thread's own board; throws when it is not `expected` (see linkThread). */
  async threadBoard(threadId: string, expected?: BoardTarget): Promise<BoardTarget> {
    const target = await this.resolve({ threadId });
    if (expected !== undefined && !sameBoard(expected, target)) {
      throw new KabanError(
        "invalid",
        `Thread ${threadId} works against the board at ${target.root} (${target.projectName}, host ${target.hostId}), not ${expected.root} (${expected.projectName}, host ${expected.hostId}).`,
        "Link a thread that runs on that board, or create one there with `bb kaban start <task>`.",
      );
    }
    return target;
  }

  unlinkThread(threadId: string): TaskLink | null {
    const removed = this.deps.links.unlink(threadId);
    if (removed !== null) this.deps.publish(removed.projectId);
    return removed;
  }

  /** Move a task into the start column (if configured and present) and assign it. */
  async markStarted(
    target: BoardTarget,
    task: KabanTask,
    assignee: string | null,
    signal?: AbortSignal,
  ): Promise<{ task: KabanTask; warning: string | null }> {
    const startColumn = this.deps.startColumn().trim();
    const client = this.deps.client.withSignal(signal);
    try {
      if (startColumn !== "" && task.columnId !== startColumn) {
        const status = await client.status(target);
        const column = status.columns.find((candidate) => candidate.id === startColumn);
        const current = status.columns.find((candidate) => candidate.id === task.columnId);
        if (column !== undefined && current?.isTerminal !== true) {
          return {
            task: await client.move(target, task.id, { column: column.id, assign: assignee ?? undefined }, assignee),
            warning: null,
          };
        }
      }
      if (assignee !== null && task.assignedTo !== assignee) {
        return { task: await client.assign(target, task.id, assignee, assignee), warning: null };
      }
      return { task, warning: null };
    } catch (error) {
      if (!(error instanceof KabanError)) throw error;
      return { task, warning: `Could not update the task: ${describeError(error)}` };
    } finally {
      this.deps.publish(target.projectId);
    }
  }

  /**
   * Spawn a BB thread that works on a task, link it, and mark the task started.
   * `signal` can cancel until the thread exists; after that the link and the
   * column move always complete so the board matches the running thread.
   */
  async startThread(
    target: BoardTarget,
    ref: string,
    note: string | null,
    signal?: AbortSignal,
  ): Promise<{ threadId: string; task: KabanTask; warning: string | null }> {
    const task = await this.deps.client.withSignal(signal).get(target, ref);
    const environment = environmentFor(target, await this.deps.isGitRepo(target));
    signal?.throwIfAborted();
    const thread = await this.deps.sdk().threads.spawn({
      projectId: target.projectId,
      environment,
      prompt: buildTaskPrompt(task, note),
      title: `${taskLabel(task)} ${task.title}`.slice(0, 200),
    });
    this.providerByThread.set(thread.id, thread.providerId);
    this.deps.links.link({
      threadId: thread.id,
      projectId: target.projectId,
      taskId: task.id,
      number: task.number,
      title: task.title,
      linkedAt: Date.now(),
    });
    const started = await this.markStarted(target, task, thread.providerId);
    return { threadId: thread.id, task: started.task, warning: started.warning };
  }

  private async linkedThreads(projectId: string, tasks: KabanTask[]): Promise<Record<string, LinkedThread[]>> {
    const byTask = this.deps.links.forProject(projectId);
    const known = new Set(tasks.map((task) => task.id));
    const wanted: Array<[string, string]> = [];
    for (const [taskId, threadIds] of byTask) {
      if (!known.has(taskId)) continue;
      for (const threadId of threadIds.slice(-THREADS_PER_TASK)) wanted.push([taskId, threadId]);
    }
    const lookups = wanted.slice(-MAX_LINKED_THREAD_LOOKUPS);
    const resolved = await Promise.allSettled(
      lookups.map(async ([taskId, threadId]) => {
        const thread = await this.deps.sdk().threads.get({ threadId });
        return [taskId, { threadId, title: thread.title ?? thread.titleFallback ?? null, status: thread.status, archived: thread.archivedAt !== null }] as const;
      }),
    );
    const result: Record<string, LinkedThread[]> = {};
    for (const outcome of resolved) {
      if (outcome.status !== "fulfilled") continue;
      const [taskId, thread] = outcome.value;
      (result[taskId] ??= []).push(thread);
    }
    return result;
  }
}
