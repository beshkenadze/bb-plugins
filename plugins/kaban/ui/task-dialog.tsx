// Add / edit task dialog.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { KabanColumn, KabanTask } from "../src/model";

export interface TaskDraft {
  title: string;
  description: string;
  column: string | null;
}

export function TaskDialog({
  open,
  onOpenChange,
  columns,
  task,
  defaultColumn,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: KabanColumn[];
  /** Edit this task; null creates a new one. */
  task: KabanTask | null;
  defaultColumn: string | null;
  onSubmit: (draft: TaskDraft) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [column, setColumn] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setColumn(task?.columnId ?? defaultColumn);
  }, [open, task, defaultColumn]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim() === "" || pending) return;
    setPending(true);
    try {
      await onSubmit({ title: title.trim(), description, column });
      onOpenChange(false);
    } catch {
      // The caller already reported the error; keep the dialog open to retry.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{task === null ? "New task" : `Edit ${task.number === null ? "task" : `#${task.number}`}`}</DialogTitle>
            <DialogDescription>
              {task === null ? "Adds a task to this project's Kaban board." : "Changes are saved to the Kaban board."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            aria-label="Title"
            maxLength={500}
          />
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Details, acceptance criteria (markdown)"
            aria-label="Description"
            rows={6}
          />
          {task === null && columns.length > 0 ? (
            <Select value={column ?? undefined} onValueChange={setColumn}>
              <SelectTrigger aria-label="Column">
                <SelectValue placeholder="Column" />
              </SelectTrigger>
              <SelectContent>
                {columns.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || title.trim() === ""}>
              {task === null ? "Add task" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
