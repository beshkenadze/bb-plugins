// Frontend ↔ server RPC contract. app.tsx imports only its type.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { boardSnapshotSchema, projectSummarySchema, taskSchema } from "./model.js";

const id = z.string().trim().min(1).max(200);

/** Which board: a thread resolves before a project. */
export const scopeSchema = z
  .object({ projectId: id.nullable(), threadId: id.nullable() })
  .strict()
  .refine((scope) => scope.projectId !== null || scope.threadId !== null, "projectId or threadId is required");

const taskInput = z.object({ scope: scopeSchema, taskId: id }).strict();

export const rpcContract = defineRpcContract({
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(projectSummarySchema) }),
  },
  board_get: {
    input: z.object({ scope: scopeSchema }).strict(),
    output: boardSnapshotSchema,
  },
  board_init: {
    input: z.object({ scope: scopeSchema, name: z.string().trim().min(1).max(120) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  task_add: {
    input: z
      .object({
        scope: scopeSchema,
        title: z.string().trim().min(1).max(500),
        description: z.string().max(20_000).nullable(),
        column: id.nullable(),
        force: z.boolean(),
      })
      .strict(),
    output: z.object({ task: taskSchema }),
  },
  task_move: {
    input: z.object({ scope: scopeSchema, taskId: id, column: id, force: z.boolean() }).strict(),
    output: z.object({ task: taskSchema }),
  },
  task_done: { input: taskInput, output: z.object({ task: taskSchema }) },
  task_assign: {
    input: z.object({ scope: scopeSchema, taskId: id, assignee: z.string().trim().min(1).max(64).nullable() }).strict(),
    output: z.object({ task: taskSchema }),
  },
  task_edit: {
    input: z
      .object({
        scope: scopeSchema,
        taskId: id,
        title: z.string().trim().min(1).max(500).nullable(),
        description: z.string().max(20_000).nullable(),
      })
      .strict(),
    output: z.object({ task: taskSchema }),
  },
  task_delete: { input: taskInput, output: z.object({ ok: z.literal(true) }) },
  task_start_thread: {
    input: z.object({ scope: scopeSchema, taskId: id, note: z.string().max(10_000).nullable() }).strict(),
    output: z.object({ threadId: z.string(), task: taskSchema, warning: z.string().nullable() }),
  },
  thread_link: {
    input: z.object({ threadId: id, taskId: id }).strict(),
    output: z.object({ task: taskSchema }),
  },
  thread_unlink: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({ unlinked: z.boolean() }),
  },
  thread_link_get: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({ taskId: z.string().nullable(), projectId: z.string().nullable() }),
  },
});
