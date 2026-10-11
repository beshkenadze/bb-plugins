import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_useProviders,
  useComposer,
  useSdk,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  cachePhase,
  deriveCache,
  findRewrites,
  formatCountdown,
  formatTokens,
  formatUsd,
  hitRate,
  modelPrice,
  promptCost,
  usageScope,
  type CacheEventRow,
  type CachePhase,
  type CacheRewrite,
  type CacheSnapshot,
  type ModelPrice,
  type RateLimitsInfo,
  type Ttl,
} from "./cache-model";
import { readSettings, ttlSettingFor, type CacheSettings } from "./settings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Sdk = ReturnType<typeof useSdk>;
type EventRow = Awaited<ReturnType<Sdk["threads"]["events"]["list"]>>[number];

const RESET_TYPES = ["thread/compacted", "thread/context/cleared"] as const;
const USAGE_TYPES = ["thread/tokenUsage/updated", ...RESET_TYPES] as const;
const CONTEXT_TYPES = ["thread/contextWindowUsage/updated", ...RESET_TYPES] as const;
const CACHE_EVENT_TYPES = [...USAGE_TYPES, CONTEXT_TYPES[0]] as const;
const RATE_LIMITS_TYPE = "provider/rateLimits/updated";
const REQUESTED_TYPE = "client/turn/requested";
const WATCHED_TYPES = new Set<string>([...CACHE_EVENT_TYPES, RATE_LIMITS_TYPE, REQUESTED_TYPE]);
/** Below this context size an expiring cache is not worth a banner. */
const MIN_BANNER_TOKENS = 20_000;
/** How many recent usage reports the rewrite count covers. */
const REWRITE_WINDOW = 20;

interface ThreadCacheData {
  providerId: string;
  /** The model of the latest turn request, for prices. */
  model: string | null;
  events: CacheEventRow[];
  rateLimits: RateLimitsInfo | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCacheEvent(row: EventRow): row is Extract<EventRow, { type: (typeof CACHE_EVENT_TYPES)[number] }> {
  return (CACHE_EVENT_TYPES as readonly string[]).includes(row.type);
}

/** Usage report seq → the first sized context report after it. Once found, or once a later report exists, it never changes. */
type ContextsAfter = Map<number, EventRow | null>;

/** The context after each Claude Code turn, which tells what a turn added from what it wrote again. */
async function loadContextsAfter(sdk: Sdk, threadId: string, usage: EventRow[], known: ContextsAfter): Promise<EventRow[]> {
  const reports = usage.filter((row) => row.type === USAGE_TYPES[0]);
  const found = await Promise.all(
    reports.map(async (report, index) => {
      const cached = known.get(report.seq);
      if (cached !== undefined) return cached;
      const rows = await sdk.threads.events.list({
        threadId,
        types: [CONTEXT_TYPES[0]],
        afterSeq: String(report.seq),
        order: "asc",
        limit: "3",
      });
      const next =
        rows.find((row) => row.type === CONTEXT_TYPES[0] && Boolean(row.data.contextWindowUsage.usedTokens)) ?? null;
      // The newest report may still get its context; an older one already has whatever it will get.
      if (next !== null || index > 0) known.set(report.seq, next);
      return next;
    }),
  );
  return found.filter((row) => row !== null);
}

async function loadThreadCache(sdk: Sdk, threadId: string, contextsAfter: ContextsAfter): Promise<ThreadCacheData> {
  // Separate queries, so a long turn's many context reports cannot push its latest usage out of a page.
  const latest = (types: readonly [EventRow["type"], ...EventRow["type"][]]) =>
    sdk.threads.events.list({ threadId, types, order: "desc", limit: "1" });
  const [thread, usage, context, limits, requested] = await Promise.all([
    sdk.threads.get({ threadId }),
    // One more than the window: the oldest report is only the baseline of the next.
    sdk.threads.events.list({ threadId, types: USAGE_TYPES, order: "desc", limit: String(REWRITE_WINDOW + 1) }),
    latest(CONTEXT_TYPES),
    latest([RATE_LIMITS_TYPE]),
    latest([REQUESTED_TYPE]),
  ]);
  const after =
    usageScope(thread.providerId) === "turn" ? await loadContextsAfter(sdk, threadId, usage, contextsAfter) : [];
  const bySeq = new Map([...usage, ...context, ...after].filter(isCacheEvent).map((row) => [row.seq, row]));
  const rateLimits = limits[0];
  const request = requested[0];
  return {
    providerId: thread.providerId,
    model: request?.type === REQUESTED_TYPE ? request.data.execution.model : null,
    // Newest first, as deriveCache and findRewrites read them.
    events: [...bySeq.values()].sort((a, b) => b.seq - a.seq),
    rateLimits: rateLimits?.type === RATE_LIMITS_TYPE ? rateLimits.data.rateLimits : null,
  };
}

/** A change that can move the cache: new usage, rate limits, or a rewritten history. */
function touchesCache(event: { changes: readonly string[]; metadata?: { eventTypes?: readonly string[] } }): boolean {
  if (event.changes.includes("history-compacted") || event.changes.includes("history-rewritten")) return true;
  if (!event.changes.includes("events-appended")) return false;
  const types = event.metadata?.eventTypes;
  return types === undefined || types.some((type) => WATCHED_TYPES.has(type));
}

/** The thread's cache events, reloaded on change: one load in flight, at most one queued behind it. */
function useThreadCache(threadId: string): ThreadCacheData | null {
  const sdk = useSdk();
  const [loaded, setLoaded] = useState<{ threadId: string; data: ThreadCacheData } | null>(null);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    let queued = false;
    const contextsAfter: ContextsAfter = new Map();
    async function reload(): Promise<void> {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      do {
        queued = false;
        try {
          const data = await loadThreadCache(sdk, threadId, contextsAfter);
          if (!disposed) setLoaded({ threadId, data });
        } catch (error) {
          // A failed load keeps the last data; a reload queued meanwhile still runs.
          console.warn(`prompt-cache: loading thread ${threadId} failed: ${errorMessage(error)}`);
        }
      } while (queued && !disposed);
      loading = false;
    }
    void reload();
    const unsubscribeThread = sdk.subscribe({
      event: "thread:changed",
      threadId,
      callback: (event) => {
        // A rewritten history may drop the events the cache pointed at.
        if (event.changes.includes("history-rewritten")) contextsAfter.clear();
        if (touchesCache(event)) void reload();
      },
    });
    const unsubscribeConnection = sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.reconnected) void reload();
      },
    });
    return () => {
      disposed = true;
      unsubscribeThread();
      unsubscribeConnection();
    };
  }, [sdk, threadId]);
  return loaded?.threadId === threadId ? loaded.data : null;
}

