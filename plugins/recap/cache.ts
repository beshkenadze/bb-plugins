import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { recapSuccessSchema, type ModelSelection, type SavedRecap } from "./contract";

export const PROMPT_VERSION = 4;
const INDEX = "recap-cache/index";
const prefix = (id: string) => `recap-cache/thread/${encodeURIComponent(id)}`;
const mode = (short: boolean) => short ? "short" : "full";
const idSchema = z.string().min(1).max(100);
const resultSchema = z.object({ key: z.string().max(2000), result: recapSuccessSchema });
const metadataSchema = z.object({
  threadId: idSchema, sourceMaxSeq: z.number().int().nonnegative(), visitedAt: z.number().int().nonnegative(),
  attempted: z.object({ full: z.string().max(2000).optional(), short: z.string().max(2000).optional() }),
});
export function fingerprint(seq: number, selection: ModelSelection | null, budget: number, timeoutSec: number, short: boolean): string {
  return JSON.stringify([seq, selection?.providerId, selection?.model, selection?.reasoningLevel, selection?.serviceTier ?? null, budget, timeoutSec, mode(short), PROMPT_VERSION]);
}
export interface CacheRecord extends z.infer<typeof metadataSchema> {
  results: { full?: z.infer<typeof resultSchema>; short?: z.infer<typeof resultSchema> };
  tickets: { full: number; short: number };
}
export interface CacheLease { record: CacheRecord; short: boolean; key: string; ticket: number }

/** Only storage operations are serialized. A lease never survives eviction/deletion/disposal. */
export class RecapCache {
  private records = new Map<string, CacheRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private kv: BbPluginApi["storage"]["kv"]) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private async set(key: string, value: unknown): Promise<void> {
    if (this.closed) return;
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) throw new Error("Recap cache value exceeds 256KiB");
    await this.kv.set(key, value);
  }
  private async metadata(record: CacheRecord): Promise<void> {
    await this.set(prefix(record.threadId), metadataSchema.parse(record));
  }
  private async index(): Promise<void> { await this.set(INDEX, [...this.records.keys()]); }
  async load(): Promise<void> {
    await this.serial(async () => {
      const parsed = z.array(idSchema).max(100).safeParse(await this.kv.get(INDEX));
      if (!parsed.success || this.closed) return;
      for (const id of new Set(parsed.data)) {
        const metadata = metadataSchema.safeParse(await this.kv.get(prefix(id)));
        if (!metadata.success || metadata.data.threadId !== id) continue;
        const record: CacheRecord = { ...metadata.data, results: {}, tickets: { full: 0, short: 0 } };
        for (const format of ["full", "short"] as const) {
          const saved = resultSchema.safeParse(await this.kv.get(`${prefix(id)}/${format}`));
          if (saved.success) record.results[format] = saved.data;
        }
        if (!this.closed) this.records.set(id, record);
      }
    });
  }
  get(id: string): CacheRecord | undefined { return this.records.get(id); }
  all(): CacheRecord[] { return [...this.records.values()]; }
  current(record: CacheRecord): boolean { return !this.closed && this.records.get(record.threadId) === record; }
  async visit(id: string, seq: number, admit = () => true): Promise<CacheRecord> {
    return this.serial(async () => {
      const existing = this.records.get(id);
      const record = existing ?? { threadId: id, sourceMaxSeq: seq, visitedAt: Date.now(), attempted: {}, results: {}, tickets: { full: 0, short: 0 } };
      if (this.closed || !admit()) return record;
      record.sourceMaxSeq = Math.max(record.sourceMaxSeq, seq);
      // LRU is updated by visits, not idle events. This doesn't change the idle deadline.
      record.visitedAt = Date.now();
      this.records.delete(id);
      this.records.set(id, record);
      if (this.records.size > 100) await this.remove(this.records.keys().next().value!);
      await this.metadata(record);
      await this.index();
      return record;
    });
  }
  async revision(record: CacheRecord, seq: number): Promise<void> {
    await this.serial(async () => {
      if (!this.current(record) || seq <= record.sourceMaxSeq) return;
      record.sourceMaxSeq = seq;
      await this.metadata(record);
    });
  }
  async attempt(record: CacheRecord, short: boolean, key: string): Promise<CacheLease | null> {
    return this.serial(async () => {
      if (!this.current(record)) return null;
      const format = mode(short);
      record.attempted[format] = key;
      const lease = { record, short, key, ticket: ++record.tickets[format] };
      await this.metadata(record);
      return this.current(record) ? lease : null;
    });
  }
  async releaseAttempt(lease: CacheLease): Promise<void> {
    await this.serial(async () => {
      const format = mode(lease.short);
      const record = lease.record;
      if (!this.current(record) || record.tickets[format] !== lease.ticket ||
          record.attempted[format] !== lease.key || record.results[format]?.key === lease.key) return;
      delete record.attempted[format];
      await this.metadata(record);
    });
  }
  async save(lease: CacheLease, result: SavedRecap): Promise<void> {
    await this.serial(async () => {
      const format = mode(lease.short);
      if (!this.current(lease.record) || lease.record.tickets[format] !== lease.ticket) return;
      const value = resultSchema.parse({ key: lease.key, result });
      await this.set(`${prefix(lease.record.threadId)}/${format}`, value);
      if (this.current(lease.record)) lease.record.results[format] = value;
    });
  }
  private async remove(id: string): Promise<void> {
    this.records.delete(id);
    if (this.closed) return;
    // Remove index first: a partial deletion cannot restore an evicted record on reload.
    await this.index();
    for (const suffix of ["", "/full", "/short"]) {
      if (this.closed) return;
      await this.kv.delete(`${prefix(id)}${suffix}`);
    }
  }
  async delete(id: string): Promise<void> { await this.serial(() => this.remove(id)); }
  async flush(): Promise<void> { await this.queue; }
  async close(): Promise<void> { this.closed = true; this.records.clear(); await this.queue; }
}
