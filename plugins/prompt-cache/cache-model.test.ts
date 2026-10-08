import { describe, expect, it } from "vitest";
import {
  cachePhase,
  deriveCache,
  formatCountdown,
  formatTokens,
  hitRate,
  normalizeUsage,
  resolveTtl,
  usageScope,
  type CacheEventRow,
  type CacheSnapshot,
} from "./cache-model";

const MIN = 60_000;

function usageRow(createdAt: number, last: Partial<Parameters<typeof normalizeUsage>[1]>): CacheEventRow {
  return {
    type: "thread/tokenUsage/updated",
    createdAt,
    data: { tokenUsage: { last: { inputTokens: 0, cachedInputTokens: 0, ...last } } },
  };
}

function contextRow(createdAt: number, usedTokens: number | null): CacheEventRow {
  return { type: "thread/contextWindowUsage/updated", createdAt, data: { contextWindowUsage: { usedTokens } } };
}

describe("normalizeUsage", () => {
  it("adds Claude Code cache reads and writes to the uncached input", () => {
    const usage = normalizeUsage("claude-code", {
      inputTokens: 10,
      cachedInputTokens: 2_717_870,
      cacheReadInputTokens: 2_712_574,
      cacheWriteInputTokens: 5_296,
    });
    expect(usage).toEqual({ read: 2_712_574, write: 5_296, fresh: 10, prompt: 2_717_880 });
  });

  it("treats Codex input as already including the cached part", () => {
    const usage = normalizeUsage("codex", {
      inputTokens: 516_427,
      cachedInputTokens: 507_520,
      cacheReadInputTokens: 507_520,
      cacheWriteInputTokens: 0,
    });
    expect(usage).toEqual({ read: 507_520, write: 0, fresh: 8_907, prompt: 516_427 });
  });

  it("falls back to cachedInputTokens minus writes when reads are not reported", () => {
    const usage = normalizeUsage("pi", { inputTokens: 2, cachedInputTokens: 389_794, cacheWriteInputTokens: 1_995 });
    expect(usage).toEqual({ read: 387_799, write: 1_995, fresh: 2, prompt: 389_796 });
  });
});

describe("usageScope", () => {
  it("is a turn for Claude Code, which reports usage once per turn, and a request elsewhere", () => {
    expect(usageScope("claude-code")).toBe("turn");
    expect(usageScope("codex")).toBe("request");
    expect(usageScope("pi")).toBe("request");
  });
});

describe("hitRate", () => {
  it("is the share of the prompt read from the cache", () => {
    expect(hitRate({ read: 98, write: 1, fresh: 1, prompt: 100 })).toBe(0.98);
    expect(hitRate({ read: 0, write: 0, fresh: 0, prompt: 0 })).toBe(0);
  });
});

describe("resolveTtl", () => {
  const subscription = { kind: "subscription-window", status: "allowed" };

  it("uses a pinned setting over everything else", () => {
    expect(resolveTtl("claude-code", "5m", subscription)).toEqual({ ms: 5 * MIN, source: "setting" });
    expect(resolveTtl("codex", "1h", null)).toEqual({ ms: 60 * MIN, source: "setting" });
  });

  it("gives a Claude subscription within its plan one hour", () => {
    expect(resolveTtl("claude-code", "auto", subscription)).toEqual({ ms: 60 * MIN, source: "subscription" });
    expect(resolveTtl("claude-code", "auto", { kind: "subscription-window", status: "warning" })).toEqual({
      ms: 60 * MIN,
      source: "subscription",
    });
  });

  it("falls back to five minutes for a blocked plan, credits, or no limits seen yet", () => {
    expect(resolveTtl("claude-code", "auto", { kind: "subscription-window", status: "blocked" })).toEqual({
      ms: 5 * MIN,
      source: "default",
    });
    expect(resolveTtl("claude-code", "auto", { kind: "credits", status: "allowed" }).ms).toBe(5 * MIN);
    expect(resolveTtl("claude-code", "auto", null).ms).toBe(5 * MIN);
  });

  it("does not apply the Claude subscription rule to other providers", () => {
    expect(resolveTtl("codex", "auto", subscription)).toEqual({ ms: 5 * MIN, source: "default" });
  });
});

