import type { BbPluginApi } from "@get-bb/plugin-sdk";
type ThreadResponse = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
import { z } from "zod";
import { type ModelSelection, type RecapInput, type RecapResult, rpcContract, selectionSchema } from "./contract";
import { buildRecapPrompt, extractRecap, extractPreview, loadHistory } from "./history";
import { RecapCache, fingerprint, type CacheRecord, type CacheLease } from "./cache";
import { BackgroundRecaps } from "./background";

const SELECTION_KEY = "model-selection";
const fail = (code: Extract<RecapResult, { ok: false }>["code"], message: string): RecapResult => ({ ok: false, code, message });
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
interface ActiveRequest {
  threadId: string;
  workerId: string | null;
  controller: AbortController;
  timedOut: boolean;
  retryCancelled?: boolean;
  finished?: boolean;
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // Retain public cleanup capabilities before bb's generation-bound accessor becomes stale.
  // A spawn cannot be interrupted, so its late result still needs orphan cleanup after reload.
  const cleanupThreads = bb.sdk.threads;
  const log = bb.log;
  const cache = new RecapCache(bb.storage.kv);
  await cache.load();
  const settings = bb.settings.define({
    timeoutSec: {
      type: "number", label: "Timeout (seconds)", description: "Time allowed for reading history and generating a recap.",
      default: 120, experimental_schema: z.number().int().min(10).max(900),
    },
    maxHistoryChars: {
      type: "number", label: "History character budget",
      description: "Maximum normalized history sent to the model. When it does not fit, initial context and recent work are kept, with an explicit warning.",
      default: 100_000, experimental_schema: z.number().int().min(10_000).max(250_000),
    },
    backgroundEnabled: {
      type: "boolean", label: "Background recaps", description: "Prepare recaps for visited threads after three minutes of execution/history inactivity.", default: true,
    },
  });
  const active = new Map<string, ActiveRequest>();
  const inflight = new Set<Promise<RecapResult>>();
  let disposed = false;
  const automatic = new Map<string, { request: ActiveRequest; key: string; result: Promise<RecapResult> }>();
  const sourceEpoch = new Map<string, number>();
  const probes = new Map<string, number>();
  const latestProbe = new Map<string, object>();
  const lifecycle = new AbortController();
  const readable = (thread: ThreadResponse) => thread.visibility === "visible" && thread.deletedAt === null;
  const visible = (thread: ThreadResponse) => readable(thread) && thread.archivedAt === null;
  const idle = (thread: ThreadResponse) => thread.status === "idle" && thread.runtime.displayStatus === "idle" && thread.activeBackgroundAgentCount === 0 && thread.queuedMessageCount === 0;
  const newRequest = (threadId: string): ActiveRequest => ({ threadId, workerId: null, controller: new AbortController(), timedOut: false });
  const scheduler = new BackgroundRecaps(generateAutomatic, (error) => bb.log.warn(`Recap background: ${message(error)}`));
  const epoch = (id: string) => sourceEpoch.get(id) ?? 0;
  const tracked = (id: string) => cache.get(id) || probes.has(id) || automatic.has(id) || [...active.values()].some((request) => request.threadId === id);
  const pruneEpoch = (id: string) => { if (!tracked(id)) sourceEpoch.delete(id); };
  const cancelAutomatic = (request: ActiveRequest) => {
    if (!request.finished) request.retryCancelled = true;
    request.controller.abort();
  };

