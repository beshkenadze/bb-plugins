// Thread ↔ task links, kept in the plugin's own SQLite database
// (`bb.storage.database()`).
//
// One row per thread (a thread works on at most one task); many threads may
// point at the same task. better-sqlite3 is synchronous and every mutation is
// a single transaction, so concurrent link/unlink requests cannot interleave
// and lose rows the way a read-modify-write over kv arrays would.
//
// The task id is kaban's stable ULID, so a link survives renames and moves.
import type Database from "better-sqlite3";
import { z } from "zod";

/** Append-only: statement index is the migration id (see bb.storage.migrate). */
export const LINK_MIGRATIONS = [
  `CREATE TABLE task_links (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    number INTEGER,
    title TEXT NOT NULL,
    linked_at INTEGER NOT NULL
  )`,
  "CREATE INDEX task_links_by_task ON task_links (project_id, task_id, linked_at)",
];

export const taskLinkSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  number: z.number().int().nullable(),
  title: z.string(),
  linkedAt: z.number(),
});
export type TaskLink = z.infer<typeof taskLinkSchema>;

interface LinkRow {
  thread_id: string;
  project_id: string;
  task_id: string;
  number: number | null;
  title: string;
  linked_at: number;
}

function fromRow(row: LinkRow): TaskLink {
  return {
    threadId: row.thread_id,
    projectId: row.project_id,
    taskId: row.task_id,
    number: row.number,
    title: row.title,
    linkedAt: row.linked_at,
  };
}

export class LinkStore {
  private readonly selectThread;
  private readonly selectTask;
  private readonly selectProject;
  private readonly upsert;
  private readonly deleteThread;

  constructor(private readonly db: Database.Database) {
    this.selectThread = db.prepare<[string], LinkRow>("SELECT * FROM task_links WHERE thread_id = ?");
    this.selectTask = db.prepare<[string, string], LinkRow>(
      "SELECT * FROM task_links WHERE project_id = ? AND task_id = ? ORDER BY linked_at, thread_id",
    );
    this.selectProject = db.prepare<[string], LinkRow>(
      "SELECT * FROM task_links WHERE project_id = ? ORDER BY linked_at, thread_id",
    );
    this.upsert = db.prepare<[string, string, string, number | null, string, number]>(
      `INSERT INTO task_links (thread_id, project_id, task_id, number, title, linked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET
         project_id = excluded.project_id,
         task_id = excluded.task_id,
         number = excluded.number,
         title = excluded.title,
         linked_at = excluded.linked_at`,
    );
    this.deleteThread = db.prepare<[string]>("DELETE FROM task_links WHERE thread_id = ?");
  }

  forThread(threadId: string): TaskLink | null {
    const row = this.selectThread.get(threadId);
    return row === undefined ? null : fromRow(row);
  }

  threadsForTask(projectId: string, taskId: string): string[] {
    return this.selectTask.all(projectId, taskId).map((row) => row.thread_id);
  }

  /** taskId → linked thread ids (oldest first) for every linked task in a project. */
  forProject(projectId: string): Map<string, string[]> {
    const byTask = new Map<string, string[]>();
    for (const row of this.selectProject.all(projectId)) {
      const threads = byTask.get(row.task_id) ?? [];
      threads.push(row.thread_id);
      byTask.set(row.task_id, threads);
    }
    return byTask;
  }

  /**
   * Link a thread to a task, atomically replacing any previous link of that
   * thread. Returns the link it replaced, if any.
   */
  link(link: TaskLink): TaskLink | null {
    const parsed = taskLinkSchema.parse(link);
    return this.db.transaction((): TaskLink | null => {
      const previous = this.forThread(parsed.threadId);
      this.upsert.run(parsed.threadId, parsed.projectId, parsed.taskId, parsed.number, parsed.title, parsed.linkedAt);
      return previous;
    })();
  }

  /** Remove a thread's link atomically; returns the removed link, if any. */
  unlink(threadId: string): TaskLink | null {
    return this.db.transaction((): TaskLink | null => {
      const existing = this.forThread(threadId);
      if (existing !== null) this.deleteThread.run(threadId);
      return existing;
    })();
  }
}
