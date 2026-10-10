// The Kaban board for one scope (a project, or the thread a panel belongs to).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { BoardSnapshot, KabanColumn, KabanTask } from "../src/model";
import { TASK_DRAG_TYPE, type TaskActions, TaskCard } from "./task-card";
import { TaskDialog, type TaskDraft } from "./task-dialog";
import { errorMessage, type Scope, useBoard } from "./use-board";

type ReadySnapshot = Extract<BoardSnapshot, { state: "ready" }>;

/** The dashed box BB's own list pages use for loading and empty states. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Unavailable({
  snapshot,
  onInit,
}: {
  snapshot: Extract<BoardSnapshot, { state: "unavailable" }>;
  onInit: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <EmptyState>
      <div className="mx-auto flex max-w-md flex-col items-center gap-3">
        <Icon name={snapshot.code === "no_board" ? "LayoutGrid" : "AlertTriangle"} className="size-6" />
        <p className="text-foreground">{snapshot.message}</p>
        {snapshot.target !== null ? (
          <p className="break-all font-mono text-xs">
            {snapshot.target.root} · {snapshot.target.hostId}
          </p>
        ) : null}
        {snapshot.code === "not_installed" ? (
          <code className="rounded bg-muted px-2 py-1 text-xs text-foreground">npm i -g @kaban-board/cli</code>
        ) : null}
        {snapshot.code === "no_board" && snapshot.target !== null ? (
          <Button
            disabled={pending}
            onClick={() => {
              setPending(true);
              onInit().finally(() => setPending(false));
            }}
          >
            <Icon name="Plus" className="size-4" />
            Create board
          </Button>
        ) : null}
      </div>
    </EmptyState>
  );
}

function Column({
  column,
  tasks,
  snapshot,
  actions,
  stacked,
  highlightTaskId,
  linkedTaskId,
  onAdd,
  onDropTask,
}: {
  column: KabanColumn;
  tasks: KabanTask[];
  snapshot: ReadySnapshot;
  actions: TaskActions;
  stacked: boolean;
  highlightTaskId: string | null;
  linkedTaskId: string | null;
  onAdd: (columnId: string) => void;
  onDropTask: (taskId: string, columnId: string) => void;
}) {
  const [over, setOver] = useState(false);
  const overLimit = column.wipLimit !== null && tasks.length > column.wipLimit;
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(TASK_DRAG_TYPE);
  return (
    <section
      aria-label={column.name}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        const taskId = event.dataTransfer.getData(TASK_DRAG_TYPE);
        if (taskId !== "") onDropTask(taskId, column.id);
      }}
      className={cn(
        "flex min-h-0 flex-col rounded-xl bg-muted/50 p-2",
        stacked ? "w-full" : "w-72 shrink-0",
        over && "bg-state-hover ring-1 ring-ring",
      )}
    >
      <header className="mb-2 flex items-center gap-2 px-1">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {column.name}
        </h3>
        <span className={cn("text-xs tabular-nums text-muted-foreground", overLimit && "font-semibold text-destructive")}>
          {tasks.length}
          {column.wipLimit === null ? "" : `/${column.wipLimit}`}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          aria-label={`Add task to ${column.name}`}
          onClick={() => onAdd(column.id)}
        >
          <Icon name="Plus" className="size-3.5" />
        </Button>
      </header>
      <div className={cn("flex flex-col gap-2", !stacked && "min-h-0 overflow-y-auto")}>
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            columns={snapshot.status.columns}
            threads={snapshot.links[task.id] ?? []}
            actions={actions}
            highlighted={task.id === highlightTaskId}
            linkedHere={task.id === linkedTaskId}
          />
        ))}
        {tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-2 py-4 text-center text-xs text-muted-foreground">
            Drop tasks here
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function KabanBoard({
  scope,
  stacked = false,
  threadId = null,
}: {
  scope: Scope;
  /** Narrow surfaces (thread panel, phones) stack columns vertically. */
  stacked?: boolean;
  /** The thread this board is shown beside; enables link/unlink actions. */
  threadId?: string | null;
}) {
  const { rpc, snapshot, setSnapshot, error, loading, refetch } = useBoard(scope);
  const navigate = useBbNavigate();
  const [dialog, setDialog] = useState<{ task: KabanTask | null; column: string | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<KabanTask | null>(null);
  const [linkedTaskId, setLinkedTaskId] = useState<string | null>(null);
  const rpcScope = useMemo(() => ({ projectId: scope.projectId, threadId: scope.threadId }), [scope.projectId, scope.threadId]);

  // Which task (if any) this thread is linked to; refreshed with the board.
  useEffect(() => {
    if (threadId === null) return;
    rpc.call("thread_link_get", { threadId }).then(
      (link) => setLinkedTaskId(link.taskId),
      () => setLinkedTaskId(null),
    );
  }, [rpc, threadId, snapshot]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, success?: string): Promise<T | null> => {
      try {
        const result = await action();
        if (success !== undefined) toast.success(success);
        return result;
      } catch (cause) {
        toast.error(errorMessage(cause));
        return null;
      } finally {
        refetch();
      }
    },
    [refetch],
  );

  const moveTask = useCallback(
    (taskId: string, columnId: string) => {
      // Optimistic: show the card in its new column right away.
      setSnapshot((previous) =>
        previous?.state === "ready"
          ? { ...previous, tasks: previous.tasks.map((task) => (task.id === taskId ? { ...task, columnId } : task)) }
          : previous,
      );
      void run(() => rpc.call("task_move", { scope: rpcScope, taskId, column: columnId, force: false }));
    },
    [rpc, rpcScope, run, setSnapshot],
  );

  const actions: TaskActions = useMemo(
    () => ({
      move: (task, columnId) => moveTask(task.id, columnId),
      done: (task) => void run(() => rpc.call("task_done", { scope: rpcScope, taskId: task.id })),
      edit: (task) => setDialog({ task, column: task.columnId }),
      remove: (task) => setConfirmDelete(task),
      startThread: (task) =>
        void run(async () => {
          const result = await rpc.call("task_start_thread", { scope: rpcScope, taskId: task.id, note: null });
          if (result.warning !== null) toast.warning(result.warning);
          toast.success(`Started a thread on ${task.number === null ? "the task" : `#${task.number}`}`, {
            action: { label: "Open", onClick: () => navigate.toThread(result.threadId) },
          });
          return result;
        }),
      linkHere:
        threadId === null
          ? undefined
          : (task) =>
              void run(async () => {
                await rpc.call("thread_link", { threadId, taskId: task.id });
                setLinkedTaskId(task.id);
              }, "Linked this thread to the task"),
      unlinkHere:
        threadId === null
          ? undefined
          : () =>
              void run(async () => {
                await rpc.call("thread_unlink", { threadId });
                setLinkedTaskId(null);
              }, "Unlinked this thread"),
    }),
    [moveTask, navigate, rpc, rpcScope, run, threadId],
  );

  /** Resolves when saved (closes the dialog); rejects to keep it open. */
  const submitDraft = async (draft: TaskDraft) => {
    const task = dialog?.task ?? null;
    const description = draft.description.trim() === "" ? null : draft.description;
    try {
      if (task !== null) {
        await rpc.call("task_edit", {
          scope: rpcScope,
          taskId: task.id,
          title: draft.title === task.title ? null : draft.title,
          // null = unchanged, "" = clear
          description: draft.description === (task.description ?? "") ? null : draft.description,
        });
        return;
      }
      const add = (force: boolean) =>
        rpc.call("task_add", { scope: rpcScope, title: draft.title, description, column: draft.column, force });
      try {
        await add(false);
      } catch (cause) {
        const message = errorMessage(cause);
        if (!/similar task/iu.test(message)) throw cause;
        // Kaban's duplicate guard: let the user confirm instead of failing.
        toast.warning(message.replace(/\s*Use force=true.*$/u, ""), {
          action: { label: "Add anyway", onClick: () => void run(() => add(true), "Task added") },
        });
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
      throw cause;
    } finally {
      refetch();
    }
  };

  if (error !== null && snapshot === null) {
    return (
      <EmptyState>
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>
          Retry
        </Button>
      </EmptyState>
    );
  }
  if (snapshot === null) return <EmptyState>Loading board…</EmptyState>;
  if (snapshot.state === "unavailable") {
    return (
      <Unavailable
        snapshot={snapshot}
        onInit={async () => {
          await run(
            () => rpc.call("board_init", { scope: rpcScope, name: snapshot.target?.projectName ?? "Kaban Board" }),
            "Board created",
          );
        }}
      />
    );
  }

  const ordered = [...snapshot.tasks].sort((a, b) => a.position - b.position);
  const byColumn = new Map<string, KabanTask[]>(snapshot.status.columns.map((column) => [column.id, []]));
  for (const task of ordered) byColumn.get(task.columnId)?.push(task);
  const defaultColumn = snapshot.status.columns.find((column) => column.id === "todo")?.id ?? snapshot.status.columns[0]?.id ?? null;

  return (
    <div className={cn("flex min-h-0 flex-col gap-3", !stacked && "h-full")}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{snapshot.status.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={`${snapshot.target.root} (${snapshot.target.hostId})`}>
            {snapshot.target.root}
            {snapshot.target.via === "environment" ? " · thread workspace" : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Refresh" disabled={loading} onClick={refetch}>
          <Icon name="RefreshCw" className={cn("size-4", loading && "animate-spin")} />
        </Button>
        <Button size="sm" onClick={() => setDialog({ task: null, column: defaultColumn })}>
          <Icon name="Plus" className="size-4" />
          New task
        </Button>
      </div>
      <div className={cn("flex min-h-0 gap-3", stacked ? "flex-col" : "flex-1 overflow-x-auto pb-2")}>
        {snapshot.status.columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            tasks={byColumn.get(column.id) ?? []}
            snapshot={snapshot}
            actions={actions}
            stacked={stacked}
            highlightTaskId={linkedTaskId}
            linkedTaskId={linkedTaskId}
            onAdd={(columnId) => setDialog({ task: null, column: columnId })}
            onDropTask={(taskId, columnId) => {
              const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
              if (task !== undefined && task.columnId !== columnId) moveTask(taskId, columnId);
            }}
          />
        ))}
      </div>
      <TaskDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        columns={snapshot.status.columns}
        task={dialog?.task ?? null}
        defaultColumn={dialog?.column ?? defaultColumn}
        onSubmit={submitDraft}
      />
      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
            <DialogDescription>
              {confirmDelete === null
                ? ""
                : `${confirmDelete.number === null ? "" : `#${confirmDelete.number} `}${confirmDelete.title} will be removed from the board.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const task = confirmDelete;
                setConfirmDelete(null);
                if (task !== null) void run(() => rpc.call("task_delete", { scope: rpcScope, taskId: task.id }), "Task deleted");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