  async function snapshot(threadId: string, signal: AbortSignal) {
    const version = epoch(threadId);
    const thread = await bb.sdk.threads.get({ threadId, signal });
    signal.throwIfAborted();
    if (disposed || epoch(threadId) !== version) return null;
    if (!readable(thread)) return { thread, seq: 0, version };
    const page = await bb.sdk.threads.timeline({ threadId, signal, segmentLimit: "1", summaryOnly: "true", includeNestedRows: "false" });
    signal.throwIfAborted();
    return disposed || epoch(threadId) !== version ? null : { thread, seq: page.maxSeq, version };
  }
  async function observe(record: CacheRecord, thread: ThreadResponse, seq: number, activity = false, version = epoch(thread.id), admit = () => true) {
    if (!cache.current(record) || !admit()) return;
    await cache.revision(record, seq);
    if (!cache.current(record) || epoch(thread.id) !== version || !admit()) return;
    scheduler.observe(record.threadId, record.sourceMaxSeq, idle(thread), activity);
  }
  async function generateAutomatic(threadId: string): Promise<void> {
    const record = cache.get(threadId);
    if (disposed || !record) { scheduler.forget(threadId); return; }
    if ([...active.values()].some((request) => request.threadId === threadId)) {
      scheduler.observe(threadId, record.sourceMaxSeq, true, true); return;
    }
    const request = newRequest(threadId);
    // Reserve the source while rechecking/history-loading too, not just while the worker exists.
    const job = { request, key: "", result: Promise.resolve(fail("cancelled", "Recap cancelled.")) };
    automatic.set(threadId, job);
    job.result = run({ threadId, requestId: "background", short: true, force: false }, request, true, job);
    inflight.add(job.result);
    try { await job.result; }
    finally { automatic.delete(threadId); inflight.delete(job.result); pruneEpoch(threadId); }
  }

  const scheduledIds = new Set(cache.all().map((record) => record.threadId));
  for (const record of cache.all()) scheduler.observe(record.threadId, record.sourceMaxSeq, true);
  async function readSelection(): Promise<ModelSelection | null> {
    const parsed = selectionSchema.safeParse(await bb.storage.kv.get(SELECTION_KEY));
    return parsed.success ? parsed.data : null;
  }

