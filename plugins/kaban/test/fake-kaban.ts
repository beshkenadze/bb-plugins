// In-memory stand-in for the host entry + kaban CLI, faithful to the CLI's
// observed `--json` envelopes and error texts (kaban 0.3.x).
import type { ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";

interface FakeTask {
  id: string;
  boardTaskId: number;
  title: string;
  description: string | null;
  columnId: string;
  position: number;
  createdBy: string;
  assignedTo: string | null;
  labels: string[];
  dependsOn: string[];
}

const COLUMNS = [
  { id: "backlog", name: "Backlog", wipLimit: null, isTerminal: false },
  { id: "todo", name: "Todo", wipLimit: null, isTerminal: false },
  { id: "in_progress", name: "In Progress", wipLimit: 3, isTerminal: false },
  { id: "review", name: "Review", wipLimit: 2, isTerminal: false },
  { id: "done", name: "Done", wipLimit: null, isTerminal: true },
];

export interface RunRecord {
  hostId: string;
  root: string;
  args: string[];
  agent: string | null;
  command: string[];
}

export class FakeKaban {
  boards = new Map<string, { name: string; tasks: FakeTask[] }>();
  runs: RunRecord[] = [];
  watches: Array<{ hostId: string; root: string }> = [];
  notInstalled = false;
  /** `${hostId}:${root}` keys whose root is a git checkout. */
  gitRoots = new Set<string>();
  private seq = 0;

  board(hostId: string, root: string) {
    return this.boards.get(`${hostId}:${root}`);
  }

  init(hostId: string, root: string, name = "Board") {
    this.boards.set(`${hostId}:${root}`, { name, tasks: [] });
  }

  seed(hostId: string, root: string, title: string, columnId = "todo"): FakeTask {
    const board = this.board(hostId, root);
    if (board === undefined) throw new Error("no board");
    this.seq += 1;
    const task: FakeTask = {
      id: `01TASK${String(this.seq).padStart(4, "0")}`,
      boardTaskId: board.tasks.length + 1,
      title,
      description: null,
      columnId,
      position: board.tasks.filter((candidate) => candidate.columnId === columnId).length,
      createdBy: "user",
      assignedTo: null,
      labels: [],
      dependsOn: [],
    };
    board.tasks.push(task);
    return task;
  }

  handle = (call: ExperimentalFakeHostRpcCall): unknown => {
    const input = call.input as Record<string, unknown>;
    if (call.method === "watch") {
      this.watches.push({ hostId: call.hostId, root: String(input.root) });
      return { watching: true, error: null };
    }
    if (call.method === "probe") {
      const key = `${call.hostId}:${String(input.root)}`;
      return { rootExists: true, boardExists: this.boards.has(key), isGitRepo: this.gitRoots.has(key) };
    }
    const run = {
      hostId: call.hostId,
      root: String(input.root),
      args: input.args as string[],
      agent: (input.agent as string | null) ?? null,
      command: input.command as string[],
    };
    this.runs.push(run);
    return this.run(run);
  };

  private run(run: RunRecord) {
    if (this.notInstalled) return { exitCode: -1, stdout: "", stderr: "", spawnError: `Command not found: ${run.command[0]}` };
    const [command, ...rest] = run.args;
    const separator = rest.indexOf("--");
    const flags = separator === -1 ? rest : rest.slice(0, separator);
    const positionals = separator === -1 ? [] : rest.slice(separator + 1);
    const option = (name: string) => {
      const found = flags.find((flag) => flag === `--${name}` || flag.startsWith(`--${name}=`));
      if (found === undefined) return undefined;
      return found.includes("=") ? found.slice(found.indexOf("=") + 1) : true;
    };
    if (command === "init") {
      this.init(run.hostId, run.root, String(rest.find((arg) => arg.startsWith("--name="))?.slice(7) ?? "Board"));
      return { exitCode: 0, stdout: "Initialized Kaban board", stderr: "", spawnError: null };
    }
    const board = this.board(run.hostId, run.root);
    if (board === undefined) {
      return { exitCode: 1, stdout: "", stderr: "Error: No board found. Run 'kaban init' first\n", spawnError: null };
    }
    const ok = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify({ success: true, data }, null, 2), stderr: "", spawnError: null });
    const fail = (code: number, message: string) => ({
      exitCode: code,
      stdout: JSON.stringify({ success: false, error: { code, message } }, null, 2),
      stderr: "",
      spawnError: null,
    });
    const find = (ref: string | undefined) =>
      board.tasks.find((task) => String(task.boardTaskId) === ref || (ref !== undefined && task.id.startsWith(ref)));

    switch (command) {
      case "status":
        return ok({
          board: { name: board.name },
          columns: COLUMNS.map((column) => ({ ...column, count: board.tasks.filter((task) => task.columnId === column.id).length })),
          blockedCount: 0,
          totalTasks: board.tasks.length,
        });
      case "list": {
        const column = option("column");
        return ok(board.tasks.filter((task) => column === undefined || task.columnId === column));
      }
      case "get": {
        const task = find(positionals[0]);
        return task === undefined ? fail(2, `Task '${positionals[0]}' not found`) : ok(task);
      }
      case "add": {
        const title = positionals[0] ?? "";
        if (title.trim() === "") return fail(4, "Title cannot be empty");
        if (option("force") === undefined && board.tasks.some((task) => task.title === title)) {
          return fail(409, `Found 1 very similar task(s): "${title}" (100%). Use force=true to create anyway.`);
        }
        const column = option("column");
        const task = this.seed(run.hostId, run.root, title, typeof column === "string" ? column : "todo");
        const description = option("description");
        if (typeof description === "string") task.description = description;
        if (run.agent !== null) task.createdBy = run.agent;
        return ok(task);
      }
      case "move": {
        const task = find(positionals[0]);
        if (task === undefined) return fail(2, `Task '${positionals[0]}' not found`);
        let target: string | undefined = positionals[1];
        if (option("next") === true) target = COLUMNS[COLUMNS.findIndex((column) => column.id === task.columnId) + 1]?.id;
        if (target === undefined || !COLUMNS.some((column) => column.id === target)) return fail(4, `Column '${target}' does not exist`);
        task.columnId = target;
        const assign = option("assign");
        if (typeof assign === "string") task.assignedTo = assign;
        return ok(task);
      }
      case "assign": {
        const task = find(positionals[0]);
        if (task === undefined) return fail(2, `Task '${positionals[0]}' not found`);
        task.assignedTo = option("clear") === true ? null : (positionals[1] ?? null);
        return ok(task);
      }
      case "done": {
        const task = find(positionals[0]);
        if (task === undefined) return fail(2, `Task '${positionals[0]}' not found`);
        task.columnId = "done";
        return ok(task);
      }
      case "delete": {
        const task = find(positionals[0]);
        if (task === undefined) return fail(2, `Task '${positionals[0]}' not found`);
        board.tasks = board.tasks.filter((candidate) => candidate !== task);
        return ok({ deleted: true });
      }
      case "next": {
        const task = board.tasks.find((candidate) => candidate.columnId === "todo") ?? null;
        return ok({ task, message: task === null ? "No actionable tasks" : undefined });
      }
      default:
        return { exitCode: 1, stdout: "", stderr: `error: unknown command '${command}'`, spawnError: null };
    }
  }
}
