// bb-plugin-kaban — backend entry (`bb.server`).
//
// Wires the Kaban board into BB:
//   - RPC for the board page and the thread panel (app.tsx)
//   - the `bb kaban` CLI for agents and terminals
//   - per-thread instructions for threads linked to a task
//   - live refresh: host file watches → realtime "board-changed"
// The kaban CLI itself runs on the project's machine through host.ts.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BoardLocator } from "./src/board-locator.js";
import { createKabanCli } from "./src/cli.js";
import { hostContract, hostSignals } from "./src/contract.js";
import { linkedThreadInstructions, splitCommand } from "./src/instructions.js";
import { KabanClient, KabanError, type KabanRunner } from "./src/kaban-client.js";
import { LINK_MIGRATIONS, LinkStore } from "./src/links.js";
import type { BoardTarget } from "./src/model.js";
import { createThrottledPublisher } from "./src/publisher.js";
import { rpcContract } from "./src/rpc.js";
import { createKeyedQueue } from "./src/serial.js";
import { KabanService, type Scope } from "./src/service.js";

/** Realtime channel app.tsx listens on; payload `{ projectId }`. */
export const BOARD_CHANGED = "board-changed";
const RUN_TIMEOUT_MS = 20_000;
/**
 * Board-changed notifications are coalesced per project to at most one per
 * interval (leading + trailing edge), never dropped. Reading a board after a
 * write checkpoints SQLite, which costs at most one extra refetch.
 */
const PUBLISH_INTERVAL_MS = 750;
/** Renew a board's host watch at most this often. */
const WATCH_RENEW_MS = 60_000;

const rootKey = (target: Pick<BoardTarget, "hostId" | "root">) => `${target.hostId}\u0000${target.root}`;

