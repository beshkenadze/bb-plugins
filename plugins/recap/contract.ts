import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const selectionSchema = z.object({
  providerId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]),
  serviceTier: z.string().min(1).max(100).optional(),
}).strict();
export type ModelSelection = z.infer<typeof selectionSchema>;

export const coverageSchema = z.object({
  totalEntries: z.number().int().nonnegative(),
  includedEntries: z.number().int().nonnegative(),
  omittedEntries: z.number().int().nonnegative(),
  shortenedEntries: z.number().int().nonnegative(),
  hasOlder: z.boolean(),
  sourceMaxSeq: z.number().int().nonnegative(),
});
export type Coverage = z.infer<typeof coverageSchema>;

export const recapSuccessSchema = z.object({
  ok: z.literal(true),
  text: z.string().min(1).max(30_000),
  coverage: coverageSchema,
  preview: z.string().min(1).max(400).optional(),
  generatedAt: z.number().int().nonnegative().optional(),
  fromCache: z.boolean().optional(),
});
export type SavedRecap = z.infer<typeof recapSuccessSchema>;

export const rpcContract = defineRpcContract({
  recap: {
    input: z.object({
      requestId: z.string().min(1).max(100),
      threadId: z.string().min(1).max(100),
      short: z.boolean().default(true),
      force: z.boolean().default(false),
    }).strict(),
    output: z.discriminatedUnion("ok", [
      recapSuccessSchema,
      z.object({
        ok: z.literal(false),
        code: z.enum(["no_model", "empty_history", "timeout", "worker_failed", "invalid_response", "cancelled", "busy"]),
        message: z.string(),
      }),
    ]),
  },
  getRecap: {
    input: z.object({ threadId: z.string().min(1).max(100), short: z.boolean().default(true) }).strict(),
    output: z.object({
      cached: recapSuccessSchema.nullable(),
      stale: z.boolean(),
      running: z.boolean(),
      backgroundEnabled: z.boolean(),
      sourceMaxSeq: z.number().int().nonnegative().nullable().optional(),
    }),
  },
  cancel: {
    input: z.object({ requestId: z.string().min(1).max(100), threadId: z.string().min(1).max(100) }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  getModel: {
    input: z.null(),
    output: z.object({ selection: selectionSchema.nullable(), saved: z.boolean() }),
  },
  setModel: { input: selectionSchema, output: selectionSchema },
});
export type RecapResult = z.infer<typeof rpcContract.recap.output>;
export type RecapInput = z.infer<typeof rpcContract.recap.input>;
export type RecapState = z.infer<typeof rpcContract.getRecap.output>;