/** The current time, ticking every second until `until`. */
function useNow(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (Date.now() >= until) return;
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= until) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

interface CacheView {
  snapshot: CacheSnapshot;
  settings: CacheSettings;
  phase: CachePhase;
  remainingMs: number;
  price: ModelPrice | null;
  /** Rewrites among the recent reports, newest first, and the latest report's own. */
  rewrites: CacheRewrite[];
  latestRewrite: CacheRewrite | null;
}

function useCacheView(threadId: string): CacheView | null {
  const data = useThreadCache(threadId);
  const settings = readSettings(useSettings().values);
  const snapshot = data && deriveCache({ ...data, ttlSetting: ttlSettingFor(settings, data.providerId) });
  const now = useNow(snapshot === null ? 0 : snapshot.lastActivityAt + snapshot.ttl.ms);
  if (data === null || snapshot === null) return null;
  const { rewrites, latest } = findRewrites(data.providerId, data.events);
  return {
    snapshot,
    settings,
    price: modelPrice(data.model),
    rewrites,
    latestRewrite: latest,
    ...cachePhase(snapshot, now, settings.warnMs),
  };
}

/** What sending `tokens` of a `promptTokens` prompt costs at API prices with and without the cache, or null for a model without a known price. */
function costOf(view: CacheView, tokens: number, promptTokens = tokens): { rewrite: number; warm: number } | null {
  return view.price && promptCost(view.price, tokens, view.snapshot.ttl.ms, promptTokens);
}

function rewritesText(view: CacheView): string {
  const unit = usageScope(view.snapshot.providerId);
  const window = `in the last ${REWRITE_WINDOW} ${unit}s`;
  const count = view.rewrites.length;
  if (count === 0) return `No cache rewrites ${window}.`;
  const tokens = view.rewrites.reduce((sum, rewrite) => sum + rewrite.tokens, 0);
  const usd = view.rewrites.reduce((sum, rewrite) => sum + (costOf(view, rewrite.tokens, rewrite.context)?.rewrite ?? 0), 0);
  const cost = view.price === null ? "" : `, ≈ ${formatUsd(usd)}`;
  return `${count} cache rewrite${count === 1 ? "" : "s"} ${window}: ${formatTokens(tokens)} tokens${cost}.`;
}

