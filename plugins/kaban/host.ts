// bb-plugin-kaban — host entry (`bb.host`).
//
// Runs on the machine that owns a project checkout (any enrolled host, not
// just the server). It does two things only:
//   1. `run`   — execute the user's installed kaban CLI in a board root.
//   2. `watch` — observe `<root>/.kaban` and emit `boardChanged` signals so
//                open boards refresh when the TUI, an agent, or a script
//                changes tasks outside BB.
// Parsing and business rules live on the server (src/kaban-client.ts).
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  type ExperimentalHostRpcContext,
  experimental_defineHostEntry,
} from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./src/contract.js";

/** Host RPC output is capped at 8 MiB; keep the CLI's output comfortably below. */
const MAX_OUTPUT_BYTES = 6 * 1024 * 1024;
/** A watch lives this long after the last `watch` call (open boards renew it). */
const WATCH_TTL_MS = 10 * 60_000;
const WATCH_SWEEP_MS = 60_000;
/**
 * Files whose size/mtime define "the board changed". Readers only touch -shm;
 * an empty WAL counts as absent (kaban's open-time checkpoint recreates it).
 */
const FINGERPRINT_FILES = ["board.db", "board.db-wal", "config.json"] as const;

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

interface WatchEntry {
  expiresAt: number;
  fingerprint: string;
  dispose: () => Promise<void>;
}

const watches = new Map<string, WatchEntry>();
const pendingWatches = new Map<string, Promise<{ watching: boolean; error: string | null }>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function boardFingerprint(kabanDir: string): Promise<string> {
  const parts = await Promise.all(
    FINGERPRINT_FILES.map(async (name) => {
      try {
        const info = await stat(path.join(kabanDir, name));
        // An empty WAL holds no data; checkpoints recreate it with a new mtime.
        if (name === "board.db-wal" && info.size === 0) return `${name}:empty`;
        return `${name}:${info.size}:${info.mtimeMs}`;
      } catch {
        // A missing WAL and an empty one mean the same: no pending frames.
        return name === "board.db-wal" ? `${name}:empty` : `${name}:-`;
      }
    }),
  );
  return parts.join("|");
}

async function disposeAllWatches(): Promise<void> {
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  const entries = [...watches.values()];
  watches.clear();
  await Promise.allSettled(entries.map((entry) => entry.dispose()));
}

function ensureSweep(lifecycle: AbortSignal): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [root, entry] of watches) {
      if (entry.expiresAt > now) continue;
      watches.delete(root);
      void entry.dispose().catch(() => undefined);
    }
    if (watches.size === 0 && sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, WATCH_SWEEP_MS);
  lifecycle.addEventListener("abort", () => void disposeAllWatches(), { once: true });
}

async function startWatch(root: string, context: Context) {
  const kabanDir = path.join(root, ".kaban");
  if (!(await isDirectory(kabanDir))) return { watching: false, error: null };
  const entry: WatchEntry = {
    expiresAt: Date.now() + WATCH_TTL_MS,
    fingerprint: await boardFingerprint(kabanDir),
    dispose: async () => undefined,
  };
  try {
    const subscription = await context.experimental_watch(
      { rootPath: kabanDir, ignoredPaths: ["board.db-shm"], debounceMs: 250, maxWaitMs: 1_500 },
      async (event) => {
        if (event.kind === "watch-error") return;
        const next = await boardFingerprint(kabanDir);
        if (event.kind === "changed" && next === entry.fingerprint) return;
        entry.fingerprint = next;
        await context.experimental_emitSignal("boardChanged", { root });
      },
    );
    entry.dispose = () => subscription.dispose();
  } catch (error) {
    return { watching: false, error: error instanceof Error ? error.message : String(error) };
  }
  watches.set(root, entry);
  ensureSweep(context.lifecycle.signal);
  return { watching: true, error: null };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    run: async ({ root, command, args, agent, timeoutMs }, context) => {
      if (!(await isDirectory(root))) {
        return { exitCode: -1, stdout: "", stderr: "", spawnError: `Board root does not exist: ${root}` };
      }
      const [file, ...prefix] = command;
      if (file === undefined) {
        return { exitCode: -1, stdout: "", stderr: "", spawnError: "Empty kaban command" };
      }
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
      // The CLI resolves the board from cwd; a stray KABAN_PATH would point elsewhere.
      delete env.KABAN_PATH;
      if (agent !== null) env.KABAN_AGENT = agent;
      return await new Promise((resolve) => {
        execFile(
          file,
          [...prefix, ...args],
          {
            cwd: root,
            env,
            timeout: timeoutMs,
            maxBuffer: MAX_OUTPUT_BYTES,
            signal: context.signal,
            windowsHide: true,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ exitCode: 0, stdout, stderr, spawnError: null });
              return;
            }
            const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            if (typeof code === "number") {
              resolve({ exitCode: code, stdout, stderr, spawnError: null });
              return;
            }
            const killed = (error as { killed?: boolean }).killed === true;
            const reason = killed
              ? `kaban timed out after ${timeoutMs} ms`
              : code === "ENOENT"
                ? `Command not found: ${file}`
                : error.message;
            resolve({ exitCode: -1, stdout, stderr, spawnError: reason });
          },
        );
      });
    },

    probe: async ({ root }) => ({
      rootExists: await isDirectory(root),
      boardExists: await isFile(path.join(root, ".kaban", "board.db")),
      isGitRepo: await exists(path.join(root, ".git")),
    }),

    watch: async ({ root }, context) => {
      const existing = watches.get(root);
      if (existing !== undefined) {
        existing.expiresAt = Date.now() + WATCH_TTL_MS;
        return { watching: true, error: null };
      }
      const pending = pendingWatches.get(root);
      if (pending !== undefined) return await pending;
      const started = startWatch(root, context).finally(() => pendingWatches.delete(root));
      pendingWatches.set(root, started);
      return await started;
    },
  },
  dispose: disposeAllWatches,
});
