import { describe, expect, it } from "vitest";
import {
  cachePhase,
  deriveCache,
  findRewrites,
  formatCountdown,
  formatTokens,
  formatUsd,
  hitRate,
  modelPrice,
  normalizeUsage,
  promptCost,
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

function contextRow(createdAt: number, usedTokens: number | null, snapshot = false): CacheEventRow {
  const contextWindowUsage = snapshot ? { usedTokens, snapshot: {} } : { usedTokens };
  return { type: "thread/contextWindowUsage/updated", createdAt, data: { contextWindowUsage } };
}

const EMPTY = { inputTokens: 0, cachedInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };

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

  it("skips a turn that made no request, such as a mod's slash command", () => {
    // Real sequence: /keepwarm answered by cache-watch without calling the model.
    const events = [
      contextRow(1_200, 64_104, true),
      usageRow(1_100, EMPTY),
      contextRow(1_100, 0),
      usageRow(1_000, { inputTokens: 6, cachedInputTokens: 63_717, cacheReadInputTokens: 63_656, cacheWriteInputTokens: 61 }),
    ];
    expect(deriveCache({ ...base, events })).toMatchObject({
      usage: { read: 63_656, write: 61 },
      contextTokens: 64_104,
      lastActivityAt: 1_000,
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

describe("findRewrites", () => {
  const compacted: CacheEventRow = { type: "thread/compacted", createdAt: 0 };

  it("passes a Claude Code turn that wrote only what it added", () => {
    // Real numbers: the turn grew the context by 16.6k and wrote 16.9k.
    const events = [
      contextRow(4, 112_472),
      usageRow(3, { inputTokens: 16, cachedInputTokens: 831_274, cacheReadInputTokens: 814_346, cacheWriteInputTokens: 16_928 }),
      contextRow(2, 95_871),
      usageRow(1, { inputTokens: 30, cachedInputTokens: 900_000, cacheReadInputTokens: 880_000, cacheWriteInputTokens: 20_000 }),
    ];
    expect(findRewrites("claude-code", events)).toEqual({ rewrites: [], latest: null });
  });

  it("counts a Claude Code turn that wrote the earlier context again", () => {
    const events = [
      contextRow(4, 105_000),
      usageRow(3, { inputTokens: 5, cachedInputTokens: 500_000, cacheReadInputTokens: 396_000, cacheWriteInputTokens: 104_000 }),
      contextRow(2, 100_000),
      usageRow(1, { inputTokens: 5, cachedInputTokens: 300_000, cacheReadInputTokens: 295_000, cacheWriteInputTokens: 5_000 }),
    ];
    const rewrite = { at: 3, tokens: 99_000, context: 100_000 };
    expect(findRewrites("claude-code", events)).toEqual({ rewrites: [rewrite], latest: rewrite });
  });

  it("waits for the context after a Claude Code turn before judging it", () => {
    const events = [
      usageRow(3, { inputTokens: 5, cachedInputTokens: 500_000, cacheReadInputTokens: 396_000, cacheWriteInputTokens: 104_000 }),
      contextRow(2, 100_000),
      usageRow(1, { inputTokens: 5, cachedInputTokens: 300_000, cacheReadInputTokens: 295_000, cacheWriteInputTokens: 5_000 }),
    ];
    expect(findRewrites("claude-code", events).rewrites).toEqual([]);
  });

  it("keeps older rewrites and leaves latest empty once a later turn read the cache", () => {
    const events = [
      contextRow(6, 110_000),
      usageRow(5, { inputTokens: 5, cachedInputTokens: 600_000, cacheReadInputTokens: 595_000, cacheWriteInputTokens: 5_000 }),
      contextRow(4, 105_000),
      usageRow(3, { inputTokens: 5, cachedInputTokens: 500_000, cacheReadInputTokens: 396_000, cacheWriteInputTokens: 104_000 }),
      contextRow(2, 100_000),
      usageRow(1, { inputTokens: 5, cachedInputTokens: 300_000, cacheReadInputTokens: 295_000, cacheWriteInputTokens: 5_000 }),
    ];
    expect(findRewrites("claude-code", events)).toEqual({ rewrites: [{ at: 3, tokens: 99_000, context: 100_000 }], latest: null });
  });

  it("does not pair reports across a compaction", () => {
    const write = { inputTokens: 5, cachedInputTokens: 60_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 60_000 };
    // The /compact turn itself reports an empty usage after the compaction.
    const events = [contextRow(5, 60_000), usageRow(4, write), usageRow(3, EMPTY), contextRow(2, 100_000), compacted, usageRow(1, write)];
    expect(findRewrites("claude-code", events).rewrites).toEqual([]);
  });

  it("looks through a turn that made no request", () => {
    const events = [
      contextRow(7, 105_000, true),
      usageRow(6, { inputTokens: 5, cachedInputTokens: 105_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 105_000 }),
      contextRow(5, 100_000, true),
      usageRow(4, EMPTY),
      contextRow(3, 0),
      contextRow(2, 100_000, true),
      usageRow(1, { inputTokens: 5, cachedInputTokens: 100_000, cacheReadInputTokens: 95_000, cacheWriteInputTokens: 5_000 }),
    ];
    expect(findRewrites("claude-code", events).latest).toEqual({ at: 6, tokens: 100_000, context: 100_000 });
  });

  it("ignores context reports without a size and contexts under 20k", () => {
    const cold = { inputTokens: 5, cachedInputTokens: 19_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 19_000 };
    const small = [contextRow(4, 19_500), usageRow(3, cold), contextRow(2, 19_000), usageRow(1, cold)];
    expect(findRewrites("claude-code", small).rewrites).toEqual([]);
    const unsized = [contextRow(5, null), usageRow(3, cold), contextRow(2, null), usageRow(1, cold)];
    expect(findRewrites("claude-code", unsized).rewrites).toEqual([]);
  });

  it("counts a request that read less than half of the previous prompt", () => {
    const events = [
      usageRow(3, { inputTokens: 125_000, cachedInputTokens: 3_000, cacheReadInputTokens: 3_000 }),
      usageRow(2, { inputTokens: 120_000, cachedInputTokens: 119_000, cacheReadInputTokens: 119_000 }),
      usageRow(1, { inputTokens: 118_000, cachedInputTokens: 0 }),
    ];
    const rewrite = { at: 3, tokens: 117_000, context: 120_000 };
    expect(findRewrites("codex", events)).toEqual({ rewrites: [rewrite], latest: rewrite });
  });

  it("passes a smaller request the cache served in full", () => {
    const events = [
      usageRow(2, { inputTokens: 60_000, cachedInputTokens: 60_000, cacheReadInputTokens: 60_000 }),
      usageRow(1, { inputTokens: 120_000, cachedInputTokens: 0 }),
    ];
    expect(findRewrites("codex", events).rewrites).toEqual([]);
  });

  it("tells the newest report from an older one reported in the same millisecond", () => {
    const events = [
      usageRow(5, { inputTokens: 102_000, cachedInputTokens: 101_000, cacheReadInputTokens: 101_000 }),
      usageRow(5, { inputTokens: 101_000, cachedInputTokens: 0 }),
      usageRow(1, { inputTokens: 100_000, cachedInputTokens: 0 }),
    ];
    expect(findRewrites("codex", events)).toMatchObject({ rewrites: [{ at: 5 }], latest: null });
  });
});

describe("modelPrice", () => {
  it("matches a model id to its family, the most specific first", () => {
    expect(modelPrice("claude-opus-5-5")).toEqual({ input: 4, read: 0.2 });
    expect(modelPrice("claude-opus-5")).toEqual({ input: 5, read: 0.5 });
    expect(modelPrice("claude-opus-4-5-20251101")).toEqual({ input: 5, read: 0.5 });
    expect(modelPrice("claude-opus-4-20250514")).toEqual({ input: 15, read: 1.5 });
    expect(modelPrice("claude-fable-5-1")).toEqual({ input: 10, read: 0.25 });
    expect(modelPrice("Claude Sonnet 5.5")).toEqual({ input: 2, read: 0.1 });
    expect(modelPrice("claude-opus-5-5[1m]")).toEqual({ input: 4, read: 0.2 });
  });

  it("returns null for an unknown model, an alias, or none", () => {
    expect(modelPrice("gpt-5.3-codex")).toBeNull();
    expect(modelPrice("opus")).toBeNull();
    expect(modelPrice(null)).toBeNull();
  });
});

describe("promptCost", () => {
  it("prices a rewrite at the write rate of the lifetime and a warm turn at the read rate", () => {
    const opus = modelPrice("claude-opus-5-5")!;
    expect(promptCost(opus, 100_000, 60 * MIN)).toEqual({ rewrite: 0.8, warm: 0.02 });
    expect(promptCost(opus, 100_000, 5 * MIN)).toEqual({ rewrite: 0.5, warm: 0.02 });
  });

  it("uses Haiku 5.5's higher price for prompts over 100k tokens", () => {
    const haiku = modelPrice("claude-haiku-5-5")!;
    expect(promptCost(haiku, 100_000, 60 * MIN).rewrite).toBeCloseTo(0.02);
    expect(promptCost(haiku, 200_000, 60 * MIN).rewrite).toBeCloseTo(0.2);
    // Part of a larger prompt pays that prompt's tier.
    expect(promptCost(haiku, 80_000, 5 * MIN, 120_000).rewrite).toBeCloseTo(0.05);
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

  it("formats dollars to the cent, whole above $100", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.8)).toBe("$0.80");
    expect(formatUsd(4.426)).toBe("$4.43");
    expect(formatUsd(123.4)).toBe("$123");
  });
});