const PHASE_COLOR: Record<CachePhase, string> = {
  warm: "bg-emerald-500",
  cooling: "bg-amber-500",
  expiring: "bg-red-500",
  expired: "bg-destructive",
};

/** Tints whatever shows an expired cache. */
const EXPIRED_TINT = "bg-destructive/10 text-destructive";

const TTL_SOURCE_TEXT: Record<Ttl["source"], string> = {
  setting: "Set in the plugin settings.",
  subscription: "Claude subscription within its plan.",
  default: "Default lifetime. Pin yours in the plugin settings if it differs.",
};

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function countdownText(view: CacheView): string {
  return view.phase === "expired" ? "expired" : formatCountdown(view.remainingMs);
}

function Meter(props: { total: number; segments: Array<{ value: number; className: string }> }) {
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
      {props.segments.map((segment, index) => (
        <div
          key={index}
          className={segment.className}
          style={{ width: `${props.total > 0 ? (segment.value / props.total) * 100 : 0}%` }}
        />
      ))}
    </div>
  );
}

function CompactButton(props: { threadId: string; variant?: "default" | "outline" }) {
  const sdk = useSdk();
  const [busy, setBusy] = useState(false);
  function compact(): void {
    setBusy(true);
    sdk.threads
      .compact({ threadId: props.threadId })
      .then(
        () => toast.success("Compaction requested."),
        (error: unknown) => toast.error(`Could not compact: ${errorMessage(error)}`),
      )
      .finally(() => setBusy(false));
  }
  return (
    <Button type="button" size="sm" variant={props.variant ?? "default"} disabled={busy} onClick={compact}>
      Compact
    </Button>
  );
}

function CacheDetails(props: { threadId: string; view: CacheView }) {
  const { snapshot, phase, remainingMs, latestRewrite } = props.view;
  const { usage, ttl, providerId } = snapshot;
  const providers = experimental_useProviders().providers;
  const providerName = providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;
  const unit = usageScope(providerId);
  const scope = unit === "turn" ? "Last turn" : "Last request";
  const cost = costOf(props.view, snapshot.contextTokens);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">Prompt cache</span>
        <span className="truncate text-xs text-muted-foreground">{providerName}</span>
      </div>
      <section className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-3">
          {phase === "expired" ? (
            <span className="font-medium text-destructive">Expired</span>
          ) : (
            <span className="tabular-nums">{`Expires in ${formatCountdown(remainingMs)}`}</span>
          )}
          <span className="text-muted-foreground">TTL {ttl.ms >= 3_600_000 ? "1 h" : `${ttl.ms / 60_000} min`}</span>
        </div>
        <Meter total={ttl.ms} segments={[{ value: remainingMs, className: PHASE_COLOR[phase] }]} />
        <p className="text-xs text-muted-foreground">{TTL_SOURCE_TEXT[ttl.source]}</p>
        {cost !== null && phase !== "expired" ? (
          <p className="text-xs text-muted-foreground">
            {`If it expires, the next message costs ≈ ${formatUsd(cost.rewrite)} instead of ≈ ${formatUsd(cost.warm)} (API prices).`}
          </p>
        ) : null}
      </section>
      <section className="flex flex-col gap-1.5">
        <div className="flex justify-between gap-3">
          <span>{`${scope} · ${formatTokens(usage.prompt)} prompt`}</span>
          <span className="text-muted-foreground">{`${percent(hitRate(usage))} cached`}</span>
        </div>
        <Meter
          total={usage.prompt}
          segments={[
            { value: usage.read, className: "bg-emerald-500" },
            { value: usage.write, className: "bg-amber-500" },
            { value: usage.fresh, className: "bg-sky-500" },
          ]}
        />
        <div className="flex gap-3 text-xs text-muted-foreground tabular-nums">
          <span>{`read ${formatTokens(usage.read)}`}</span>
          <span>{`written ${formatTokens(usage.write)}`}</span>
          <span>{`new ${formatTokens(usage.fresh)}`}</span>
        </div>
        {providerId === "codex" ? (
          <p className="text-xs text-muted-foreground">OpenAI does not report cache writes.</p>
        ) : null}
        {latestRewrite !== null ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {`This ${unit} sent ${formatTokens(latestRewrite.tokens)} tokens of earlier context again.`}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">{rewritesText(props.view)}</p>
      </section>
      {phase === "expired" ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {`The next message sends ${formatTokens(snapshot.contextTokens)} tokens without the cache${cost === null ? "" : `, ≈ ${formatUsd(cost.rewrite)} at API prices`}.`}
          </span>
          <CompactButton threadId={props.threadId} />
        </div>
      ) : null}
    </div>
  );
}

