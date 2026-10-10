import {
  definePluginApp,
  Markdown,
  type PluginThreadHeaderActionProps,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { Icon } from "./components/ui/icon";
import type { ModelSelection, RecapResult, RecapState, SavedRecap, rpcContract } from "./contract";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Status reads register visits; they never request a model. Each mounted surface owns
// its timer and response generation, so thread changes and StrictMode cannot revive it.
function useRecapStatus(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<{ threadId: string; state: RecapState } | null>(null);
  const latest = useRef<typeof snapshot>(null);
  const local = useRef<SavedRecap | null>(null);
  const read = useRef<Promise<RecapState | null> | null>(null);
  const revision = useRef(0);
  const remember = useCallback((cached: SavedRecap) => {
    ++revision.current;
    local.current = cached;
    if (latest.current?.threadId === threadId) {
      const previous = latest.current.state;
      const stale = previous.sourceMaxSeq != null && previous.sourceMaxSeq > cached.coverage.sourceMaxSeq;
      const next = { threadId, state: { ...previous, cached, stale } };
      latest.current = next;
      setSnapshot(next);
    }
  }, [threadId]);
  const readSaved = useCallback(() => read.current ?? Promise.resolve(
    latest.current?.threadId === threadId ? latest.current.state : null,
  ), [threadId]);
  useEffect(() => {
    let live = true;
    let pending: Promise<RecapState | null> | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    function refresh(): Promise<RecapState | null> {
      if (pending) return pending;
      if (!live || document.visibilityState === "hidden") return Promise.resolve(null);
      const startedAtRevision = revision.current;
      const promise = rpc.call("getRecap", { threadId, short: true }).then((state) => {
        if (!live) return null;
        const remembered = local.current;
        if (remembered) {
          const cached = state.cached;
          const confirmed = cached && recapVersion(cached) === recapVersion(remembered);
          const newer = cached && (cached.coverage.sourceMaxSeq > remembered.coverage.sourceMaxSeq ||
            (cached.coverage.sourceMaxSeq === remembered.coverage.sourceMaxSeq &&
              cached.generatedAt !== undefined && remembered.generatedAt !== undefined &&
              cached.generatedAt > remembered.generatedAt));
          if (startedAtRevision === revision.current && (!cached || confirmed || newer)) local.current = null;
          else state = {
            ...state,
            cached: remembered,
            stale: state.sourceMaxSeq != null ? state.sourceMaxSeq > remembered.coverage.sourceMaxSeq :
              Boolean(state.stale && cached && cached.coverage.sourceMaxSeq >= remembered.coverage.sourceMaxSeq),
          };
        }
        // Reads begun before regeneration cannot overwrite its immediate local result.
        if (startedAtRevision === revision.current) {
          const next = { threadId, state };
          latest.current = next;
          setSnapshot(next);
        }
        return state;
      }).catch(() => latest.current?.threadId === threadId ? latest.current.state : null).finally(() => {
        if (pending === promise) pending = null;
        if (read.current === promise) read.current = null;
      });
      pending = promise;
      read.current = promise;
      return promise;
    }
    function visibility() {
      clearInterval(timer);
      if (document.visibilityState !== "hidden") {
        void refresh();
        timer = setInterval(() => void refresh(), 20_000);
      }
    }
    const focus = () => void refresh();
    visibility();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      live = false;
      if (read.current === pending) read.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [rpc, threadId]);
  return { status: snapshot?.threadId === threadId ? snapshot.state : null, remember, readSaved };
}

function overview(recap: SavedRecap): string {
  // Legacy results have no preview. Keep their fallback plain text and bounded.
  return (recap.preview ?? recap.text.slice(0, 2_000)
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[#*_`~>]/g, ""))
    .replace(/\s+/g, " ").trim().slice(0, 400);
}

// Frontend-only dismissal memory; no draft or browser storage writes.
const dismissedVersions = new Map<string, string>();
function recapVersion(recap: SavedRecap): string {
  return JSON.stringify([recap.generatedAt, recap.coverage.sourceMaxSeq, recap.text]);
}
function rememberDismissal(threadId: string, version: string) {
  dismissedVersions.delete(threadId);
  dismissedVersions.set(threadId, version);
  if (dismissedVersions.size > 100) {
    const oldest = dismissedVersions.keys().next().value;
    if (oldest !== undefined) dismissedVersions.delete(oldest);
  }
}

type RecapActionProps = { threadId: string; isCompactViewport?: boolean; banner?: boolean; isRunning?: boolean };

function RecapAction({ threadId, isCompactViewport, banner = false, isRunning = false }: RecapActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const { status, remember, readSaved } = useRecapStatus(threadId);
  const [dismissed, setDismissed] = useState(() => dismissedVersions.get(threadId));
  const version = status?.cached ? recapVersion(status.cached) : null;
  const timestamp = status?.cached?.generatedAt;
  const date = timestamp === undefined ? null : new Date(timestamp);
  const updated = date && Number.isFinite(date.getTime()) ? date : null;
  const shortModeId = useId();
  const [open, setOpen] = useState(false);
  const request = useRef<string | null>(null);
  const [result, setResult] = useState<RecapResult | null>(null);
  const resultShort = useRef(true);
  const [loading, setLoading] = useState(false);
  const [checkingSaved, setCheckingSaved] = useState(false);
  const opening = useRef(0);
  const [short, setShort] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultStale = result?.ok && ((status?.sourceMaxSeq != null && status.sourceMaxSeq > result.coverage.sourceMaxSeq) ||
    (status?.stale && status.cached && recapVersion(result) === version));

  const cancel = useCallback(() => {
    ++opening.current; // Also invalidate a dialog waiting for its initial cache read.
    const requestId = request.current;
    request.current = null; // Invalidate before the server can complete the request.
    if (requestId !== null) {
      void rpc.call("cancel", { requestId, threadId }).catch(() => {});
    }
  }, [rpc, threadId]);

  const run = useCallback(async (short: boolean, force = false) => {
    if (request.current !== null) return;
    const requestId = crypto.randomUUID();
    request.current = requestId;
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const next = await rpc.call("recap", { requestId, threadId, short, force });
      if (request.current !== requestId) return;
      if (next.ok) {
        resultShort.current = short;
        setResult(next);
        if (short) remember(next);
      }
      else setError(next.message);
    } catch (cause) {
      if (request.current === requestId) setError(errorMessage(cause));
    } finally {
      if (request.current === requestId) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [rpc, threadId, remember]);

  // Generation starts in the click handler, never in a replayable mount effect.
  useEffect(() => cancel, [cancel]);

  async function copy(): Promise<void> {
    if (!result?.ok) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
    } catch (cause) {
      setError(`Could not copy: ${errorMessage(cause)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        setShort(true);
        setError(null);
        setCopied(false);
        const saved = status?.cached ?? (resultShort.current && result?.ok ? result : null);
        if (saved) { resultShort.current = true; setResult(saved); setCheckingSaved(false); }
        else if (!banner) {
          setResult(null); // Do not present a previous detailed result as the default orientation.
          const id = ++opening.current;
          setLoading(true);
          setCheckingSaved(true);
          void readSaved().then((state) => {
            if (opening.current !== id) return;
            setCheckingSaved(false);
            setLoading(false);
            if (state?.cached) { resultShort.current = true; setResult(state.cached); }
            else void run(true);
          });
        }
      }
      else { cancel(); setCheckingSaved(false); setLoading(false); }
    }}>
      {banner ? (
        !isRunning && status?.cached && version !== dismissed ? (
          <section aria-label="Thread recap" className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 break-words [overflow-wrap:anywhere]">{overview(status.cached)}</p>
              <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1"><Icon name="History" className="size-3" />Recap</span>
                {status.stale ? <span>Outdated recap</span> : null}
                {!status.stale && status.sourceMaxSeq === null ? <span title="Could not verify whether the source has changed.">Unverified</span> : null}
                {updated ? <span>Updated <time dateTime={updated.toISOString()}>{updated.toLocaleString()}</time></span> : null}
              </p>
            </div>
            <DialogTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2">Details</Button></DialogTrigger>
            <Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0" aria-label="Dismiss recap" onClick={() => {
              if (version === null) return;
              rememberDismissal(threadId, version);
              setDismissed(version);
            }}><Icon name="X" className="size-4" /></Button>
          </section>
        ) : null
      ) : (
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={isCompactViewport ? "h-7 w-7 p-0" : "h-7 px-2"} aria-label="Recap">
            <Icon name="History" className="size-4" />
            {isCompactViewport ? null : "Recap"}
          </Button>
        </DialogTrigger>
      )}
      {open ? (
        <DialogContent hideCloseButton className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Thread recap</DialogTitle>
            <DialogDescription>A two-sentence orientation by default. Your thread and draft stay unchanged.</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-3 text-sm">
            <label htmlFor={shortModeId} className="flex items-center gap-2">
              <Checkbox id={shortModeId} checked={!short} disabled={loading} onCheckedChange={(checked) => setShort(checked !== true)} aria-label="Detailed recap" />
              Detailed recap
            </label>
            {loading ? <p role="status">{checkingSaved ? "Loading saved recap…" : "Generating recap…"}</p> : null}
            {error !== null ? <p role="alert" className="text-destructive">{error}</p> : null}
            {resultStale ? <p className="text-muted-foreground">Outdated recap — the thread has changed since this summary.</p> : null}
            {result?.ok && !resultStale && status?.sourceMaxSeq === null ? <p className="text-muted-foreground">Unable to verify current thread state.</p> : null}
            {result?.ok ? (
              <>
                {result.coverage.omittedEntries > 0 || result.coverage.shortenedEntries > 0 || result.coverage.hasOlder ? (
                  <p role="note" className="rounded-md border border-border bg-muted p-3 text-muted-foreground">
                    Partial coverage: {result.coverage.includedEntries} of {result.coverage.totalEntries} available entries included;
                    {" "}{result.coverage.omittedEntries} omitted, {result.coverage.shortenedEntries} shortened.
                    {result.coverage.hasOlder ? " Older history was not included." : null}
                  </p>
                ) : null}
                <div className="max-h-[60vh] overflow-y-auto">
                  <Markdown content={result.text} />
                </div>
              </>
            ) : null}
            {copied ? <p role="status">Copied.</p> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={!result?.ok || loading} onClick={() => void copy()}>
                Copy
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={loading} onClick={() => void run(short, true)}>
                Regenerate
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { cancel(); setLoading(false); setOpen(false); }}>
                {loading ? "Cancel" : "Close"}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function RecapBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return <RecapAction key={composer.scope.threadId} threadId={composer.scope.threadId} banner isRunning={composer.isRunning} />;
}

function RecapHeaderAction(props: PluginThreadHeaderActionProps) {
  // Switching headers closes the old dialog; the new thread requires another manual click.
  return <RecapAction key={props.threadId} {...props} />;
}

type ModelState = { selection: ModelSelection | null; saved: boolean };

function ModelSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [model, setModel] = useState<ModelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const id = ++operation.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await rpc.call("getModel", null);
      if (operation.current !== id) return;
      setModel(loaded);
      setDirty(false);
    } catch (cause) {
      if (operation.current === id) setError(errorMessage(cause));
    } finally {
      if (operation.current === id) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    return () => { ++operation.current; busy.current = false; };
  }, [load]);

  async function save(): Promise<void> {
    if (busy.current || !model?.selection) return;
    busy.current = true;
    const id = ++operation.current;
    setSaving(true);
    setError(null);
    try {
      const selection = await rpc.call("setModel", model.selection);
      if (operation.current !== id) return;
      setModel({ selection, saved: true });
      setDirty(false);
    } catch (cause) {
      if (operation.current === id) setError(errorMessage(cause));
    } finally {
      if (operation.current === id) {
        busy.current = false;
        setSaving(false);
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      {loading ? <p role="status" className="text-muted-foreground">Loading model…</p> : null}
      {error !== null ? <p role="alert" className="text-destructive">{error}</p> : null}
      {!loading && model?.selection ? (
        <>
          {/* Omit routing: primary host matches the backend's personal workspace. */}
          <ProviderModelPicker
            value={model.selection}
            disabled={saving}
            onChange={(selection) => {
              if (busy.current) return;
              setModel({ selection, saved: model.saved });
              setDirty(true);
              setError(null);
            }}
          />
          {!model.saved ? <p className="text-muted-foreground">Recap stays off until you save a model.</p> : null}
          {model.saved && !dirty && !error && !saving ? <p role="status">Model saved.</p> : null}
          <Button type="button" size="sm" disabled={saving || (model.saved && !dirty)} onClick={() => void save()}>
            {saving ? "Saving…" : model.saved ? "Save" : "Use this model"}
          </Button>
        </>
      ) : !loading ? (
        <>
          {model !== null ? <p className="text-muted-foreground">No provider is available. Set up a provider in BB first.</p> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
        </>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "recap", title: "Recap", component: RecapHeaderAction });
  app.composer.customize({ id: "recap", scopes: ["thread"], banners: [{ id: "summary", chrome: "bare", component: RecapBanner }] });
  app.slots.settingsSection({
    id: "model",
    title: "Recap model",
    description: "The model that summarizes your thread. It is independent of the thread's model.",
    component: ModelSettings,
  });
});
