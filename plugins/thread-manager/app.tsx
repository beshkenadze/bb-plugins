import { useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp, experimental_useProviders, experimental_useSidebarThreadActions,
  experimental_useSidebarThreads, ThreadTitle, useSdk,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread, PluginSidebarThreadActions } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { DEFAULT_FILTERS, filterThreads, isRunning, knownFilters, needsAttention, PAGE_SIZE, selectedOnPage, statusLabel, UNSECTIONED, updateMany } from "./model";
import type { Filters, Lifecycle, Preset, Sort } from "./model";
import { RestartThreadAction } from "./restart";

const LIFECYCLES: Record<Lifecycle, readonly ("active" | "archived")[]> = {
  active: ["active"], archived: ["archived"], all: ["active", "archived"],
};
const STATUS_OPTIONS: readonly [Preset, string][] = [["all", "Any status"], ["running", "Running"], ["attention", "Needs attention"], ["unread", "Unread"], ["pinned", "Pinned"], ["failed", "Failed"], ["idle", "Idle"]];
const SORT_OPTIONS: readonly [Sort, string][] = [["updated", "Recently updated"], ["created", "Recently created"], ["title", "Title A–Z"]];
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Edit = { kind: "rename"; thread: PluginSidebarThread } | { kind: "move"; ids: string[]; bulk: boolean };
type Run = (task: () => Promise<unknown>, success?: string) => Promise<boolean>;

function FilterSelect<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
    {label}
    <select aria-label={label} value={value} disabled={disabled}
      className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      onChange={(event) => { const option = options.find(([id]) => id === event.target.value); if (option) onChange(option[0]); }}>
      {options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
  </label>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function ThreadRow({ thread, project, section, provider, selected, disabled, actions, toggle, edit, run, restore }: {
  thread: PluginSidebarThread; project: string; section: string | undefined; provider: string;
  selected: boolean; disabled: boolean; actions: PluginSidebarThreadActions;
  toggle: (checked: boolean) => void; edit: (edit: Edit) => void; run: Run;
  restore: (thread: PluginSidebarThread) => Promise<unknown>;
}) {
  const title = thread.displayTitle;
  const label = statusLabel(thread);
  return <tr className={cn("border-b border-border last:border-0 hover:bg-state-hover/50", selected && "bg-state-active/50")}>
    <td className="w-10 px-3 py-3"><Checkbox aria-label={`Select ${title}`} checked={selected} disabled={disabled} onCheckedChange={(checked) => toggle(checked === true)} /></td>
    <td className="max-w-0 py-3 pr-3">
      <div className="flex items-center gap-2">
        {thread.isPinned ? <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" /> : null}
        <a href={thread.href} className={cn("min-w-0 truncate rounded-sm text-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", thread.isUnread ? "font-semibold" : "font-medium")}
          aria-label={title} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); actions.open(thread.id);
          }}><ThreadTitle threadId={thread.id} /></a>
        {thread.isUnread ? <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{project}</span>
        {thread.environment?.branchName ? <span className="max-w-48 truncate" title={thread.environment.path ?? undefined}>{thread.environment.branchName}</span> : null}
        {section ? <span>· {section}</span> : null}
        {thread.parentThreadId ? <span>· Child</span> : null}
        {thread.isHidden ? <span>· Hidden</span> : null}
        <span className="md:hidden">· {provider}</span>
      </div>
    </td>
    <td className="w-36 px-2 py-3"><span title={thread.indicatorLabel ?? label}
      className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", needsAttention(thread) ? "border-destructive/30 text-destructive" : isRunning(thread) ? "border-primary/30 text-primary" : "border-border text-muted-foreground")}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" />{label}
    </span></td>
    <td className="hidden w-36 px-2 py-3 text-xs text-muted-foreground md:table-cell"><div className="truncate">{provider}</div><div className="mt-1 truncate">{thread.host?.name ?? ""}</div></td>
    <td className="hidden w-32 px-2 py-3 text-xs text-muted-foreground lg:table-cell"><time dateTime={new Date(thread.updatedAt).toISOString()} title={new Date(thread.updatedAt).toLocaleString()}>{dateFormat.format(thread.updatedAt)}</time></td>
    <td className="w-10 px-2 py-3"><DropdownMenu><DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" className="size-8" disabled={disabled} aria-label={`Actions for ${title}`}><Icon name="MoreHorizontal" className="size-4" /></Button>
    </DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => actions.open(thread.id, { split: true })}>Open in split</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => edit({ kind: "rename", thread })}>Rename</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { void run(() => actions.setPinned(thread.id, !thread.isPinned)); }}>{thread.isPinned ? "Unpin" : "Pin"}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { void run(() => actions.setRead(thread.id, thread.isUnread)); }}>{thread.isUnread ? "Mark read" : "Mark unread"}</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => edit({ kind: "move", ids: [thread.id], bulk: false })}>Move to section</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => { void run(() => navigator.clipboard.writeText(new URL(thread.href, window.location.origin).href), "Link copied."); }}>Copy link</DropdownMenuItem>
      <DropdownMenuSeparator />
      {thread.isArchived
        ? <DropdownMenuItem onSelect={() => { void run(() => restore(thread), "Thread restored."); }}>Restore</DropdownMenuItem>
        : <DropdownMenuItem onSelect={() => actions.archive(thread.id)}>Archive…</DropdownMenuItem>}
      <DropdownMenuItem className="text-destructive" onSelect={() => actions.requestDelete(thread.id)}>Delete…</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu></td>
  </tr>;
}

