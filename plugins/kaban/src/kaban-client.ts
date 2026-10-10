// Typed client over the kaban CLI's `--json` contract.
//
// The CLI prints `{ success: true, data }` or `{ success: false, error: { code,
// message } }` on stdout. Commands without --json (init) and pre-board failures
// ("No board found") print plain text. This module turns every outcome into a
// normalized value or a KabanError with a stable code.
import { z } from "zod";
import type { HostRunOutput } from "./contract.js";
import type { BoardTarget, KabanBoardStatus, KabanErrorCode, KabanTask } from "./model.js";

export class KabanError extends Error {
  readonly code: KabanErrorCode;
  readonly hint: string | undefined;

  constructor(code: KabanErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "KabanError";
    this.code = code;
    this.hint = hint;
  }
}

/** Runs one CLI invocation for a board. Implemented over host RPC in server.ts. */
export type KabanRunner = (
  target: BoardTarget,
  args: string[],
  agent: string | null,
  /** Aborts a queued run before it starts and a running one on the host. */
  signal?: AbortSignal,
) => Promise<HostRunOutput>;

const nullableString = z.string().nullable().optional().catch(null);
const stringArray = z.array(z.string()).optional().catch([]);

/** Lenient: tolerate fields that older/newer kaban versions add or omit. */
const rawTaskSchema = z.object({
  id: z.string(),
  boardTaskId: z.number().int().nullable().optional().catch(null),
  title: z.string(),
  description: nullableString,
  columnId: z.string(),
  position: z.number().optional().catch(0),
  createdBy: nullableString,
  assignedTo: nullableString,
  labels: stringArray,
  dependsOn: stringArray,
  blockedReason: nullableString,
  dueDate: nullableString,
  createdAt: nullableString,
  updatedAt: nullableString,
  completedAt: nullableString,
});

const rawStatusSchema = z.object({
  board: z.object({ name: z.string() }),
  columns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      count: z.number().int().optional().catch(0),
      wipLimit: z.number().int().nullable().optional().catch(null),
      isTerminal: z.boolean().optional().catch(false),
    }),
  ),
  blockedCount: z.number().int().optional().catch(0),
  totalTasks: z.number().int().optional().catch(0),
});

const envelopeSchema = z.union([
  z.object({ success: z.literal(true), data: z.unknown() }),
  z.object({
    success: z.literal(false),
    error: z.object({ code: z.union([z.number(), z.string()]).optional(), message: z.string() }),
  }),
]);

export function normalizeTask(raw: z.infer<typeof rawTaskSchema>): KabanTask {
  return {
    id: raw.id,
    number: raw.boardTaskId ?? null,
    title: raw.title,
    description: raw.description ?? null,
    columnId: raw.columnId,
    position: raw.position ?? 0,
    createdBy: raw.createdBy ?? null,
    assignedTo: raw.assignedTo ?? null,
    labels: raw.labels ?? [],
    dependsOn: raw.dependsOn ?? [],
    blockedReason: raw.blockedReason ?? null,
    dueDate: raw.dueDate ?? null,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    completedAt: raw.completedAt ?? null,
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.replace(/^Error:\s*/u, "") ?? "";
}

/** Map a CLI `{ success: false }` error to a stable plugin code. */
function classifyCliError(code: number | string | undefined, message: string): KabanErrorCode {
  if (code === 2 || /not found/iu.test(message)) return "not_found";
  if (code === 409 || /similar task/iu.test(message)) return "conflict";
  if (code === 4) return "invalid";
  return "cli_error";
}

export function interpretRun(output: HostRunOutput): unknown {
  if (output.spawnError !== null) {
    if (/command not found|ENOENT/iu.test(output.spawnError)) {
      throw new KabanError(
        "not_installed",
        output.spawnError,
        "Install the kaban CLI on that machine (npm i -g @kaban-board/cli or brew install beshkenadze/tap/kaban), or set the plugin's `kabanCommand` setting.",
      );
    }
    throw new KabanError("host_error", output.spawnError);
  }
  const stdout = output.stdout.trim();
  if (stdout.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new KabanError("bad_output", `kaban printed invalid JSON: ${firstLine(stdout)}`);
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new KabanError("bad_output", "kaban printed JSON without a success envelope");
    }
    if (envelope.data.success) return envelope.data.data;
    const { code, message } = envelope.data.error;
    const errorCode = classifyCliError(code, message);
    if (errorCode === "conflict") {
      // kaban phrases this for MCP ("force=true"); state it for our surfaces.
      throw new KabanError(errorCode, message.replace(/\s*Use force=true to create anyway\.?\s*$/u, ""), "Re-run with --force (or choose \"Add anyway\") if it really is a different task.");
    }
    throw new KabanError(errorCode, message);
  }
  const text = `${output.stderr}\n${output.stdout}`;
  if (/No board found/iu.test(text)) {
    throw new KabanError("no_board", "No Kaban board in this project yet.", "Run `bb kaban init` (or `kaban init`) in the project.");
  }
  if (output.exitCode !== 0) {
    throw new KabanError("cli_error", firstLine(output.stderr) || firstLine(output.stdout) || `kaban exited with ${output.exitCode}`);
  }
  return stdout;
}