function toError(error: unknown): unknown {
  // RPC errors reach the browser as plain messages; keep the hint with them.
  if (error instanceof KabanError) {
    return new Error(error.hint === undefined ? error.message : `${error.message} ${error.hint}`);
  }
  return error;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    kabanCommand: {
      type: "string",
      label: "Kaban command",
      description:
        "How to run the kaban CLI on each machine, e.g. `kaban` or `bunx @kaban-board/cli`. Must be on the machine's PATH.",
      default: "kaban",
      experimental_schema: z.string().trim().min(1).max(512),
    },
    startColumn: {
      type: "string",
      label: "Start column",
      description:
        "Column a task moves to when a BB thread starts working on it (empty: leave it in place).",
      default: "in_progress",
      experimental_schema: z.string().trim().max(64),
    },
    linkedThreadInstructions: {
      type: "boolean",
      label: "Tell linked threads about their task",
      description: "Add the linked task and how to update it to the agent's instructions. Applies to new agent sessions.",
      default: true,
    },
  });
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, LINK_MIGRATIONS);
  const links = new LinkStore(db);

  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });

  // Which projects are open on which board root, for routing host signals.
  const projectsByRoot = new Map<string, Set<string>>();
  const lastWatchAt = new Map<string, number>();

  const remember = (target: BoardTarget) => {
    const key = rootKey(target);
    const projects = projectsByRoot.get(key) ?? new Set<string>();
    projects.add(target.projectId);
    projectsByRoot.set(key, projects);
  };

  const publisher = createThrottledPublisher(
    (projectId) => bb.realtime.publish(BOARD_CHANGED, { projectId }),
    PUBLISH_INTERVAL_MS,
  );
  bb.onDispose(() => publisher.dispose());
  const publish = (projectId: string) => publisher.request(projectId);

  // One kaban process per board at a time (see src/serial.ts for why).
  const boardQueue = createKeyedQueue();
  const runner: KabanRunner = async (target, args, agent, signal) => {
    remember(target);
    try {
      return await boardQueue.run(
        rootKey(target),
        () =>
          host.call(
            "run",
            { root: target.root, command: splitCommand(current.kabanCommand), args, agent, timeoutMs: RUN_TIMEOUT_MS },
            signal === undefined ? { hostId: target.hostId } : { hostId: target.hostId, signal },
          ),
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error; // the caller is gone; keep the abort reason
      const message = error instanceof Error ? error.message : String(error);
      throw new KabanError("host_error", `Could not run kaban on machine ${target.hostId}: ${message}`);
    }
  };

  const watch = (target: BoardTarget) => {
    const key = rootKey(target);
    const now = Date.now();
    if (now - (lastWatchAt.get(key) ?? 0) < WATCH_RENEW_MS) return;
    lastWatchAt.set(key, now);
    host.call("watch", { root: target.root }, { hostId: target.hostId }).then(
      (result) => {
        if (!result.watching) lastWatchAt.delete(key);
        if (result.error !== null) bb.log.warn(`watch ${target.root}: ${result.error}`);
      },
      (error: unknown) => {
        lastWatchAt.delete(key);
        bb.log.warn(`watch ${target.root}: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  };

  host.experimental_onSignal("boardChanged", ({ hostId, payload }) => {
    // The host already dedups by file fingerprint (reads only touch -shm).
    const projects = [...(projectsByRoot.get(rootKey({ hostId, root: payload.root })) ?? [])];
    bb.log.debug(`board changed on ${hostId}:${payload.root} → ${projects.join(", ") || "no open project"}`);
    for (const projectId of projects) publish(projectId);
  });
  host.experimental_onWorkerExit(({ hostId }) => {
    // Its watches died with it; the next board fetch re-registers them.
    for (const key of [...lastWatchAt.keys()]) if (key.startsWith(`${hostId}\u0000`)) lastWatchAt.delete(key);
  });

  const service = new KabanService({
    sdk: () => bb.sdk,
    client: new KabanClient(runner),
    locator: new BoardLocator(() => bb.sdk),
    links,
    startColumn: () => current.startColumn,
    isGitRepo: async (target) => {
      try {
        return (await host.call("probe", { root: target.root }, { hostId: target.hostId })).isGitRepo;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new KabanError("host_error", `Could not reach machine ${target.hostId}: ${message}`);
      }
    },
    watch,
    publish,
    warn: (message) => bb.log.warn(message),
  });

  const scopeOf = (scope: { projectId: string | null; threadId: string | null }): Scope => scope;
  const withTarget = async <T>(scope: { projectId: string | null; threadId: string | null }, action: (target: BoardTarget) => Promise<T>): Promise<T> => {
    try {
      const target = await service.resolve(scopeOf(scope));
      return await service.mutate(target, () => action(target));
    } catch (error) {
      throw toError(error);
    }
  };

  bb.rpc.register(rpcContract, {
    projects_list: async () => {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects
          .filter((project) => project.kind === "standard" && project.sources.length > 0)
          .map((project) => ({ id: project.id, name: project.name })),
      };
    },
    board_get: ({ scope }) => service.snapshot(scopeOf(scope)),
    board_init: ({ scope, name }) =>
      withTarget(scope, async (target) => {
        await service.client.init(target, name);
        return { ok: true as const };
      }),
    task_add: ({ scope, title, description, column, force }) =>
      withTarget(scope, async (target) => ({
        task: await service.client.add(
          target,
          { title, description: description ?? undefined, column: column ?? undefined, force },
          null,
        ),
      })),
    task_move: ({ scope, taskId, column, force }) =>
      withTarget(scope, async (target) => ({ task: await service.client.move(target, taskId, { column, force }, null) })),
    task_done: ({ scope, taskId }) =>
      withTarget(scope, async (target) => ({ task: await service.client.done(target, taskId, null) })),
    task_assign: ({ scope, taskId, assignee }) =>
      withTarget(scope, async (target) => ({ task: await service.client.assign(target, taskId, assignee, null) })),
    task_edit: ({ scope, taskId, title, description }) =>
      withTarget(scope, async (target) => ({
        task: await service.client.edit(
          target,
          taskId,
          {
            title: title ?? undefined,
            // null leaves the description alone; an empty string clears it.
            description: description === null ? undefined : description.trim() === "" ? null : description,
          },
          null,
        ),
      })),
    task_delete: ({ scope, taskId }) =>
      withTarget(scope, async (target) => {
        await service.client.remove(target, taskId, null);
        return { ok: true as const };
      }),
    task_start_thread: async ({ scope, taskId, note }) => {
      try {
        const target = await service.resolve(scopeOf(scope));
        return await service.startThread(target, taskId, note);
      } catch (error) {
        throw toError(error);
      }
    },
    thread_link: async ({ threadId, taskId }) => {
      try {
        const { task } = await service.linkThread(threadId, taskId);
        return { task };
      } catch (error) {
        throw toError(error);
      }
    },
    thread_unlink: ({ threadId }) => ({ unlinked: service.unlinkThread(threadId) !== null }),
    thread_link_get: ({ threadId }) => {
      const link = links.forThread(threadId);
      return { taskId: link?.taskId ?? null, projectId: link?.projectId ?? null };
    },
  });

  bb.cli.register(createKabanCli(service));

  // Synchronous and fast: one indexed SQLite lookup per resolution.
  bb.agents.contributeInstructions(({ threadId }) => {
    if (!current.linkedThreadInstructions) return null;
    const link = links.forThread(threadId);
    return link === null ? null : linkedThreadInstructions(link);
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    service.unlinkThread(thread.id);
  });
}
