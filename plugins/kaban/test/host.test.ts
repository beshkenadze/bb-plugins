import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hostEntry from "../host.js";

describe("host entry", () => {
  let root: string;
  let listener: ExperimentalHostWatchListener | null;
  let watchCount: number;
  let harness: ReturnType<typeof experimental_createHostEntryHarness<typeof hostEntry.contract, NonNullable<typeof hostEntry.experimental_signals>>>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "kaban-host-")));
    listener = null;
    watchCount = 0;
    harness = experimental_createHostEntryHarness(hostEntry, {
      experimental_watch: (_options, onEvent) => {
        watchCount += 1;
        listener = onEvent;
        return { dispose: async () => undefined };
      },
    });
  });

  afterEach(async () => {
    await harness.experimental_dispose();
    rmSync(root, { recursive: true, force: true });
  });

  const node = (script: string) => ["node", "-e", script];

  it("runs the command in the board root with KABAN_AGENT and without KABAN_PATH", async () => {
    process.env.KABAN_PATH = "/elsewhere";
    try {
      const result = await harness.experimental_call("run", {
        root,
        command: node("console.log(JSON.stringify({cwd: process.cwd(), agent: process.env.KABAN_AGENT ?? null, path: process.env.KABAN_PATH ?? null, args: process.argv.slice(1)}))"),
        args: ["list", "--json", "--", "-dash"],
        agent: "codex",
        timeoutMs: 10_000,
      });
      expect(result.spawnError).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ cwd: root, agent: "codex", path: null, args: ["list", "--json", "--", "-dash"] });
    } finally {
      delete process.env.KABAN_PATH;
    }
  });

  it("returns non-zero exit codes with their output", async () => {
    const result = await harness.experimental_call("run", {
      root,
      command: node("console.log('{\"success\":false}'); process.exit(4)"),
      args: [],
      agent: null,
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ exitCode: 4, spawnError: null });
    expect(result.stdout.trim()).toBe('{"success":false}');
  });

  it("reports a missing executable and a missing root as spawn errors", async () => {
    const missing = await harness.experimental_call("run", {
      root,
      command: ["kaban-definitely-not-installed-xyz"],
      args: [],
      agent: null,
      timeoutMs: 10_000,
    });
    expect(missing.spawnError).toMatch(/Command not found/u);
    const noRoot = await harness.experimental_call("run", {
      root: path.join(root, "nope"),
      command: ["node"],
      args: [],
      agent: null,
      timeoutMs: 10_000,
    });
    expect(noRoot.spawnError).toMatch(/does not exist/u);
  });

  it("probes for a board and a git checkout", async () => {
    expect(await harness.experimental_call("probe", { root })).toEqual({ rootExists: true, boardExists: false, isGitRepo: false });
    mkdirSync(path.join(root, ".kaban"));
    writeFileSync(path.join(root, ".kaban", "board.db"), "");
    // Linked worktrees have a `.git` file rather than a directory.
    writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere");
    expect(await harness.experimental_call("probe", { root })).toEqual({ rootExists: true, boardExists: true, isGitRepo: true });
  });

  it("watches .kaban once, ignores reader-only events, and signals real changes", async () => {
    expect(await harness.experimental_call("watch", { root })).toEqual({ watching: false, error: null });
    const kabanDir = path.join(root, ".kaban");
    mkdirSync(kabanDir);
    writeFileSync(path.join(kabanDir, "board.db"), "v1");
    expect(await harness.experimental_call("watch", { root })).toEqual({ watching: true, error: null });
    expect(await harness.experimental_call("watch", { root })).toEqual({ watching: true, error: null });
    expect(watchCount).toBe(1);

    // A reader touched only -shm (or nothing we track): no signal.
    writeFileSync(path.join(kabanDir, "board.db-shm"), "x");
    await listener?.({ kind: "changed", changes: [{ path: "board.db-shm", type: "update" }] });
    expect(harness.experimental_getSignals()).toEqual([]);

    // kaban's open-time checkpoint recreates an empty WAL with a new mtime: no signal.
    writeFileSync(path.join(kabanDir, "board.db-wal"), "");
    await listener?.({ kind: "changed", changes: [{ path: "board.db-wal", type: "create" }] });
    expect(harness.experimental_getSignals()).toEqual([]);

    // A write grows the WAL: one signal.
    writeFileSync(path.join(kabanDir, "board.db-wal"), "frames");
    await listener?.({ kind: "changed", changes: [{ path: "board.db-wal", type: "create" }] });
    expect(harness.experimental_getSignals()).toHaveLength(1);
    expect(harness.experimental_getSignals()[0]).toMatchObject({ signal: "boardChanged", payload: { root } });
  });
});
