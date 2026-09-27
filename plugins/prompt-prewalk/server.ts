import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { buildWorkerPrompt, collectHistory, extractPrompt, MAX_DRAFT_CHARS } from "./worker";

const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);

const selectionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema,
    serviceTier: z.enum(["default", "fast"]).optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof selectionSchema>;

const improveErrorCodeSchema = z.enum(["no_model", "timeout", "worker_failed", "invalid_response", "cancelled"]);
export type ImproveErrorCode = z.infer<typeof improveErrorCodeSchema>;

const requestIdSchema = z.string().min(1).max(100);

const draftFields = {
  requestId: requestIdSchema,
  text: z.string().trim().min(1).max(MAX_DRAFT_CHARS),
};

export const rpcContract = defineRpcContract({
  improve: {
    input: z.object({ ...draftFields, threadId: z.string().min(1).optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), text: z.string() }),
      z.object({ ok: z.literal(false), code: improveErrorCodeSchema, message: z.string() }),
    ]),
  },
  cancel: {
    input: z.object({ requestId: requestIdSchema }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  getModel: {
    input: z.null(),
    output: z.object({ selection: selectionSchema.nullable(), saved: z.boolean() }),
  },
  setModel: { input: selectionSchema, output: selectionSchema },
});

const SELECTION_KEY = "selection";
const PERSONAL_PROJECT_ID = "proj_personal";

type ImproveInput = z.infer<(typeof rpcContract)["improve"]["input"]>;
type ImproveResult = z.infer<(typeof rpcContract)["improve"]["output"]>;

interface ActiveRequest {
  workerId: string | null;
  cancelled: boolean;
}