function CacheBadge({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const view = useCacheView(threadId);
  if (view === null) return null;
  const rate = percent(hitRate(view.snapshot.usage));
  const countdown = countdownText(view);
  const status = view.phase === "expired" ? "expired" : `expires in ${countdown}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 tabular-nums text-muted-foreground",
            view.phase === "expired" && `${EXPIRED_TINT} hover:bg-destructive/20 hover:text-destructive`,
          )}
          aria-label={`Prompt cache: ${rate} from cache, ${status}`}
        >
          <span className={cn("size-2 shrink-0 rounded-full", PHASE_COLOR[view.phase])} />
          {isCompactViewport ? countdown : `${rate} · ${countdown}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" mobileTitle="Prompt cache">
        <CacheDetails threadId={threadId} view={view} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Thread → the cache activity whose banner the user dismissed; a newer activity shows the banner again.
 * Shared, so dismissing one banner hides the thread's banners in every composer.
 */
const dismissedAt = new Map<string, number>();
const dismissListeners = new Set<() => void>();

function subscribeDismissed(listener: () => void): () => void {
  dismissListeners.add(listener);
  return () => {
    dismissListeners.delete(listener);
  };
}

function useDismissedAt(threadId: string): number | undefined {
  return useSyncExternalStore(subscribeDismissed, () => dismissedAt.get(threadId));
}

function BannerRow(props: { text: string; spoken: string; threadId: string; activityAt: number; expired: boolean }) {
  if (useDismissedAt(props.threadId) === props.activityAt) return null;
  const dismiss = () => {
    dismissedAt.set(props.threadId, props.activityAt);
    dismissListeners.forEach((listener) => listener());
  };
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground",
        props.expired && `border-destructive/40 ${EXPIRED_TINT}`,
      )}
    >
      <span className="sr-only">{props.spoken}</span>
      <span className="min-w-0 tabular-nums" aria-hidden>
        {props.text}
      </span>
      <span className="flex shrink-0 gap-1">
        {props.expired ? <CompactButton threadId={props.threadId} variant="outline" /> : null}
        <Button type="button" variant="ghost" size="sm" onClick={dismiss}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}

function ThreadCacheBanner(props: { threadId: string; running: boolean }) {
  const view = useCacheView(props.threadId);
  if (view === null || !view.settings.banner || props.running) return null;
  const tokens = formatTokens(view.snapshot.contextTokens);
  const cost = costOf(view, view.snapshot.contextTokens);
  const price = cost === null ? "" : ` (≈ ${formatUsd(cost.rewrite)})`;
  const row = { threadId: props.threadId, activityAt: view.snapshot.lastActivityAt };
  if (view.phase === "expiring" && view.snapshot.contextTokens >= MIN_BANNER_TOKENS) {
    return (
      <BannerRow
        {...row}
        expired={false}
        spoken="Prompt cache expires soon. Reply before it does."
        text={`Prompt cache expires in ${formatCountdown(view.remainingMs)}. Reply before then, or the next message sends ${tokens} tokens without the cache${price}.`}
      />
    );
  }
  if (view.phase === "expired" && view.snapshot.contextTokens >= view.settings.compactAtTokens) {
    return (
      <BannerRow
        {...row}
        expired
        spoken="Prompt cache expired."
        text={`Prompt cache expired: the next message sends ${tokens} tokens without the cache${price}. Compact the thread first to send less.`}
      />
    );
  }
  return null;
}

function CacheBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  return <ThreadCacheBanner threadId={composer.scope.threadId} running={composer.isRunning} />;
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({ id: "cache", title: "Prompt cache", component: CacheBadge });
  app.composer.customize({
    id: "cache",
    scopes: ["thread"],
    banners: [{ id: "expiry", chrome: "bare", component: CacheBanner }],
  });
});
