// One task card: title, assignee, labels, linked BB threads, and actions.
import type { DragEvent } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { KabanColumn, KabanTask, LinkedThread } from "../src/model";

export const TASK_DRAG_TYPE = "application/x-kaban-task";

export interface TaskActions {
  move: (task: KabanTask, columnId: string) => void;
  done: (task: KabanTask) => void;
  edit: (task: KabanTask) => void;
  remove: (task: KabanTask) => void;
  startThread: (task: KabanTask) => void;
  /** Present only inside a thread panel. */
  linkHere?: ((task: KabanTask) => void) | undefined;
  unlinkHere?: (() => void) | undefined;
}

function taskLabel(task: KabanTask): string {
  return task.number === null ? task.id.slice(0, 8) : `#${task.number}`;
}

function ThreadChip({ thread }: { thread: LinkedThread }) {
  const navigate = useBbNavigate();
  const running = thread.status === "active" || thread.status === "starting" || thread.status === "pending";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        navigate.toThread(thread.threadId);
      }}
      className={cn(
        "flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground",
        thread.archived && "opacity-60",
      )}
      title={thread.title ?? thread.threadId}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          running ? "animate-pulse bg-emerald-500" : thread.status === "error" ? "bg-destructive" : "bg-muted-foreground/50",
        )}
      />
      <span className="truncate">{thread.title ?? thread.threadId}</span>
    </button>
  );
}

export function TaskCard({
  task,
  columns,
  threads,
  actions,
  highlighted,
  linkedHere,
}: {
  task: KabanTask;
  columns: KabanColumn[];
  threads: LinkedThread[];
  actions: TaskActions;
  highlighted: boolean;
  linkedHere: boolean;
}) {
  const column = columns.find((candidate) => candidate.id === task.columnId);
  const isDone = column?.isTerminal === true;
  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDoubleClick={() => actions.edit(task)}
      className={cn(
        "group rounded-lg border border-border bg-card p-2.5 text-sm shadow-xs",
        highlighted && "ring-2 ring-ring",
        isDone && "opacity-70",
      )}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">{taskLabel(task)}</span>
        <span className={cn("min-w-0 flex-1 break-words font-medium leading-snug", isDone && "line-through")}>
          {task.title}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100"
              aria-label={`Actions for ${taskLabel(task)}`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" mobileTitle={`${taskLabel(task)} ${task.title}`}>
            <DropdownMenuItem onSelect={() => actions.startThread(task)}>
              <Icon name="Play" className="size-4" />
              Start thread on this task
            </DropdownMenuItem>
            {actions.linkHere !== undefined && !linkedHere ? (
              <DropdownMenuItem onSelect={() => actions.linkHere?.(task)}>
                <Icon name="Link" className="size-4" />
                Link to this thread
              </DropdownMenuItem>
            ) : null}
            {linkedHere && actions.unlinkHere !== undefined ? (
              <DropdownMenuItem onSelect={() => actions.unlinkHere?.()}>
                <Icon name="Unlink" className="size-4" />
                Unlink from this thread
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Icon name="ArrowRightLeft" className="size-4" />
                Move to
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {columns
                  .filter((candidate) => candidate.id !== task.columnId)
                  .map((candidate) => (
                    <DropdownMenuItem key={candidate.id} onSelect={() => actions.move(task, candidate.id)}>
                      {candidate.name}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!isDone ? (
              <DropdownMenuItem onSelect={() => actions.done(task)}>
                <Icon name="Check" className="size-4" />
                Mark done
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => actions.edit(task)}>
              <Icon name="Pencil" className="size-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(task)}>
              <Icon name="Trash2" className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {task.description !== null && task.description.trim() !== "" ? (
        <p className="mt-1 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{task.description}</p>
      ) : null}
      {task.assignedTo !== null || task.labels.length > 0 || task.blockedReason !== null || linkedHere ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {linkedHere ? (
            <span className="rounded bg-foreground px-1.5 py-0.5 text-[11px] font-medium text-background">this thread</span>
          ) : null}
          {task.assignedTo !== null ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              <Icon name="Bot" className="size-3" />
              {task.assignedTo}
            </span>
          ) : null}
          {task.labels.map((label) => (
            <span key={label} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {label}
            </span>
          ))}
          {task.blockedReason !== null ? (
            <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive" title={task.blockedReason}>
              blocked
            </span>
          ) : null}
        </div>
      ) : null}
      {threads.length > 0 ? (
        <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-1.5">
          {threads.map((thread) => (
            <ThreadChip key={thread.threadId} thread={thread} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