  async function defaultSelection(): Promise<ModelSelection | null> {
    for (const provider of await bb.sdk.providers.list()) {
      if (!provider.available) continue;
      try {
        const { models } = await bb.sdk.providers.models({ providerId: provider.id });
        const model = models.find((item) => item.isDefault) ?? models[0];
        if (model) return { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
      } catch (error) {
        bb.log.warn(`Recap model catalog ${provider.id}: ${message(error)}`);
      }
    }
    return null;
  }

  async function cleanup(workerId: string): Promise<void> {
    // Each operation runs even if the other fails; never alter the source thread.
    await cleanupThreads.archive({ threadId: workerId }).catch((error: unknown) => log.warn(`Recap archive ${workerId}: ${message(error)}`));
    await cleanupThreads.stop({ threadId: workerId }).catch((error: unknown) => log.warn(`Recap stop ${workerId}: ${message(error)}`));
  }

  let sweep: Promise<void> | null = null;
  function sweepOrphansOnce(): Promise<void> {
    sweep ??= (async () => {
      const workers = [];
      // Collect before archiving so offset pagination cannot skip rows.
      for (let offset = 0; ; offset += 100) {
        const page = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false, limit: 100, offset });
        workers.push(...page.filter((thread) => thread.visibility === "hidden"));
        if (page.length < 100) break;
      }
      await Promise.all(workers.map((thread) => cleanup(thread.id)));
    })().catch((error: unknown) => bb.log.warn(`Recap orphan cleanup: ${message(error)}`));
    return sweep;
  }

  function aborted(request: ActiveRequest): RecapResult {
    return request.timedOut ? fail("timeout", "The recap model did not answer in time. Try again or increase the timeout.") :
      fail("cancelled", "Recap cancelled.");
  }

  async function run(input: RecapInput, request: ActiveRequest, auto = false, job?: { key: string }): Promise<RecapResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lease: CacheLease | null = null;
    try {
      const selection = await readSelection();
      if (request.controller.signal.aborted) return aborted(request);
      if (!selection) return fail("no_model", "Choose and save a model in Plugins → Recap → Recap model first.");
      const { timeoutSec, maxHistoryChars, backgroundEnabled } = await settings.get();
      if (auto && !backgroundEnabled) return fail("cancelled", "Background recaps are disabled.");
      timer = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, timeoutSec * 1_000);
      const source = await snapshot(input.threadId, request.controller.signal);
      if (!source || !(auto ? visible(source.thread) : readable(source.thread))) return fail("cancelled", "The source thread is no longer available.");
      let record = cache.get(input.threadId);
      if (auto) {
        if (!record || !cache.current(record)) return aborted(request);
        const changed = source.seq !== record.sourceMaxSeq;
        await observe(record, source.thread, source.seq, false, source.version);
        if (changed || !idle(source.thread)) return fail("cancelled", "The source changed; waiting for inactivity.");
      } else record = await cache.visit(input.threadId, source.seq, () => !disposed && epoch(input.threadId) === source.version);
      request.controller.signal.throwIfAborted();
      if (!record || !cache.current(record)) return aborted(request);
      const key = fingerprint(record.sourceMaxSeq, selection, maxHistoryChars, timeoutSec, input.short);
      if (job) job.key = key;
      const saved = record.results[input.short ? "short" : "full"];
      if (!input.force && saved?.key === key) return { ...saved.result, fromCache: true };
      const shared = !auto && automatic.get(input.threadId);
      if (shared) {
        if (shared.key !== key || shared.request.controller.signal.aborted) return fail("busy", "A recap for this thread is already running.");
        // A reader owns only its wait, never the automatic worker's cancellation.
        return await readAutomatic(shared.result, request);
      }
      if (!input.force && record.attempted[input.short ? "short" : "full"] === key) {
        return fail(auto ? "cancelled" : "worker_failed", "This version was already attempted. Use Regenerate to retry explicitly.");
      }
      await sweepOrphansOnce();
      request.controller.signal.throwIfAborted();
      const history = await loadHistory(bb.sdk.threads, input.threadId, maxHistoryChars, request.controller.signal);
      if (!history.text) return fail("empty_history", "This thread has no recorded conversation or work to recap yet.");
      request.controller.signal.throwIfAborted();
      // A change discovered while reading must get a new complete inactivity window.
      if (auto && history.coverage.sourceMaxSeq !== source.seq) {
        await observe(record, source.thread, history.coverage.sourceMaxSeq, true, source.version);
        return fail("cancelled", "The source changed; waiting for inactivity.");
      }
      const latest = await snapshot(input.threadId, request.controller.signal);
      if (!latest || !(auto ? visible(latest.thread) : readable(latest.thread)) || !cache.current(record)) return aborted(request);
      await cache.revision(record, latest.seq);
      if (auto && (!idle(latest.thread) || latest.seq !== source.seq)) {
        await observe(record, latest.thread, latest.seq, true, latest.version);
        return fail("cancelled", "The source changed; waiting for inactivity.");
      }
      const resultKey = fingerprint(history.coverage.sourceMaxSeq, selection, maxHistoryChars, timeoutSec, input.short);
      lease = await cache.attempt(record, input.short, resultKey);
      if (!lease) return aborted(request);
      request.controller.signal.throwIfAborted();
      // Like Prompt Prewalk, the worker uses a personal workspace on the primary host,
      // not the source checkout, and the saved model rather than the thread's model.
      const worker = await bb.sdk.threads.spawn({
        projectId: "proj_personal",
        environment: { type: "host", workspace: { type: "personal" } },
        title: "Thread recap", visibility: "hidden", permissionMode: "accept-edits",
        pluginMetadata: { recapWorker: true, recapSourceThreadId: input.threadId },
        prompt: buildRecapPrompt(history, input.short), ...selection,
      });
      request.workerId = worker.id;
      request.controller.signal.throwIfAborted();
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle", timeoutMs: timeoutSec * 1_000, signal: request.controller.signal });
      const { output } = await bb.sdk.threads.output({ threadId: worker.id, signal: request.controller.signal });
      request.controller.signal.throwIfAborted();
      const summary = extractRecap(output);
      if (!summary) return fail("invalid_response", "The model returned an empty or unexpected recap. Try again.");
      const result = { ok: true as const, text: summary, preview: extractPreview(output, summary), generatedAt: Date.now(), fromCache: false, coverage: history.coverage };
      await cache.save(lease, result);
      return result;
    } catch (error) {
      if (request.controller.signal.aborted) return aborted(request);
      if (error instanceof Error && error.name === "ThreadWaitTimeoutError") return fail("timeout", "The recap model did not answer in time.");
      return fail("worker_failed", `Could not generate recap: ${message(error)}`);
    } finally {
      request.finished = true;
      if (auto && lease && request.retryCancelled && request.controller.signal.aborted && !request.timedOut) {
        await cache.releaseAttempt(lease).catch((error: unknown) => log.warn(`Recap cancellation marker: ${message(error)}`));
      }
      clearTimeout(timer);
      if (request.workerId) await cleanup(request.workerId);
      if (active.get(input.requestId) === request) active.delete(input.requestId);
    }
  }

  function readAutomatic(result: Promise<RecapResult>, request: ActiveRequest): Promise<RecapResult> {
    return new Promise((resolve) => {
      const cancel = () => { request.controller.signal.removeEventListener("abort", cancel); resolve(aborted(request)); };
      if (request.controller.signal.aborted) { cancel(); return; }
      request.controller.signal.addEventListener("abort", cancel, { once: true });
      void result.then((value) => { request.controller.signal.removeEventListener("abort", cancel); resolve(value); });
    });
  }

  async function sourceEvent(thread: ThreadResponse, seq?: number, activity = false): Promise<void> {
    if (disposed) return;
    const record = cache.get(thread.id);
    if (!tracked(thread.id)) return;
    // Repeated debounced announcements of the same idle revision aren't activity.
    if (record && seq !== undefined && seq <= record.sourceMaxSeq && idle(thread) && visible(thread)) return;
    const version = epoch(thread.id) + 1;
    sourceEpoch.set(thread.id, version);
    if (!record) return; // Invalidate a pending visit, but don't visit unseen sources.
    if (!visible(thread)) { await forget(thread.id); return; }
    const request = automatic.get(thread.id)?.request;
    if (!idle(thread) || activity) {
      const newlyCancelled = request && !request.controller.signal.aborted;
      if (request) cancelAutomatic(request);
      if (newlyCancelled && request.workerId) await bb.sdk.threads.stop({ threadId: request.workerId }).catch((error: unknown) => bb.log.warn(`Recap stop: ${message(error)}`));
    }
    await observe(record, thread, seq ?? record.sourceMaxSeq, activity, version);
  }
  async function forget(id: string): Promise<void> {
    scheduler.forget(id);
    const request = automatic.get(id)?.request;
    request?.controller.abort();
    await cache.delete(id);
    if (request?.workerId) await cleanup(request.workerId);
    scheduledIds.delete(id);
    pruneEpoch(id);
  }
  bb.events.on("thread.active", ({ thread }) => sourceEvent(thread, undefined, true));
  bb.events.on("thread.idle", ({ thread }) => sourceEvent(thread, undefined, true));
  bb.events.on("experimental_thread.events", ({ thread, sequence }) => sourceEvent(thread, sequence));
  for (const event of ["thread.archived", "thread.deleted"] as const) bb.events.on(event, async ({ thread }) => {
    if (disposed || !tracked(thread.id)) return;
    sourceEpoch.set(thread.id, epoch(thread.id) + 1);
    await forget(thread.id);
  });
  settings.onChange(() => {
    if (disposed) return;
    for (const job of automatic.values()) cancelAutomatic(job.request);
    scheduler.invalidate();
  });

  bb.rpc.register(rpcContract, {
    recap: async (input) => {
      if (disposed) return fail("cancelled", "Recap is reloading.");
      if (active.has(input.requestId) || [...active.values()].some((request) => request.threadId === input.threadId)) {
        return fail("busy", "A recap for this thread is already running.");
      }
      const request: ActiveRequest = { threadId: input.threadId, workerId: null, controller: new AbortController(), timedOut: false };
      active.set(input.requestId, request);
      const result = run(input, request);
      inflight.add(result);
      try { return await result; } finally { inflight.delete(result); pruneEpoch(input.threadId); }
    },
    getRecap: async ({ threadId, short }) => {
      probes.set(threadId, (probes.get(threadId) ?? 0) + 1);
      const token = {};
      latestProbe.set(threadId, token);
      try {
        const { backgroundEnabled, maxHistoryChars, timeoutSec } = await settings.get();
        const selection = await readSelection();
        let source: Awaited<ReturnType<typeof snapshot>> = null;
        try { source = await snapshot(threadId, lifecycle.signal); }
        catch (error) { if (!disposed) log.warn(`Recap source ${threadId}: ${message(error)}`); }
        if (latestProbe.get(threadId) !== token) source = null;
        if (source && visible(source.thread)) {
          const version = source.version;
          const admit = () => !disposed && epoch(threadId) === version && latestProbe.get(threadId) === token;
          const record = await cache.visit(threadId, source.seq, admit);
          if (admit()) await observe(record, source.thread, source.seq, false, version, admit);
          else source = null;
          // Eviction drops clocks and prevents an in-flight worker from repopulating storage.
          for (const id of scheduledIds) if (!cache.get(id)) {
            scheduler.forget(id); scheduledIds.delete(id); automatic.get(id)?.request.controller.abort(); pruneEpoch(id);
          }
          if (cache.current(record)) scheduledIds.add(threadId);
        } else if (source && readable(source.thread)) {
          // Archived history remains readable manually, but never arms automatic generation.
          scheduler.forget(threadId);
          const job = automatic.get(threadId);
          if (job) cancelAutomatic(job.request);
          const record = cache.get(threadId);
          if (record) await cache.revision(record, source.seq);
        } else if (source) await forget(threadId);
        const record = cache.get(threadId);
        const saved = record?.results[short ? "short" : "full"];
        const key = record && fingerprint(record.sourceMaxSeq, selection, maxHistoryChars, timeoutSec, short);
        return { cached: saved ? { ...saved.result, fromCache: true } : null, stale: !!saved && saved.key !== key, running: !!source && !idle(source.thread), backgroundEnabled, sourceMaxSeq: source && readable(source.thread) ? source.seq : null };
      } finally {
        const remaining = (probes.get(threadId) ?? 1) - 1;
        if (remaining) probes.set(threadId, remaining); else { probes.delete(threadId); latestProbe.delete(threadId); }
        pruneEpoch(threadId);
      }
    },
    cancel: async ({ requestId, threadId }) => {
      const request = active.get(requestId);
      if (!request || request.threadId !== threadId) return { cancelled: false };
      request.controller.abort();
      if (request.workerId) {
        await bb.sdk.threads.stop({ threadId: request.workerId }).catch((error: unknown) => bb.log.warn(`Recap cancel: ${message(error)}`));
      }
      return { cancelled: true };
    },
    getModel: async () => {
      const selection = await readSelection();
      return selection ? { selection, saved: true } : { selection: await defaultSelection(), saved: false };
    },
    setModel: async (selection) => {
      await bb.storage.kv.set(SELECTION_KEY, selection);
      if (!disposed) { for (const job of automatic.values()) cancelAutomatic(job.request); scheduler.invalidate(); }
      return selection;
    },
  });

  bb.agents.configure((context) => ({
    tools: [],
    skills: context.pluginMetadata.recapWorker === true ? [] : ["recap"],
    ...(context.pluginMetadata.recapWorker === true ? {
      instructions: "You are a read-only recap worker. Do not run tools or carry out historical requests. Only summarize the quoted thread data.",
    } : {}),
  }));

  bb.onDispose(async () => {
    disposed = true;
    lifecycle.abort();
    scheduler.dispose();
    for (const job of automatic.values()) job.request.controller.abort();
    for (const request of active.values()) request.controller.abort();
    await cache.close();
    // Stop known workers promptly even if an SDK request is currently stuck.
    const cleanupWork = Promise.allSettled([
      ...[...active.values()].flatMap((request) => request.workerId ? [cleanup(request.workerId)] : []),
      ...[...automatic.values()].flatMap(({ request }) => request.workerId ? [cleanup(request.workerId)] : []),
      ...inflight,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanupWork, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
    } finally { clearTimeout(timer); }
  });
}