function parseTask(data: unknown): KabanTask {
  const parsed = rawTaskSchema.safeParse(data);
  if (!parsed.success) throw new KabanError("bad_output", "kaban returned an unexpected task shape");
  return normalizeTask(parsed.data);
}

function parseTasks(data: unknown): KabanTask[] {
  if (!Array.isArray(data)) throw new KabanError("bad_output", "kaban list did not return an array");
  return data.flatMap((item) => {
    const parsed = rawTaskSchema.safeParse(item);
    return parsed.success ? [normalizeTask(parsed.data)] : [];
  });
}

/** Accept ULIDs, ULID prefixes, board numbers, and `#12`. Rejects option-looking ids. */
export function normalizeTaskRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed === "" || trimmed.startsWith("-") || /\s/u.test(trimmed)) {
    throw new KabanError("invalid", `Invalid task id: ${JSON.stringify(ref)}`, "Use a task number (12 or #12) or a task id.");
  }
  return trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
}

/** Kaban column ids are lowercase with underscores; accept "In Progress"/"in-progress". */
export function normalizeColumnId(column: string): string {
  return column
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

function requireText(value: string, label: string): string {
  if (value.trim() === "") throw new KabanError("invalid", `${label} cannot be empty`);
  return value;
}

/**
 * Build argv so user text can never be read as a flag: options use the
 * `--name=value` form and positionals follow a `--` terminator.
 */
export function buildArgs(
  command: string,
  options: Record<string, string | true | undefined>,
  positionals: string[] = [],
): string[] {
  const args = [command, "--json"];
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    args.push(value === true ? `--${name}` : `--${name}=${value}`);
  }
  if (positionals.length > 0) args.push("--", ...positionals);
  return args;
}

export interface AddTaskInput {
  title: string;
  column?: string | undefined;
  description?: string | undefined;
  dependsOn?: string[] | undefined;
  force?: boolean | undefined;
}

export interface MoveTaskInput {
  /** Target column id, or "next" to advance one column. */
  column: string;
  assign?: string | undefined;
  force?: boolean | undefined;
}

export interface EditTaskInput {
  title?: string | undefined;
  description?: string | null | undefined;
  labels?: string[] | undefined;
}

export interface ListFilters {
  column?: string | undefined;
  assignee?: string | undefined;
  blocked?: boolean | undefined;
}

export class KabanClient {
  constructor(
    private readonly runner: KabanRunner,
    private readonly signal?: AbortSignal,
  ) {}

  /** A client whose every run is cancelled with `signal` (e.g. a disconnected CLI). */
  withSignal(signal: AbortSignal | undefined): KabanClient {
    return signal === undefined ? this : new KabanClient(this.runner, signal);
  }

  private async exec(target: BoardTarget, args: string[], agent: string | null = null): Promise<unknown> {
    return interpretRun(await this.runner(target, args, agent, this.signal));
  }

  async status(target: BoardTarget): Promise<KabanBoardStatus> {
    const data = await this.exec(target, buildArgs("status", {}));
    const parsed = rawStatusSchema.safeParse(data);
    if (!parsed.success) throw new KabanError("bad_output", "kaban status returned an unexpected shape");
    return {
      name: parsed.data.board.name,
      columns: parsed.data.columns.map((column) => ({
        id: column.id,
        name: column.name,
        count: column.count ?? 0,
        wipLimit: column.wipLimit ?? null,
        isTerminal: column.isTerminal ?? false,
      })),
      blockedCount: parsed.data.blockedCount ?? 0,
      totalTasks: parsed.data.totalTasks ?? 0,
    };
  }