describe("deriveCache", () => {
  const base = { providerId: "claude-code", rateLimits: null, ttlSetting: "auto" as const };

  it("returns null without usage", () => {
    expect(deriveCache({ ...base, events: [] })).toBeNull();
    expect(deriveCache({ ...base, events: [contextRow(1_000, 50_000)] })).toBeNull();
  });

  it("builds a snapshot from the newest usage and context events", () => {
    const events = [
      contextRow(5_000, 687_137),
      usageRow(4_000, { inputTokens: 4, cachedInputTokens: 676_639, cacheReadInputTokens: 676_285, cacheWriteInputTokens: 354 }),
      usageRow(1_000, { inputTokens: 9, cachedInputTokens: 0 }),
    ];
    expect(deriveCache({ ...base, events })).toEqual<CacheSnapshot>({
      providerId: "claude-code",
      usage: { read: 676_285, write: 354, fresh: 4, prompt: 676_643 },
      contextTokens: 687_137,
      lastActivityAt: 5_000,
      ttl: { ms: 5 * MIN, source: "default" },
    });
  });

  it("uses the usage prompt as the context size when no context event reports one", () => {
    const events = [contextRow(3_000, null), usageRow(2_000, { inputTokens: 1_000, cachedInputTokens: 900 })];
    expect(deriveCache({ ...base, providerId: "codex", events })).toMatchObject({
      contextTokens: 1_000,
      lastActivityAt: 3_000,
    });
  });

  it("ignores everything before the latest compaction or clear", () => {
    const usage = usageRow(1_000, { inputTokens: 5, cachedInputTokens: 100 });
    expect(deriveCache({ ...base, events: [{ type: "thread/compacted", createdAt: 2_000 }, usage] })).toBeNull();
    expect(deriveCache({ ...base, events: [{ type: "thread/context/cleared", createdAt: 2_000 }, usage] })).toBeNull();
    const after = usageRow(3_000, { inputTokens: 7, cachedInputTokens: 0 });
    expect(deriveCache({ ...base, events: [after, { type: "thread/compacted", createdAt: 2_000 }, usage] })).toMatchObject({
      usage: { fresh: 7 },
      lastActivityAt: 3_000,
    });
  });

  it("resolves the TTL from the setting and rate limits", () => {
    const events = [usageRow(1_000, { inputTokens: 1, cachedInputTokens: 0 })];
    const rateLimits = { kind: "subscription-window", status: "allowed" };
    expect(deriveCache({ ...base, events, rateLimits })?.ttl).toEqual({ ms: 60 * MIN, source: "subscription" });
  });
});

describe("cachePhase", () => {
  const snapshot = (lastActivityAt: number): Pick<CacheSnapshot, "lastActivityAt" | "ttl"> => ({
    lastActivityAt,
    ttl: { ms: 5 * MIN, source: "default" },
  });

  it("is warm above 40% of the lifetime left", () => {
    expect(cachePhase(snapshot(0), 0, 60_000)).toEqual({ phase: "warm", remainingMs: 5 * MIN });
    expect(cachePhase(snapshot(0), 3 * MIN - 1, 60_000).phase).toBe("warm");
  });

  it("cools down at 40% and below", () => {
    expect(cachePhase(snapshot(0), 3 * MIN, 60_000)).toEqual({ phase: "cooling", remainingMs: 2 * MIN });
  });

  it("is expiring within the warning window", () => {
    expect(cachePhase(snapshot(0), 4 * MIN, 60_000)).toEqual({ phase: "expiring", remainingMs: MIN });
  });

  it("is expired once the lifetime runs out", () => {
    expect(cachePhase(snapshot(0), 5 * MIN, 60_000)).toEqual({ phase: "expired", remainingMs: 0 });
    expect(cachePhase(snapshot(0), 9 * MIN, 60_000)).toEqual({ phase: "expired", remainingMs: 0 });
  });
});

describe("formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(300)).toBe("300");
    expect(formatTokens(2_400)).toBe("2.4k");
    expect(formatTokens(151_234)).toBe("151k");
    expect(formatTokens(2_712_574)).toBe("2.7M");
  });

  it("formats a countdown as m:ss, rounding up to whole seconds", () => {
    expect(formatCountdown(221_000)).toBe("3:41");
    expect(formatCountdown(41_001)).toBe("0:42");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(60 * MIN)).toBe("60:00");
  });
});
