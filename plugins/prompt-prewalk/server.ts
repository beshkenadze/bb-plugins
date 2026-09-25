import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_DRAFT_CHARS } from "./worker";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
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

  bb.rpc.register(rpcContract, {
    improve: () => {
      throw new Error("not implemented");
    },
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
