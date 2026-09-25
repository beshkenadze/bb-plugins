import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_DRAFT_CHARS } from "./worker";

const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);

const selectionSchema = z
  .object({ providerId: z.string().min(1), model: z.string().min(1), reasoningLevel: reasoningLevelSchema })
  .strict();
export type ModelSelection = z.infer<typeof selectionSchema>;

const improveErrorCodeSchema = z.enum(["no_model", "timeout", "worker_failed", "invalid_response", "cancelled"]);
export type ImproveErrorCode = z.infer<typeof improveErrorCodeSchema>;

const draftFields = {
  requestId: z.string().min(1).max(100),
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
    input: z.object({ requestId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  getModel: {
    input: z.null(),
    output: z.object({ selection: selectionSchema.nullable(), saved: z.boolean() }),
  },
  setModel: { input: selectionSchema, output: selectionSchema },
});

const SELECTION_KEY = "selection";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  async function readSelection(): Promise<ModelSelection | null> {
    const parsed = selectionSchema.safeParse(await bb.storage.kv.get(SELECTION_KEY));
    return parsed.success ? parsed.data : null;
  }

  async function defaultSelection(): Promise<ModelSelection | null> {
    const provider = (await bb.sdk.providers.list()).find((candidate) => candidate.available);
    if (provider === undefined) return null;
    const { models } = await bb.sdk.providers.models({ providerId: provider.id });
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    return model === undefined
      ? null
      : { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
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
