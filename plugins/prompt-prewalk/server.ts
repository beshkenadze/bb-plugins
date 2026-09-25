import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildWorkerPrompt,
  collectHistory,
  extractPrompt,
  MAX_DRAFT_CHARS,
  type HistoryMessage,
} from "./worker";

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
    input: z.union([
      z.object({ ...draftFields, threadId: z.string().min(1) }).strict(),
      z.object({ ...draftFields, projectId: z.string().min(1) }).strict(),
    ]),
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

type ImproveInput = z.infer<(typeof rpcContract)["improve"]["input"]>;
type ImproveResult = z.infer<(typeof rpcContract)["improve"]["output"]>;
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

interface WorkerTarget {
  projectId: string;
  environment: SpawnArgs["environment"];
  history: HistoryMessage[];
}

const fail = (code: ImproveErrorCode, message: string): ImproveResult => ({ ok: false, code, message });

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

  async function resolveTarget(input: ImproveInput, historyMessages: number): Promise<WorkerTarget> {
    if (!("threadId" in input)) {
      return { projectId: input.projectId, environment: { type: "project-default" }, history: [] };
    }
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    const history =
      historyMessages > 0
        ? collectHistory((await bb.sdk.threads.timeline({ threadId: input.threadId })).rows, historyMessages)
        : [];
    return {
      projectId: thread.projectId,
      environment:
        thread.environmentId === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId: thread.environmentId },
      history,
    };
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
    const selection = await readSelection();
    if (selection === null) return fail("no_model", "Choose a pre-walk model in the Prompt Prewalk settings.");
    const { historyMessages, timeoutSec, extraInstructions } = await settings.get();
    const target = await resolveTarget(input, historyMessages);
    const worker = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      prompt: buildWorkerPrompt({ draft: input.text, history: target.history, extraInstructions }),
      title: "Prompt pre-walk",
      visibility: "hidden",
      permissionMode: "accept-edits",
      pluginMetadata: { prewalk: true },
      ...selection,
    });
    try {
      return await awaitWorker(worker.id, timeoutSec);
    } finally {
      await disposeWorker(worker.id);
    }
  }

  bb.rpc.register(rpcContract, {
    improve,
    cancel: () => ({ cancelled: false }),
    getModel: async () => {
      const saved = await readSelection();
      return saved === null ? { selection: await defaultSelection(), saved: false } : { selection: saved, saved: true };
    },
    setModel: async (selection) => {
      await bb.storage.kv.set(SELECTION_KEY, selection);
      return selection;
    },
  });
}
