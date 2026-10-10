// Human-readable CLI output. JSON output is the plain model (see cli.ts).
import type { BoardTarget, KabanBoardStatus, KabanTask } from "./model.js";
import { taskLabel } from "./service.js";

export function formatTaskLine(task: KabanTask): string {
  const parts = [taskLabel(task).padEnd(5), `[${task.columnId}]`, task.title];
  if (task.assignedTo !== null) parts.push(`@${task.assignedTo}`);
  if (task.labels.length > 0) parts.push(task.labels.map((label) => `#${label}`).join(" "));
  if (task.blockedReason !== null) parts.push(`(blocked: ${task.blockedReason})`);
  return parts.join("  ");
}

export function formatTaskDetail(task: KabanTask, linkedThreads: string[] = []): string {
  const lines = [`${taskLabel(task)}  ${task.title}`, `  id:       ${task.id}`, `  column:   ${task.columnId}`];
  if (task.assignedTo !== null) lines.push(`  assignee: ${task.assignedTo}`);
  if (task.createdBy !== null) lines.push(`  created:  ${task.createdBy}${task.createdAt === null ? "" : ` at ${task.createdAt}`}`);
  if (task.labels.length > 0) lines.push(`  labels:   ${task.labels.join(", ")}`);
  if (task.dependsOn.length > 0) lines.push(`  depends:  ${task.dependsOn.join(", ")}`);
  if (task.dueDate !== null) lines.push(`  due:      ${task.dueDate}`);
  if (task.blockedReason !== null) lines.push(`  blocked:  ${task.blockedReason}`);
  if (linkedThreads.length > 0) lines.push(`  threads:  ${linkedThreads.join(", ")}`);
  if (task.description !== null && task.description.trim() !== "") {
    lines.push("", ...task.description.trim().split("\n").map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

export function formatStatus(target: BoardTarget, status: KabanBoardStatus): string {
  const columns = status.columns
    .map((column) => `${column.name} ${column.count}${column.wipLimit === null ? "" : `/${column.wipLimit}`}`)
    .join(" · ");
  const lines = [
    `Board "${status.name}" — project ${target.projectName}`,
    `  ${target.root} (host ${target.hostId}${target.via === "environment" ? ", thread workspace" : ""})`,
    `  ${columns}`,
    `  ${status.totalTasks} task(s)${status.blockedCount > 0 ? `, ${status.blockedCount} blocked` : ""}`,
  ];
  return lines.join("\n");
}

/** Group tasks under their column headings, in board order. */
export function formatBoardList(status: KabanBoardStatus | null, tasks: KabanTask[]): string {
  if (tasks.length === 0) return "No tasks.";
  if (status === null) return tasks.map(formatTaskLine).join("\n");
  const order = new Map(status.columns.map((column, index) => [column.id, index]));
  const names = new Map(status.columns.map((column) => [column.id, column.name]));
  const groups = new Map<string, KabanTask[]>();
  for (const task of [...tasks].sort((a, b) => (order.get(a.columnId) ?? 99) - (order.get(b.columnId) ?? 99) || a.position - b.position)) {
    const group = groups.get(task.columnId) ?? [];
    group.push(task);
    groups.set(task.columnId, group);
  }
  return [...groups]
    .map(([columnId, group]) => [`${names.get(columnId) ?? columnId}:`, ...group.map((task) => `  ${formatTaskLine(task)}`)].join("\n"))
    .join("\n\n");
}
