// `bb kaban …` — the agent- and terminal-facing command.
//
// Every command resolves its board from --thread / --project, then the
// invoking thread. A bare cwd is never trusted as a target (the invoking
// machine is unknown); it only produces a `--project` suggestion. Output is
// bounded: lists are capped by --limit and JSON is the plain plugin model.
import { type PluginCliContext, PluginCliError, type PluginCliRegistration, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { formatBoardList, formatStatus, formatTaskDetail, formatTaskLine } from "./format.js";
import { KabanError } from "./kaban-client.js";
import type { BoardTarget, KabanTask } from "./model.js";
import { type KabanService, type Scope, taskLabel } from "./service.js";

const scopeOptions = {
  project: {
    type: "string",
    placeholder: "projectId",
    description: "BB project id (proj_…); required outside a BB thread",
    aliases: ["project-id"],
  },
  thread: {
    type: "string",
    placeholder: "threadId",
    description: "BB thread id (thr_…); defaults to the invoking thread",
    aliases: ["thread-id"],
  },
  json: { type: "boolean", description: "Emit machine-readable JSON" },
} as const;

const taskPositional = { name: "task", description: "Task number (12 or #12) or task id", required: true } as const;

interface ScopeOptions {
  project?: string | undefined;
  thread?: string | undefined;
  json: boolean;
}

function scopeFrom(options: ScopeOptions, ctx: PluginCliContext): Scope {
  if (options.thread !== undefined) return { threadId: options.thread };
  if (options.project !== undefined) return { projectId: options.project };
  return { threadId: ctx.threadId ?? null, projectId: ctx.projectId ?? null, cwd: ctx.cwd ?? null };
}

function reply(json: boolean, value: unknown, text: string) {
  return { exitCode: 0, stdout: json ? JSON.stringify(value, null, 2) : text };
}

/** Convert plugin errors into the CLI's `{ ok: false, error }` contract. */
async function guard<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof KabanError) {
      throw new PluginCliError(error.message, {
        code: error.code,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
      });
    }
    throw error;
  }
}

function threadFor(options: ScopeOptions, ctx: PluginCliContext, verb: string): string {
  const threadId = options.thread ?? ctx.threadId;
  if (threadId === undefined) {
    throw new PluginCliError(`No thread to ${verb}.`, {
      code: "thread_required",
      hint: "Run this from a BB agent thread or pass --thread <threadId>.",
    });
  }
  return threadId;
}

