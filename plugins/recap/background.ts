export const IDLE_MS = 180_000;
interface Source { seq: number; runnable: boolean; deadline: number; version: number; consumed: number }

/** In-memory inactivity clock. Persisted visits are rechecked and start a new clock on reload. */
export class BackgroundRecaps {
  private sources = new Map<string, Source>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private disposed = false;
  constructor(private run: (id: string) => Promise<void>, private error: (error: unknown) => void) {}
  observe(id: string, seq: number, runnable: boolean, activity = false): void {
    if (this.disposed) return;
    const old = this.sources.get(id);
    if (!old) this.sources.set(id, { seq, runnable, deadline: Date.now() + IDLE_MS, version: 1, consumed: 0 });
    else if (seq > old.seq || old.runnable !== runnable || activity) {
      old.seq = Math.max(old.seq, seq); old.runnable = runnable;
      old.deadline = Date.now() + IDLE_MS; old.version++;
    }
    this.schedule();
  }
  forget(id: string): void { this.sources.delete(id); this.schedule(); }
  invalidate(): void {
    for (const source of this.sources.values()) { source.version++; source.deadline = Date.now() + IDLE_MS; }
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.disposed || this.busy) return;
    const due = [...this.sources.values()].filter((source) => source.runnable && source.version !== source.consumed);
    if (!due.length) return;
    const delay = Math.max(0, Math.min(...due.map((source) => source.deadline)) - Date.now());
    this.timer = setTimeout(() => { void this.pump(); }, delay);
  }
  private async pump(): Promise<void> {
    if (this.disposed || this.busy) return;
    const next = [...this.sources].find(([, source]) => source.runnable && source.version !== source.consumed && source.deadline <= Date.now());
    if (!next) { this.schedule(); return; }
    next[1].consumed = next[1].version;
    this.busy = true;
    try { await this.run(next[0]); } catch (error) { if (!this.disposed) this.error(error); }
    finally { this.busy = false; this.schedule(); }
  }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.sources.clear(); }
}
