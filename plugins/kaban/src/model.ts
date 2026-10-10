// Wire model shared by the server, the RPC contract, and the frontend.
// These schemas describe what the plugin returns, normalized from whatever the
// installed kaban CLI version prints.
import { z } from "zod";

export const taskSchema = z.object({
  id: z.string(),
  /** Short per-board number (`#12`); null on CLI versions that lack it. */
  number: z.number().int().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  columnId: z.string(),
  position: z.number(),
  createdBy: z.string().nullable(),
  assignedTo: z.string().nullable(),
  labels: z.array(z.string()),
  dependsOn: z.array(z.string()),
  blockedReason: z.string().nullable(),
  dueDate: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type KabanTask = z.infer<typeof taskSchema>;

export const columnSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int(),
  wipLimit: z.number().int().nullable(),
  isTerminal: z.boolean(),
});
export type KabanColumn = z.infer<typeof columnSchema>;

export const boardStatusSchema = z.object({
  name: z.string(),
  columns: z.array(columnSchema),
  blockedCount: z.number().int(),
  totalTasks: z.number().int(),
});
export type KabanBoardStatus = z.infer<typeof boardStatusSchema>;

/** Where a board lives: a directory on one enrolled machine. */
export const boardTargetSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  hostId: z.string(),
  root: z.string(),
  /** project-source: the project's checkout; environment: a thread's own workspace. */
  via: z.enum(["project-source", "environment"]),
});
export type BoardTarget = z.infer<typeof boardTargetSchema>;

export const linkedThreadSchema = z.object({
  threadId: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  archived: z.boolean(),
});
export type LinkedThread = z.infer<typeof linkedThreadSchema>;

export const errorCodeSchema = z.enum([
  "not_installed",
  "no_board",
  "no_project_source",
  "not_found",
  "invalid",
  "conflict",
  "cli_error",
  "bad_output",
  "host_error",
]);
export type KabanErrorCode = z.infer<typeof errorCodeSchema>;

export const boardSnapshotSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    target: boardTargetSchema,
    status: boardStatusSchema,
    tasks: z.array(taskSchema),
    /** taskId → threads linked to it. */
    links: z.record(z.string(), z.array(linkedThreadSchema)),
  }),
  z.object({
    state: z.literal("unavailable"),
    target: boardTargetSchema.nullable(),
    code: errorCodeSchema,
    message: z.string(),
  }),
]);
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

export const projectSummarySchema = z.object({ id: z.string(), name: z.string() });
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