export function createKabanCli(service: KabanService): PluginCliRegistration {
  const resolve = (options: ScopeOptions, ctx: PluginCliContext): Promise<BoardTarget> =>
    service.resolve(scopeFrom(options, ctx));
  const agent = (options: ScopeOptions, ctx: PluginCliContext) => service.agentFor(options.thread ?? ctx.threadId);
  // Every kaban run is tied to the invoking CLI request: if it disconnects,
  // queued runs never start and a running one is killed on the host.
  const kaban = (ctx: PluginCliContext) => service.client.withSignal(ctx.signal);

  return defineCli({
    name: "kaban",
    summary: "Work with the project's Kaban board (tasks for humans and agents)",
    description:
      "Reads and updates the Kaban board (.kaban/board.db) of the current BB project through the kaban CLI on the project's machine. Threads can be linked to tasks so the board shows who works on what.",
    commands: {
      status: cliCommand({
        summary: "Show the board location and column counts",
        options: scopeOptions,
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const status = await kaban(ctx).status(target);
            return reply(input.options.json, { target, status }, formatStatus(target, status));
          }),
      }),

      list: cliCommand({
        summary: "List tasks grouped by column",
        options: {
          ...scopeOptions,
          column: { type: "string", placeholder: "column", description: "Only this column id (todo, in_progress, …)" },
          assignee: { type: "string", placeholder: "agent", description: "Only tasks assigned to this agent" },
          blocked: { type: "boolean", description: "Only blocked tasks" },
          limit: { type: "integer", min: 1, max: 500, default: 200, description: "Maximum tasks to print (1-500)" },
        },
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const filters = {
              column: input.options.column,
              assignee: input.options.assignee,
              blocked: input.options.blocked,
            };
            const [status, tasks] = await Promise.all([kaban(ctx).status(target), kaban(ctx).list(target, filters)]);
            const shown = tasks.slice(0, input.options.limit);
            const more = tasks.length - shown.length;
            return reply(
              input.options.json,
              { tasks: shown, total: tasks.length, truncated: more > 0 },
              formatBoardList(status, shown) + (more > 0 ? `\n\n… ${more} more (raise --limit)` : ""),
            );
          }),
      }),

      show: cliCommand({
        summary: "Show one task with its linked threads",
        positionals: [taskPositional],
        options: scopeOptions,
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const task = await kaban(ctx).get(target, input.positionals.task);
            const threads = service.links.threadsForTask(target.projectId, task.id);
            return reply(input.options.json, { task, threads }, formatTaskDetail(task, threads));
          }),
      }),

      add: cliCommand({
        summary: "Add a task",
        positionals: [{ name: "title", description: "Task title", required: true, variadic: true }],
        options: {
          ...scopeOptions,
          description: { type: "string", placeholder: "text", description: "Task description (markdown)", stdin: true },
          column: { type: "string", placeholder: "column", description: "Column id; defaults to the board's default (todo)" },
          "depends-on": {
            type: "string",
            repeatable: true,
            split: ",",
            placeholder: "task",
            description: "Task this one depends on (repeat or comma-separate)",
          },
          force: { type: "boolean", description: "Create even if a very similar task exists" },
          link: { type: "boolean", description: "Link the invoking thread to the new task" },
        },
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            // Validate --link before creating anything, so a refused link adds no task.
            const linkThreadId = input.options.link ? threadFor(input.options, ctx, "link") : null;
            if (linkThreadId !== null) await service.threadBoard(linkThreadId, target);
            const actor = await agent(input.options, ctx);
            const task = await service.mutate(target, () =>
              kaban(ctx).add(
                target,
                {
                  title: input.positionals.title.join(" "),
                  description: input.options.description,
                  column: input.options.column,
                  dependsOn: input.options["depends-on"],
                  force: input.options.force,
                },
                actor,
              ),
            );
            let linked = false;
            if (linkThreadId !== null) {
              await service.linkThread(linkThreadId, task.id, { expected: target, signal: ctx.signal });
              linked = true;
            }
            return reply(input.options.json, { task, linked }, `Added ${formatTaskLine(task)}${linked ? "\nLinked this thread to it." : ""}`);
          }),
      }),

      move: cliCommand({
        summary: "Move a task to a column (or --next)",
        positionals: [taskPositional, { name: "column", description: "Target column id (todo, in_progress, review, done, …)" }],
        options: {
          ...scopeOptions,
          next: { type: "boolean", description: "Advance to the next column" },
          assign: { type: "string", placeholder: "agent", description: "Also assign the task to this agent" },
          force: { type: "boolean", description: "Ignore the column's WIP limit" },
        },
        run: (input, ctx) =>
          guard(async () => {
            const column = input.positionals.column;
            if ((column === undefined) === !input.options.next) {
              throw new PluginCliError("Pass exactly one of <column> or --next.", { code: "usage" });
            }
            const target = await resolve(input.options, ctx);
            const actor = await agent(input.options, ctx);
            const task = await service.mutate(target, () =>
              kaban(ctx).move(
                target,
                input.positionals.task,
                { column: column ?? "next", assign: input.options.assign, force: input.options.force },
                actor,
              ),
            );
            return reply(input.options.json, { task }, `Moved ${formatTaskLine(task)}`);
          }),
      }),

      assign: cliCommand({
        summary: "Assign a task to an agent or person (or --clear)",
        positionals: [taskPositional, { name: "assignee", description: "Agent or person name" }],
        options: { ...scopeOptions, clear: { type: "boolean", description: "Unassign the task" } },
        run: (input, ctx) =>
          guard(async () => {
            const assignee = input.positionals.assignee;
            if ((assignee === undefined) === !input.options.clear) {
              throw new PluginCliError("Pass exactly one of <assignee> or --clear.", { code: "usage" });
            }
            const target = await resolve(input.options, ctx);
            const actor = await agent(input.options, ctx);
            const task = await service.mutate(target, () =>
              kaban(ctx).assign(target, input.positionals.task, assignee ?? null, actor),
            );
            return reply(input.options.json, { task }, formatTaskLine(task));
          }),
      }),

      done: cliCommand({
        summary: "Mark a task done",
        positionals: [taskPositional],
        options: scopeOptions,
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const actor = await agent(input.options, ctx);
            const task = await service.mutate(target, () => kaban(ctx).done(target, input.positionals.task, actor));
            return reply(input.options.json, { task }, `Done ${formatTaskLine(task)}`);
          }),
      }),

      edit: cliCommand({
        summary: "Edit a task's title, description, or labels",
        positionals: [taskPositional],
        options: {
          ...scopeOptions,
          title: { type: "string", placeholder: "text", description: "New title" },
          description: { type: "string", placeholder: "text", description: "New description (markdown)", stdin: true },
          "clear-description": { type: "boolean", description: "Remove the description" },
          labels: { type: "string", repeatable: true, split: ",", placeholder: "label", description: "Replace labels (repeat or comma-separate)" },
        },
        constraints: [
          { kind: "at-least-one", options: ["title", "description", "clear-description", "labels"] },
          { kind: "at-most-one", options: ["description", "clear-description"] },
        ],
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const actor = await agent(input.options, ctx);
            const labels = input.options.labels.length > 0 ? input.options.labels : undefined;
            const task = await service.mutate(target, () =>
              kaban(ctx).edit(
                target,
                input.positionals.task,
                {
                  title: input.options.title,
                  description: input.options["clear-description"] ? null : input.options.description,
                  labels,
                },
                actor,
              ),
            );
            return reply(input.options.json, { task }, `Updated ${formatTaskLine(task)}`);
          }),
      }),

      next: cliCommand({
        summary: "Show the next actionable task (optionally start it in this thread)",
        options: {
          ...scopeOptions,
          column: { type: "string", placeholder: "column", description: "Column to pick from (default: todo)" },
          start: { type: "boolean", description: "Link the invoking thread to it and move it to the start column" },
        },
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const task = await kaban(ctx).next(target, input.options.column);
            if (task === null) return reply(input.options.json, { task: null }, "No actionable tasks.");
            if (!input.options.start) return reply(input.options.json, { task }, formatTaskDetail(task));
            const threadId = threadFor(input.options, ctx, "start");
            await service.linkThread(threadId, task.id, { expected: target, signal: ctx.signal });
            const started = await service.markStarted(target, task, await service.agentFor(threadId), ctx.signal);
            return reply(
              input.options.json,
              { task: started.task, linked: true, warning: started.warning },
              `${formatTaskDetail(started.task)}\n\nLinked this thread to ${taskLabel(task)}.${started.warning === null ? "" : `\nWarning: ${started.warning}`}`,
            );
          }),
      }),

      link: cliCommand({
        summary: "Link a thread (default: this one) to a task",
        positionals: [taskPositional],
        options: {
          ...scopeOptions,
          start: { type: "boolean", description: "Also move the task to the start column and assign it" },
        },
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options, ctx, "link");
            // --project only asserts which board is meant; a thread links on its own board.
            const expected = input.options.project === undefined ? undefined : await service.resolve({ projectId: input.options.project });
            const { task, previous, target } = await service.linkThread(threadId, input.positionals.task, {
              expected,
              signal: ctx.signal,
            });
            const started = input.options.start
              ? await service.markStarted(target, task, await service.agentFor(threadId), ctx.signal)
              : null;
            const lines = [`Linked ${threadId} to ${formatTaskLine(started?.task ?? task)}`];
            if (previous !== null && previous.taskId !== task.id) lines.push(`(was linked to ${previous.number === null ? previous.taskId : `#${previous.number}`})`);
            if (started?.warning) lines.push(`Warning: ${started.warning}`);
            return reply(input.options.json, { threadId, task: started?.task ?? task, previous, warning: started?.warning ?? null }, lines.join("\n"));
          }),
      }),

      unlink: cliCommand({
        summary: "Unlink a thread (default: this one) from its task",
        options: scopeOptions,
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options, ctx, "unlink");
            const removed = service.unlinkThread(threadId);
            return reply(
              input.options.json,
              { threadId, unlinked: removed !== null, link: removed },
              removed === null ? `${threadId} is not linked to a task.` : `Unlinked ${threadId} from ${removed.number === null ? removed.taskId : `#${removed.number}`}.`,
            );
          }),
      }),

      current: cliCommand({
        summary: "Show the task linked to a thread (default: this one)",
        options: scopeOptions,
        run: (input, ctx) =>
          guard(async () => {
            const threadId = threadFor(input.options, ctx, "inspect");
            const link = service.links.forThread(threadId);
            if (link === null) return reply(input.options.json, { threadId, task: null }, `${threadId} is not linked to a task.`);
            // Links always live on the thread's own board (see KabanService.linkThread).
            const target = await service.resolve({ threadId });
            let task: KabanTask | null = null;
            try {
              task = await kaban(ctx).get(target, link.taskId);
            } catch (error) {
              if (!(error instanceof KabanError) || error.code !== "not_found") throw error;
            }
            return reply(
              input.options.json,
              { threadId, link, task },
              task === null ? `Linked task ${link.number === null ? link.taskId : `#${link.number}`} no longer exists (archived or deleted).` : formatTaskDetail(task),
            );
          }),
      }),

      start: cliCommand({
        summary: "Start a new BB thread that works on a task",
        positionals: [taskPositional],
        options: {
          ...scopeOptions,
          note: { type: "string", placeholder: "text", description: "Extra instructions appended to the task prompt", stdin: true },
        },
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            const result = await service.startThread(target, input.positionals.task, input.options.note ?? null, ctx.signal);
            return reply(
              input.options.json,
              result,
              `Started @thread:${result.threadId} on ${formatTaskLine(result.task)}${result.warning === null ? "" : `\nWarning: ${result.warning}`}`,
            );
          }),
      }),

      init: cliCommand({
        summary: "Create a Kaban board in the project checkout",
        options: { ...scopeOptions, name: { type: "string", placeholder: "name", description: "Board name (default: project name)" } },
        run: (input, ctx) =>
          guard(async () => {
            const target = await resolve(input.options, ctx);
            await service.mutate(target, () => kaban(ctx).init(target, input.options.name ?? target.projectName));
            const status = await kaban(ctx).status(target);
            return reply(input.options.json, { target, status }, formatStatus(target, status));
          }),
      }),
    },
  });
}
