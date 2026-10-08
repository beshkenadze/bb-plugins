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
      data: { contextWindowUsage: { usedTokens: number | null } };
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
  let usage: { last: UsageBreakdown; at: number } | undefined;
  let context: { usedTokens: number | null; at: number } | undefined;
  for (const event of input.events) {
    // A compaction or clear starts a new prefix: nothing older describes the cache.
    if (event.type === "thread/compacted" || event.type === "thread/context/cleared") break;
    if (event.type === "thread/tokenUsage/updated") {
      usage ??= { last: event.data.tokenUsage.last, at: event.createdAt };
    } else {
      context ??= { usedTokens: event.data.contextWindowUsage.usedTokens, at: event.createdAt };
    }
  }
  if (usage === undefined) return null;
  const normalized = normalizeUsage(input.providerId, usage.last);
  return {
    providerId: input.providerId,
    usage: normalized,
    contextTokens: context?.usedTokens ?? normalized.prompt,
    lastActivityAt: Math.max(usage.at, context?.at ?? usage.at),
    ttl: resolveTtl(input.providerId, input.ttlSetting, input.rateLimits),
  };
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

export function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