  async list(target: BoardTarget, filters: ListFilters = {}): Promise<KabanTask[]> {
    const args = buildArgs("list", {
      column: filters.column === undefined ? undefined : normalizeColumnId(filters.column),
      assignee: filters.assignee,
      blocked: filters.blocked === true ? true : undefined,
    });
    return parseTasks(await this.exec(target, args));
  }

  async get(target: BoardTarget, ref: string): Promise<KabanTask> {
    return parseTask(await this.exec(target, buildArgs("get", {}, [normalizeTaskRef(ref)])));
  }

  async add(target: BoardTarget, input: AddTaskInput, agent: string | null): Promise<KabanTask> {
    const description = input.description?.trim() === "" ? undefined : input.description;
    const args = buildArgs(
      "add",
      {
        column: input.column === undefined ? undefined : normalizeColumnId(input.column),
        description,
        "depends-on":
          input.dependsOn === undefined || input.dependsOn.length === 0
            ? undefined
            : input.dependsOn.map(normalizeTaskRef).join(","),
        force: input.force === true ? true : undefined,
      },
      [requireText(input.title, "Title")],
    );
    return parseTask(await this.exec(target, args, agent));
  }

  async move(target: BoardTarget, ref: string, input: MoveTaskInput, agent: string | null): Promise<KabanTask> {
    const next = input.column === "next";
    const args = buildArgs(
      "move",
      {
        next: next ? true : undefined,
        assign: input.assign,
        force: input.force === true ? true : undefined,
      },
      next ? [normalizeTaskRef(ref)] : [normalizeTaskRef(ref), normalizeColumnId(input.column)],
    );
    return parseTask(await this.exec(target, args, agent));
  }

  async assign(target: BoardTarget, ref: string, assignee: string | null, agent: string | null): Promise<KabanTask> {
    const args =
      assignee === null
        ? buildArgs("assign", { clear: true }, [normalizeTaskRef(ref)])
        : buildArgs("assign", {}, [normalizeTaskRef(ref), requireText(assignee, "Assignee").trim()]);
    return parseTask(await this.exec(target, args, agent));
  }

  async done(target: BoardTarget, ref: string, agent: string | null): Promise<KabanTask> {
    return parseTask(await this.exec(target, buildArgs("done", {}, [normalizeTaskRef(ref)]), agent));
  }

  async edit(target: BoardTarget, ref: string, input: EditTaskInput, agent: string | null): Promise<KabanTask> {
    if (input.title === undefined && input.description === undefined && input.labels === undefined) {
      throw new KabanError("invalid", "Nothing to edit", "Pass a title, description, or labels.");
    }
    const args = buildArgs(
      "edit",
      {
        title: input.title === undefined ? undefined : requireText(input.title, "Title"),
        description: input.description ?? undefined,
        "clear-description": input.description === null ? true : undefined,
        labels: input.labels?.join(","),
      },
      [normalizeTaskRef(ref)],
    );
    return parseTask(await this.exec(target, args, agent));
  }

  async next(target: BoardTarget, column?: string): Promise<KabanTask | null> {
    const args = buildArgs("next", {
      column: column === undefined ? undefined : normalizeColumnId(column),
    });
    const data = await this.exec(target, args);
    const parsed = z.object({ task: z.unknown().nullable() }).safeParse(data);
    if (!parsed.success) throw new KabanError("bad_output", "kaban next returned an unexpected shape");
    return parsed.data.task === null ? null : parseTask(parsed.data.task);
  }

  async remove(target: BoardTarget, ref: string, agent: string | null): Promise<void> {
    await this.exec(target, buildArgs("delete", { force: true }, [normalizeTaskRef(ref)]), agent);
  }

  /** `kaban init` has no --json; success is a zero exit. */
  async init(target: BoardTarget, name: string): Promise<void> {
    await this.exec(target, ["init", `--name=${requireText(name, "Board name")}`]);
  }
}