function ThreadsPage() {
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS });
  const state = experimental_useSidebarThreads({ experimental_lifecycles: LIFECYCLES[filters.lifecycle] });
  const { providers } = experimental_useProviders();
  const actions = experimental_useSidebarThreadActions();
  const sdk = useSdk();
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [editValue, setEditValue] = useState("");
  const providerNames = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.displayName])), [providers]);
  const projectNames = useMemo(() => new Map(state.projects.map((project) => [project.id, project.name])), [state.projects]);
  const sectionNames = useMemo(() => new Map(state.sections.map((section) => [section.id, section.name])), [state.sections]);
  const applied = useMemo(() => knownFilters(filters, state.threads, state.sections), [filters, state.threads, state.sections]);
  const matches = useMemo(() => filterThreads(state.threads, applied, state.projects, state.sections, providerNames), [state.threads, applied, state.projects, state.sections, providerNames]);
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = selectedOnPage(rows, selectedIds);
  const allSelected = rows.length > 0 && selected.length === rows.length;
  const archived = state.experimental_archived;
  const available = state.threads.filter((thread) => filters.showHidden || !thread.isHidden);
  const providerOptions: [string, string][] = [...new Set(state.threads.map((thread) => thread.providerId))].map((id) => [id, providerNames.get(id) ?? id]);
  const hosts = new Map(state.threads.flatMap((thread) => thread.host ? [[thread.host.id, thread.host.name] as const] : []));
  const sectionOptions: [string, string][] = [[UNSECTIONED, "No section"], ...state.sections.map((section): [string, string] => [section.id, section.name])];
  const destination = sectionOptions.some(([id]) => id === editValue) ? editValue : "";

  function changeFilters(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch })); setPage(0); setSelectedIds(new Set());
  }
  function changePage(next: number) { setPage(next); setSelectedIds(new Set()); }
  function toggle(id: string, checked: boolean) {
    setSelectedIds((previous) => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  }
  async function run(task: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setError(null); setNotice(null);
    try { await task(); if (success) setNotice(success); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function bulk(update: (thread: PluginSidebarThread) => Promise<unknown>) {
    if (selected.length === 0) return;
    return run(async () => {
      const result = await updateMany(selected, update);
      setSelectedIds(new Set(result.failedIds));
      setNotice(`${result.succeeded} thread${result.succeeded === 1 ? "" : "s"} updated.`);
      if (result.failedIds.length) throw new Error(`${result.failedIds.length} failed: ${result.firstError}`);
    });
  }
  function currentSection(ids: readonly string[]): string {
    const [only, ...others] = new Set(state.threads.filter((thread) => ids.includes(thread.id)).map((thread) => thread.sectionId ?? UNSECTIONED));
    return only !== undefined && others.length === 0 ? only : "";
  }
  function openEdit(next: Edit) {
    setError(null); setEdit(next);
    setEditValue(next.kind === "rename" ? (next.thread.title ?? next.thread.displayTitle) : currentSection(next.ids));
  }
  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    if (!edit || busyRef.current) return;
    if (edit.kind === "rename") {
      const title = editValue.trim();
      if (!title) return;
      if (await run(() => actions.rename(edit.thread.id, title), "Thread renamed.")) setEdit(null);
    } else {
      if (!destination) return;
      const sectionId = destination === UNSECTIONED ? null : destination;
      if (edit.bulk) {
        if (await bulk((thread) => sdk.threads.update({ threadId: thread.id, sectionId }))) setEdit(null);
      } else {
        const id = edit.ids[0];
        if (id && await run(() => sdk.threads.update({ threadId: id, sectionId }), "Thread moved.")) setEdit(null);
      }
    }
  }

  return <div className="h-full min-h-0 overflow-auto p-4 md:p-6"><div className="mx-auto max-w-6xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Find work across projects and keep your threads organized.</p>
      <Button size="sm" onClick={() => actions.openNewThread({ ...(filters.projectId ? { projectId: filters.projectId } : {}), focusPrompt: true })}><Icon name="Plus" />New thread</Button>
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {([["running", "Running", available.filter(isRunning).length], ["attention", "Needs attention", available.filter(needsAttention).length], ["unread", "Unread", available.filter((thread) => thread.isUnread).length], ["pinned", "Pinned", available.filter((thread) => thread.isPinned).length]] satisfies [Preset, string, number][]).map(([preset, label, count]) =>
        <button key={preset} type="button" disabled={busy} aria-pressed={filters.preset === preset}
          className={cn("rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50", filters.preset === preset && "border-primary bg-state-active")}
          onClick={() => changeFilters({ preset: filters.preset === preset ? "all" : preset })}>
          <span className="block text-xs text-muted-foreground">{label}</span><span className="mt-1 block text-2xl font-semibold tabular-nums">{count}</span>
        </button>)}
    </div>
    <div className="space-y-3 rounded-lg border border-border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Thread lifecycle" className="flex gap-1 rounded-md bg-muted p-1">
          {(["active", "archived", "all"] satisfies Lifecycle[]).map((lifecycle) => <Button key={lifecycle} variant="ghost" size="sm" disabled={busy} aria-pressed={filters.lifecycle === lifecycle}
            onClick={() => changeFilters({ lifecycle })}>{lifecycle === "all" ? "All" : lifecycle === "active" ? "Active" : "Archived"}</Button>)}
        </div>
        <div className="relative min-w-48 flex-1"><Icon name="Search" className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input type="search" aria-label="Search threads" placeholder="Search titles, projects, branches…" className="pl-9" value={filters.query} disabled={busy} onChange={(event) => changeFilters({ query: event.target.value })} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <FilterSelect label="Project" value={filters.projectId} disabled={busy} options={[["", "All projects"], ...state.projects.map((project): [string, string] => [project.id, project.name])]} onChange={(projectId) => changeFilters({ projectId })} />
        <FilterSelect label="Status" value={filters.preset} disabled={busy} options={STATUS_OPTIONS} onChange={(preset) => changeFilters({ preset })} />
        <FilterSelect label="Provider" value={applied.providerId} disabled={busy} options={[["", "All providers"], ...providerOptions]} onChange={(providerId) => changeFilters({ providerId })} />
        <FilterSelect label="Machine" value={applied.hostId} disabled={busy} options={[["", "All machines"], ...hosts]} onChange={(hostId) => changeFilters({ hostId })} />
        <FilterSelect label="Section" value={applied.sectionId} disabled={busy} options={[["", "All sections"], ...sectionOptions]} onChange={(sectionId) => changeFilters({ sectionId })} />
        <FilterSelect label="Sort" value={filters.sort} disabled={busy} options={SORT_OPTIONS} onChange={(sort) => changeFilters({ sort })} />
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <label className="flex items-center gap-2"><Checkbox checked={filters.rootsOnly} disabled={busy} onCheckedChange={(checked) => changeFilters({ rootsOnly: checked === true })} />Root threads only</label>
        <label className="flex items-center gap-2"><Checkbox checked={filters.showHidden} disabled={busy} onCheckedChange={(checked) => changeFilters({ showHidden: checked === true })} />Include hidden threads</label>
        <Button className="ml-auto" variant="ghost" size="sm" disabled={busy} onClick={() => changeFilters({ ...DEFAULT_FILTERS })}>Reset filters</Button>
      </div>
    </div>
    {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
    {selected.length > 0 ? <div role="toolbar" aria-label="Selected thread actions" className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-state-active p-3">
      <span className="mr-auto text-sm font-medium">{selected.length} selected on this page</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void bulk((thread) => actions.setPinned(thread.id, true)); }}>Pin</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void bulk((thread) => actions.setPinned(thread.id, false)); }}>Unpin</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void bulk((thread) => actions.setRead(thread.id, true)); }}>Mark read</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void bulk((thread) => actions.setRead(thread.id, false)); }}>Mark unread</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => openEdit({ kind: "move", ids: selected.map((thread) => thread.id), bulk: true })}>Move to section</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelectedIds(new Set())}>Clear selection</Button>
    </div> : null}
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span role="status">{matches.length} matching · {available.length} loaded{busy ? " · Updating…" : ""}</span>
      {filters.lifecycle !== "active" && archived?.hasNextPage ? <span>Search and counts cover loaded archived threads.</span> : null}
    </div>
    {state.status === "error" ? <p role="alert" className="text-sm text-destructive">Could not load threads. Check your connection and reopen this page.</p>
      : state.status === "loading" || (filters.lifecycle === "archived" && archived?.status === "loading") ? <EmptyState>Loading threads…</EmptyState>
      : rows.length === 0 ? <EmptyState>No threads match these filters.</EmptyState>
      : <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full table-fixed text-left">
        <caption className="sr-only">Threads matching the current filters</caption>
        <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground"><tr>
          <th className="w-10 px-3 py-2"><Checkbox aria-label="Select this page" checked={allSelected ? true : selected.length > 0 ? "indeterminate" : false} disabled={busy}
            onCheckedChange={(checked) => setSelectedIds(checked === true ? new Set(rows.map((thread) => thread.id)) : new Set())} /></th>
          <th scope="col" className="py-2 pr-3 font-normal">Thread</th><th scope="col" className="w-36 px-2 py-2 font-normal">Status</th>
          <th scope="col" className="hidden w-36 px-2 py-2 font-normal md:table-cell">Provider / machine</th><th scope="col" className="hidden w-32 px-2 py-2 font-normal lg:table-cell">Updated</th><th className="w-10"><span className="sr-only">Actions</span></th>
        </tr></thead><tbody>{rows.map((thread) => <ThreadRow key={thread.id} thread={thread} project={projectNames.get(thread.projectId) ?? thread.projectId}
          section={thread.sectionId ? sectionNames.get(thread.sectionId) : undefined} provider={providerNames.get(thread.providerId) ?? thread.providerId}
          selected={selectedIds.has(thread.id)} disabled={busy} actions={actions} toggle={(checked) => toggle(thread.id, checked)} edit={openEdit} run={run}
          restore={(target) => sdk.threads.unarchive({ threadId: target.id })} />)}</tbody>
      </table></div>}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={busy || currentPage === 0} onClick={() => changePage(currentPage - 1)}>Previous</Button>
        <span className="text-xs text-muted-foreground">Page {currentPage + 1} of {pageCount}</span>
        <Button variant="outline" size="sm" disabled={busy || currentPage + 1 >= pageCount} onClick={() => changePage(currentPage + 1)}>Next</Button>
      </div>
      {filters.lifecycle !== "active" && archived ? <div className="flex flex-wrap items-center gap-2">
        {archived.status === "error" || archived.isFetchNextPageError ? <span role="alert" className="text-xs text-destructive">Could not load archived threads.</span> : null}
        {archived.hasNextPage || archived.status === "error" || archived.isFetchNextPageError ? <Button variant="outline" size="sm" disabled={busy || archived.isFetchingNextPage}
          onClick={() => { void run(() => archived.fetchNextPage()); }}>{archived.isFetchingNextPage ? "Loading…" : archived.status === "error" || archived.isFetchNextPageError ? "Retry archived threads" : "Load more archived threads"}</Button> : null}
      </div> : null}
    </div>
    <Dialog open={edit !== null} onOpenChange={(open) => { if (!open && !busyRef.current) setEdit(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{edit?.kind === "rename" ? "Rename thread" : "Move to section"}</DialogTitle>
        <DialogDescription>{edit?.kind === "rename" ? "Give this thread a title you can find later." : edit?.bulk ? `Move ${selected.length} selected threads on this page.` : "Choose where this thread appears in the sidebar."}</DialogDescription>
      </DialogHeader><form onSubmit={(event) => { void saveEdit(event); }} className="space-y-4">
        {edit?.kind === "rename" ? <Input autoFocus aria-label="Thread title" value={editValue} disabled={busy} maxLength={500} onChange={(event) => setEditValue(event.target.value)} />
          : <FilterSelect label="Destination section" value={destination} options={destination ? sectionOptions : [["", "Choose a section…"], ...sectionOptions]} disabled={busy} onChange={setEditValue} />}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setEdit(null)}>Cancel</Button>
          <Button type="submit" disabled={busy || (edit?.kind === "rename" && !editValue.trim()) || (edit?.kind === "move" && (!destination || (edit.bulk && selected.length === 0)))}>{busy ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </form></DialogContent>
    </Dialog>
  </div></div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "threads", title: "Threads", icon: "ListFilter", path: "threads", component: ThreadsPage });
  app.slots.experimental_threadHeaderAction({ id: "restart", title: "Restart agent", component: RestartThreadAction });
});
