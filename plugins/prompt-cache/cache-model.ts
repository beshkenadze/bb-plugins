/** The usage fields bb reports for one request (or, for Claude Code, one turn). */
export interface UsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** The thread events the cache model reads, newest first (the order `events.list` returns with `order: "desc"`). */
export type CacheEventRow =
  | { type: "thread/tokenUsage/updated"; createdAt: number; data: { tokenUsage: { last: UsageBreakdown } } }
  | {
      type: "thread/contextWindowUsage/updated";
      createdAt: number;
      /** bb takes a `snapshot` after a turn, not at a request. A turn that made no request reports 0 tokens. */
      data: { contextWindowUsage: { usedTokens: number | null; snapshot?: unknown } };
    }
  | { type: "thread/compacted"; createdAt: number }
  | { type: "thread/context/cleared"; createdAt: number };

export interface RateLimitsInfo {
  kind: string;
  status: string;
}

export type TtlSetting = "auto" | "5m" | "1h";

export interface Ttl {
  ms: number;
  source: "setting" | "subscription" | "default";
}

/** Prompt tokens of one usage report: read from the cache, written to it, and sent past it. */
export interface CacheUsage {
  read: number;
  write: number;
  fresh: number;
  prompt: number;
}

export interface CacheSnapshot {
  providerId: string;
  usage: CacheUsage;
  /** What the next request sends again: the latest request's prompt. */
  contextTokens: number;
  lastActivityAt: number;
  ttl: Ttl;
}

export type CachePhase = "warm" | "cooling" | "expiring" | "expired";

const MINUTE_MS = 60_000;
const TTL_MS = { "5m": 5 * MINUTE_MS, "1h": 60 * MINUTE_MS } as const;
/** The share of the lifetime left below which the cache counts as cooling. */
const COOLING_SHARE = 0.4;

/** Providers whose `inputTokens` already contains the cached part (OpenAI semantics). */
const INPUT_INCLUDES_CACHED = new Set(["codex"]);
/** Providers that report one usage sum per turn instead of one report per request. */
const USAGE_PER_TURN = new Set(["claude-code"]);

export function usageScope(providerId: string): "turn" | "request" {
  return USAGE_PER_TURN.has(providerId) ? "turn" : "request";
}

export function normalizeUsage(providerId: string, last: UsageBreakdown): CacheUsage {
  const write = last.cacheWriteInputTokens ?? 0;
  const read = last.cacheReadInputTokens ?? Math.max(0, last.cachedInputTokens - write);
  if (INPUT_INCLUDES_CACHED.has(providerId)) {
    return { read, write, fresh: Math.max(0, last.inputTokens - read - write), prompt: last.inputTokens };
  }
  return { read, write, fresh: last.inputTokens, prompt: last.inputTokens + read + write };
}

export function hitRate(usage: CacheUsage): number {
  return usage.prompt > 0 ? usage.read / usage.prompt : 0;
}

/** Claude Code caches for an hour on a subscription within its plan, otherwise for five minutes. */
export function resolveTtl(providerId: string, setting: TtlSetting, rateLimits: RateLimitsInfo | null): Ttl {
  if (setting !== "auto") return { ms: TTL_MS[setting], source: "setting" };
  const withinPlan =
    rateLimits?.kind === "subscription-window" && (rateLimits.status === "allowed" || rateLimits.status === "warning");
  if (providerId === "claude-code" && withinPlan) return { ms: TTL_MS["1h"], source: "subscription" };
  return { ms: TTL_MS["5m"], source: "default" };
}

export function deriveCache(input: {
  providerId: string;
  events: readonly CacheEventRow[];
  rateLimits: RateLimitsInfo | null;
  ttlSetting: TtlSetting;
}): CacheSnapshot | null {
  let usage: { usage: CacheUsage; at: number } | undefined;
  let contextTokens: number | undefined;
  let requestAt: number | undefined;
  for (const event of input.events) {
    // A compaction or clear starts a new prefix: nothing older describes the cache.
    if (event.type === "thread/compacted" || event.type === "thread/context/cleared") break;
    if (event.type === "thread/tokenUsage/updated") {
      const normalized = normalizeUsage(input.providerId, event.data.tokenUsage.last);
      // A turn that made no request, such as a mod's slash command, says nothing about the cache.
      if (normalized.prompt > 0) usage ??= { usage: normalized, at: event.createdAt };
    } else {
      const { usedTokens, snapshot } = event.data.contextWindowUsage;
      if (usedTokens === 0) continue;
      if (usedTokens !== null) contextTokens ??= usedTokens;
      if (snapshot === undefined) requestAt ??= event.createdAt;
    }
  }
  if (usage === undefined) return null;
  return {
    providerId: input.providerId,
    usage: usage.usage,
    contextTokens: contextTokens ?? usage.usage.prompt,
    lastActivityAt: Math.max(usage.at, requestAt ?? usage.at),
    ttl: resolveTtl(input.providerId, input.ttlSetting, input.rateLimits),
  };
}

export interface CacheRewrite {
  at: number;
  /** Tokens of the earlier context the cache did not serve and the report sent again. */
  tokens: number;
  /** The earlier context, whose size sets a tiered price. */
  context: number;
}

/** A report counts as a rewrite once the cache failed to serve at least half of a context this large. */
const REWRITE_MIN_CONTEXT = 20_000;
const REWRITE_SHARE = 0.5;