const fail = (code: ImproveErrorCode, message: string): ImproveResult => ({ ok: false, code, message });
const CANCELLED = fail("cancelled", "Pre-walk cancelled.");
/** Upper bound on how long dispose waits for worker cleanup and in-flight requests, so a hung call cannot block a reload. */
const DISPOSE_WAIT_MS = 10_000;

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    historyMessages: {
      type: "number",
      label: "History messages",
      description: "How many recent thread messages the pre-walk model sees. 0 turns history off.",
      default: 6,
      experimental_schema: z.number().int().min(0).max(50),
    },
    timeoutSec: {
      type: "number",
      label: "Timeout (seconds)",
      description: "How long to wait for the pre-walk model.",
      default: 120,
      experimental_schema: z.number().int().min(10).max(900),
    },
    extraInstructions: {
      type: "string",
      label: "Extra instructions",
      description: "Your own rules for rewriting prompts. They are appended to the built-in rules.",
      default: "",
      experimental_multiline: true,
    },
  });

  const active = new Map<string, ActiveRequest>();
  const inflight = new Set<Promise<ImproveResult>>();

  async function readSelection(): Promise<ModelSelection | null> {
    const parsed = selectionSchema.safeParse(await bb.storage.kv.get(SELECTION_KEY));
    return parsed.success ? parsed.data : null;
  }

  async function catalog(providerId: string) {
    try {
      return (await bb.sdk.providers.models({ providerId })).models;
    } catch (error) {
      bb.log.warn(`model catalog for ${providerId} failed: ${errorMessage(error)}`);
      return [];
    }
  }

  async function defaultSelection(): Promise<ModelSelection | null> {
    for (const provider of await bb.sdk.providers.list()) {
      if (!provider.available) continue;
      const models = await catalog(provider.id);
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (model !== undefined) {
        return { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
      }
    }
    return null;
  }

  async function disposeWorker(threadId: string): Promise<void> {
    await bb.sdk.threads
      .archive({ threadId })
      .catch((error: unknown) => bb.log.warn(`archive ${threadId} failed: ${errorMessage(error)}`));
    await bb.sdk.threads
      .stop({ threadId })
      .catch((error: unknown) => bb.log.warn(`stop ${threadId} failed: ${errorMessage(error)}`));
  }

  let sweep: Promise<void> | null = null;

  /** bb.sdk is unavailable while the plugin loads, so the sweep runs before the first request. */
  function sweepOrphansOnce(): Promise<void> {
    sweep ??= (async () => {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false });
      await Promise.all(threads.filter((thread) => thread.visibility === "hidden").map((thread) => disposeWorker(thread.id)));
    })().catch((error: unknown) => bb.log.warn(`orphan sweep failed: ${errorMessage(error)}`));
    return sweep;
  }

  async function awaitWorker(workerId: string, timeoutSec: number): Promise<ImproveResult> {
    try {
      await bb.sdk.threads.wait({ threadId: workerId, status: "idle", timeoutMs: timeoutSec * 1000 });
    } catch (error) {
      if (errorName(error) === "ThreadWaitTimeoutError") {
        return fail("timeout", `The pre-walk model did not answer within ${timeoutSec} s.`);
      }
      if (errorName(error) === "ThreadWaitUnreachableError") {
        return fail("worker_failed", "The pre-walk worker failed. Check the model in the plugin settings.");
      }
      throw error;
    }
    const { output } = await bb.sdk.threads.output({ threadId: workerId });
    const text = extractPrompt(output);
    return text === null ? fail("invalid_response", "The pre-walk model returned an unexpected answer.") : { ok: true, text };
  }

  async function improve(input: ImproveInput): Promise<ImproveResult> {
    const run = runImprove(input);
    inflight.add(run);
    try {
      return await run;
    } finally {
      inflight.delete(run);
    }
  }

  async function runImprove(input: ImproveInput): Promise<ImproveResult> {
    const request: ActiveRequest = { workerId: null, cancelled: false };
    active.set(input.requestId, request);
    try {
      await sweepOrphansOnce();
      const selection = await readSelection();
      if (selection === null) return fail("no_model", "Choose a pre-walk model in the Prompt Prewalk settings.");
      const { historyMessages, timeoutSec, extraInstructions } = await settings.get();
      const history =
        input.threadId !== undefined && historyMessages > 0
          ? collectHistory((await bb.sdk.threads.timeline({ threadId: input.threadId })).rows, historyMessages)
          : [];
      if (request.cancelled) return CANCELLED;
      const worker = await bb.sdk.threads.spawn({
        projectId: PERSONAL_PROJECT_ID,
        environment: { type: "host", workspace: { type: "personal" } },
        prompt: buildWorkerPrompt({ draft: input.text, history, extraInstructions }),
        title: "Prompt pre-walk",
        visibility: "hidden",
        permissionMode: "accept-edits",
        pluginMetadata: { prewalk: true },
        ...selection,
      });
      request.workerId = worker.id;
      if (request.cancelled) return CANCELLED;
      const result = await awaitWorker(worker.id, timeoutSec);
      return request.cancelled ? CANCELLED : result;
    } catch (error) {
      if (request.cancelled) return CANCELLED;
      throw error;
    } finally {
      if (active.get(input.requestId) === request) active.delete(input.requestId);
      if (request.workerId !== null) await disposeWorker(request.workerId);
    }
  }

  bb.rpc.register(rpcContract, {
    improve,
    cancel: async ({ requestId }) => {
      const request = active.get(requestId);
      if (request === undefined) return { cancelled: false };
      request.cancelled = true;
      const { workerId } = request;
      if (workerId !== null) {
        await bb.sdk.threads
          .stop({ threadId: workerId })
          .catch((error: unknown) => bb.log.warn(`stop ${workerId} failed: ${errorMessage(error)}`));
      }
      return { cancelled: true };
    },
    getModel: async () => {
      const saved = await readSelection();
      return saved === null ? { selection: await defaultSelection(), saved: false } : { selection: saved, saved: true };
    },
    setModel: async (selection) => {
      await bb.storage.kv.set(SELECTION_KEY, selection);
      return selection;
    },
  });

  bb.onDispose(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DISPOSE_WAIT_MS);
    });
    const requests = [...active.values()];
    active.clear();
    const cleanup = (async () => {
      await Promise.all(
        requests.map(async (request) => {
          request.cancelled = true;
          const { workerId } = request;
          request.workerId = null;
          if (workerId !== null) await disposeWorker(workerId);
        }),
      );
      // A spawn still in flight resolves into a cancelled request, whose own cleanup must run while bb is valid.
      await Promise.allSettled([...inflight]);
    })();
    try {
      await Promise.race([cleanup, deadline]);
    } finally {
      clearTimeout(timer);
    }
  });
}
