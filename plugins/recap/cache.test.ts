import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { RecapCache, fingerprint } from "./cache";
import type { SavedRecap } from "./contract";

const selection = { providerId: "claude-code", model: "test", reasoningLevel: "low" } as const;
const key = (seq = 1, short = false) => fingerprint(seq, selection, 100_000, 120, short);
const result = (seq = 1, text = "summary"): SavedRecap => ({ ok: true, text, preview: "summary", generatedAt: 1, coverage: { totalEntries: 1, includedEntries: 1, omittedEntries: 0, shortenedEntries: 0, hasOlder: false, sourceMaxSeq: seq } });

describe("durable Recap cache", () => {
  it("persists separate modes and attempted versions through a new cache instance", async () => {
    const host = createFakePluginHost({ pluginId: "recap" });
    try {
      const cache = new RecapCache(host.bb.storage.kv);
      await cache.load();
      const record = await cache.visit("source", 1);
      const lease = await cache.attempt(record, false, key());
      await cache.save(lease!, result());
      await cache.attempt(record, true, key(1, true));
      const restored = new RecapCache(host.bb.storage.kv);
      await restored.load();
      expect(restored.get("source")?.results.full).toEqual({ key: key(), result: result() });
      expect(restored.get("source")?.attempted.short).toBe(key(1, true));
      expect(restored.get("source")?.results.short).toBeUndefined();
      await cache.close();
      await restored.close();
    } finally { await host.harness.lifecycle.dispose(); }
  });
  it("serializes concurrent visits, evicts at 100 and never resurrects old leases", async () => {
    const host = createFakePluginHost({ pluginId: "recap" });
    try {
      const cache = new RecapCache(host.bb.storage.kv);
      await cache.load();
      const first = await cache.visit("first", 1);
      const old = await cache.attempt(first, false, key());
      await Promise.all(Array.from({ length: 100 }, (_, i) => cache.visit(`t${i}`, 1)));
      expect(cache.all()).toHaveLength(100);
      expect(cache.get("first")).toBeUndefined();
      await cache.save(old!, result());
      const restored = new RecapCache(host.bb.storage.kv);
      await restored.load();
      expect(restored.all()).toHaveLength(100);
      expect(restored.get("first")).toBeUndefined();
      const record = cache.get("t99")!;
      const deleted = await cache.attempt(record, false, key());
      await cache.delete("t99");
      await cache.visit("t99", 2);
      await cache.save(deleted!, result());
      expect(cache.get("t99")?.results.full).toBeUndefined();
      await cache.close(); await restored.close();
    } finally { await host.harness.lifecycle.dispose(); }
  });
  it("keeps older snapshots stale, rejects obsolete writes and stores worst-case Unicode/escaping under the KV cap", async () => {
    const host = createFakePluginHost({ pluginId: "recap" });
    try {
      const cache = new RecapCache(host.bb.storage.kv);
      await cache.load();
      const record = await cache.visit("source", 1);
      const old = await cache.attempt(record, false, key());
      await cache.revision(record, 2);
      await cache.save(old!, result());
      expect(record.results.full?.key).not.toBe(key(2));
      const newer = await cache.attempt(record, false, key(2));
      await cache.save(newer!, result(2, "\u0001".repeat(30_000)));
      await cache.save(old!, result());
      const short = await cache.attempt(record, true, key(2, true));
      await cache.save(short!, result(2, "界".repeat(30_000)));
      expect(record.results.full?.result.coverage.sourceMaxSeq).toBe(2);
      expect(record.results.short?.result.text).toHaveLength(30_000);
      const closed = await cache.attempt(record, false, key(3));
      await cache.close();
      await cache.save(closed!, result(3));
      const restored = new RecapCache(host.bb.storage.kv);
      await restored.load();
      expect(restored.get("source")?.results.full?.result.coverage.sourceMaxSeq).toBe(2);
      await restored.close();
    } finally { await host.harness.lifecycle.dispose(); }
  });
  it("parses untrusted persisted values and fingerprints all generation inputs", async () => {
    const host = createFakePluginHost({ pluginId: "recap" });
    try {
      await host.bb.storage.kv.set("recap-cache/index", ["bad"]);
      await host.bb.storage.kv.set("recap-cache/thread/bad", { threadId: "bad", results: "invalid" });
      const cache = new RecapCache(host.bb.storage.kv);
      await cache.load();
      expect(cache.all()).toEqual([]);
      expect(new Set([key(), key(2), key(1, true), fingerprint(1, { ...selection, model: "new" }, 100_000, 120, false), fingerprint(1, selection, 10_000, 120, false), fingerprint(1, selection, 100_000, 10, false)]).size).toBe(6);
      await cache.close();
    } finally { await host.harness.lifecycle.dispose(); }
  });
});