/**
 * The reports that sent the earlier context again instead of reading it from the cache, newest first,
 * and the newest report's own rewrite, if it was one. A request shows the miss in its reads. A Claude
 * Code turn sums its requests' reads, so only its writes show it: what it wrote beyond what it added,
 * measured by the first context report after each turn. Reports are not paired across a compaction or
 * clear. A report with no prompt, from a turn that made no request, is skipped.
 */
export function findRewrites(
  providerId: string,
  events: readonly CacheEventRow[],
): { rewrites: CacheRewrite[]; latest: CacheRewrite | null } {
  const scope = usageScope(providerId);
  const rewrites: CacheRewrite[] = [];
  let previous: { prompt: number; contextAfter: number | null } | null = null;
  let open: { at: number; write: number; contextBefore: number } | null = null;
  // Judged reports are always the newest seen so far, so the last one judged a rewrite is the newest's.
  let latest: CacheRewrite | null = null;
  const judge = (at: number, context: number, tokens: number) => {
    if (context < REWRITE_MIN_CONTEXT || tokens < REWRITE_SHARE * context) return;
    latest = { at, tokens, context };
    rewrites.unshift(latest);
  };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "thread/compacted" || event.type === "thread/context/cleared") {
      previous = null;
      open = null;
    } else if (event.type === "thread/tokenUsage/updated") {
      const usage = normalizeUsage(providerId, event.data.tokenUsage.last);
      if (usage.prompt === 0) continue;
      latest = null;
      open = null;
      if (previous !== null && scope === "request") {
        // A smaller request shares only its own prompt with the previous one.
        const shared = Math.min(previous.prompt, usage.prompt);
        judge(event.createdAt, shared, shared - usage.read);
      } else if (previous?.contextAfter != null) {
        open = { at: event.createdAt, write: usage.write, contextBefore: previous.contextAfter };
      }
      previous = { prompt: usage.prompt, contextAfter: null };
    } else {
      const used = event.data.contextWindowUsage.usedTokens;
      if (!used || previous === null || previous.contextAfter !== null) continue;
      previous.contextAfter = used;
      if (open !== null) judge(open.at, open.contextBefore, open.write - Math.max(0, used - open.contextBefore));
      open = null;
    }
  }
  return { rewrites, latest };
}

/** API list prices in $ per million tokens: uncached input and cache reads. Cache writes are multiples of the input price. */
export interface ModelPrice {
  input: number;
  read: number;
  /** Haiku 5.5 charges more for prompts over 100k tokens. */
  over100k?: { input: number; read: number };
}

/** List prices as of October 2026. A model id takes the first family it contains. */
const PRICES: ReadonlyArray<readonly [string, ModelPrice]> = [
  ["fable-5-1", { input: 10, read: 0.25 }],
  ["mythos-5-1", { input: 10, read: 0.25 }],
  ["fable-5", { input: 10, read: 1 }],
  ["mythos-5", { input: 10, read: 1 }],
  ["opus-5-5", { input: 4, read: 0.2 }],
  ["opus-5", { input: 5, read: 0.5 }],
  ["opus-4-5", { input: 5, read: 0.5 }],
  ["opus-4-6", { input: 5, read: 0.5 }],
  ["opus-4-7", { input: 5, read: 0.5 }],
  ["opus-4-8", { input: 5, read: 0.5 }],
  ["opus-4", { input: 15, read: 1.5 }],
  ["sonnet-5-5", { input: 2, read: 0.1 }],
  ["sonnet-5", { input: 2, read: 0.2 }],
  ["sonnet-4", { input: 3, read: 0.3 }],
  ["haiku-5-5", { input: 0.1, read: 0.01, over100k: { input: 0.5, read: 0.05 } }],
  ["haiku-4-5", { input: 1, read: 0.1 }],
  ["haiku-3-5", { input: 0.8, read: 0.08 }],
];
/** Cache writes cost this many times the input price, by lifetime. */
const WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

export function modelPrice(model: string | null): ModelPrice | null {
  if (model === null) return null;
  const id = model.toLowerCase().replace(/[\s._]+/g, "-");
  return PRICES.find(([family]) => id.includes(family))?.[1] ?? null;
}

/**
 * What sending `tokens` of a `promptTokens` prompt costs once the cache expired (a cache write) and while it
 * is warm (a cache read), in $.
 */
export function promptCost(
  price: ModelPrice,
  tokens: number,
  ttlMs: number,
  promptTokens = tokens,
): { rewrite: number; warm: number } {
  const rates = promptTokens > 100_000 && price.over100k ? price.over100k : price;
  const multiplier = ttlMs >= TTL_MS["1h"] ? WRITE_MULTIPLIER["1h"] : WRITE_MULTIPLIER["5m"];
  return { rewrite: (tokens * rates.input * multiplier) / 1e6, warm: (tokens * rates.read) / 1e6 };
}

export function cachePhase(
  snapshot: Pick<CacheSnapshot, "lastActivityAt" | "ttl">,
  now: number,
  warnMs: number,
): { phase: CachePhase; remainingMs: number } {
  const remainingMs = Math.max(0, snapshot.lastActivityAt + snapshot.ttl.ms - now);
  const phase: CachePhase =
    remainingMs === 0
      ? "expired"
      : remainingMs <= warnMs
        ? "expiring"
        : remainingMs <= snapshot.ttl.ms * COOLING_SHARE
          ? "cooling"
          : "warm";
  return { phase, remainingMs };
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${Number((tokens / 1_000_000).toFixed(1))}M`;
}

export function formatUsd(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 100 ? usd.toFixed(2) : usd.toFixed(0)}`;
}

export function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
