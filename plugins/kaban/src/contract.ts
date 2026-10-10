// Host RPC contract shared by server.ts (caller) and host.ts (implementation).
//
// The host entry is deliberately thin: it runs the user's installed `kaban`
// CLI inside a board root on the machine that owns the project checkout, and
// watches `.kaban/` for changes. All parsing and business rules stay on the
// server, where they are unit-testable with the fake plugin host.
import { defineRpcContract, type ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** An absolute POSIX or Windows path to a directory that holds (or will hold) `.kaban/`. */
const absoluteRoot = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), "root must be absolute");

export const hostContract = defineRpcContract({
  run: {
    input: z
      .object({
        root: absoluteRoot,
        /** Executable plus fixed prefix args, e.g. ["kaban"] or ["bunx", "@kaban-board/cli"]. */
        command: z.array(z.string().min(1).max(1024)).min(1).max(8),
        args: z.array(z.string().max(8192)).max(64),
        /** Value for KABAN_AGENT (who is acting); null keeps the CLI default. */
        agent: z.string().min(1).max(64).nullable(),
        timeoutMs: z.number().int().min(1_000).max(25_000),
      })
      .strict(),
    output: z
      .object({
        exitCode: z.number().int(),
        stdout: z.string(),
        stderr: z.string(),
        /** Set when the process could not start at all (ENOENT, EACCES, timeout). */
        spawnError: z.string().nullable(),
      })
      .strict(),
  },
  probe: {
    input: z.object({ root: absoluteRoot }).strict(),
    output: z
      .object({
        rootExists: z.boolean(),
        boardExists: z.boolean(),
        /** `<root>/.git` exists (a directory, or a file in linked worktrees). */
        isGitRepo: z.boolean(),
      })
      .strict(),
  },
  watch: {
    input: z.object({ root: absoluteRoot }).strict(),
    output: z.object({ watching: z.boolean(), error: z.string().nullable() }).strict(),
  },
});

export const hostSignals = {
  /** The board files under `<root>/.kaban` changed (debounced, deduplicated by fingerprint). */
  boardChanged: { payload: z.object({ root: z.string() }).strict() },
} satisfies ExperimentalHostSignals;

export type HostRunInput = z.infer<(typeof hostContract)["run"]["input"]>;
export type HostRunOutput = z.infer<(typeof hostContract)["run"]["output"]>;
