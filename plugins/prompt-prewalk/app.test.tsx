// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { getMentionCount, getPrewalkState, IDLE, setMentionCount, setPrewalkState } from "./prewalk-store";
import { MAX_DRAFT_CHARS } from "./worker";

const app = await loadPluginApp(() => import("./app"));
const customization = app.composerCustomizations[0]!;
const button = customization.actions![0]!;
const BUTTON = { name: "Improve prompt with pre-walk" };

// Vitest globals are off, so Testing Library cannot register its own cleanup.
afterEach(cleanup);

function renderButton(
  threadId: string,
  improve: (input: unknown) => unknown,
  text = "fix login",
) {
  return renderSlot(button, {}, {
    composer: { text, scope: { kind: "thread", threadId } },
    rpc: { improve },
  });
}

/** An `improve` handler whose calls stay pending until the test resolves them, in call order. */
function pendingImprove() {
  const resolvers: Array<(value: unknown) => void> = [];
  return { improve: () => new Promise((done) => resolvers.push(done)), resolvers };
}

/** Lets a resolved RPC run to completion, for asserting that it changed nothing. */
async function settle(): Promise<void> {
  await act(() => new Promise((done) => setTimeout(done, 0)));
}

describe("PrewalkButton", () => {
  it("is registered for thread and new-thread composers", () => {
    expect(customization.scopes).toEqual(["thread", "new-thread"]);
  });

  it("replaces the draft with the improved prompt", async () => {
    const slot = renderButton("b-ok", () => ({ ok: true, text: "Fix the login bug in auth.ts" }));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Fix the login bug in auth.ts"));
    expect(slot.inspection.composer.inputLockCalls).toEqual([true, false]);
    expect(slot.inspection.rpcCalls[0]).toMatchObject({
      method: "improve",
      input: { text: "fix login", threadId: "b-ok" },
    });
    expect(getPrewalkState("thread:b-ok")).toEqual({
      status: "done",
      original: "fix login",
      improved: "Fix the login bug in auth.ts",
    });
  });

  it("keeps the draft and records the error when the server refuses", async () => {
    const slot = renderButton("b-err", () => ({ ok: false, code: "no_model", message: "Choose a model." }));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(getPrewalkState("thread:b-err")).toEqual({ status: "error", message: "Choose a model." }));
    expect(slot.inspection.composer.text).toBe("fix login");
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("records a failed RPC call as an error", async () => {
    const slot = renderButton("b-throw", () => {
      throw new Error("server down");
    });
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(getPrewalkState("thread:b-throw")).toEqual({ status: "error", message: "server down" }));
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("drops the result when the run was cancelled from the banner", async () => {
    let resolve: (value: unknown) => void = () => {};
    const slot = renderButton("b-cancel", () => new Promise((done) => (resolve = done)));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    act(() => setPrewalkState("thread:b-cancel", IDLE));
    resolve({ ok: true, text: "Improved" });
    await waitFor(() => expect(slot.inspection.composer.inputLocked).toBe(false));
    expect(slot.inspection.composer.text).toBe("fix login");
    expect(getPrewalkState("thread:b-cancel")).toBe(IDLE);
  });

  it("drops the result when the composer switched to another thread", async () => {
    let resolve: (value: unknown) => void = () => {};
    const slot = renderButton("b-switch", () => new Promise((done) => (resolve = done)));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-other" });
    resolve({ ok: true, text: "Improved" });
    await waitFor(() => expect(getPrewalkState("thread:b-switch").status).toBe("idle"));
    expect(slot.inspection.composer.text).toBe("fix login");
  });

  it("keeps text that changed while the run was in flight", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-edited", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setComposerText("fix login\n> quoted");
    rpc.resolvers[0]!({ ok: true, text: "Improved" });
    await waitFor(() => expect(getPrewalkState("thread:b-edited").status).not.toBe("running"));
    expect(slot.inspection.composer.text).toBe("fix login\n> quoted");
    expect(getPrewalkState("thread:b-edited")).toEqual({ status: "error", message: expect.stringContaining("changed") });
  });

  it("keeps edits made after returning to the thread", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-return", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-away" });
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-return" });
    await slot.behavior.setComposerText("fix login and tests");
    rpc.resolvers[0]!({ ok: true, text: "Improved" });
    await waitFor(() => expect(getPrewalkState("thread:b-return").status).not.toBe("running"));
    expect(slot.inspection.composer.text).toBe("fix login and tests");
  });

  it("a cancelled older run never unlocks a newer one", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-rerun", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    act(() => setPrewalkState("thread:b-rerun", IDLE));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    rpc.resolvers[0]!({ ok: false, code: "cancelled", message: "x" });
    await settle();
    expect(slot.inspection.composer.inputLocked).toBe(true);
    rpc.resolvers[1]!({ ok: true, text: "Improved" });
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Improved"));
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("cancel from the banner unlocks at once", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-unlock", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.composer.inputLocked).toBe(true));
    act(() => setPrewalkState("thread:b-unlock", IDLE));
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("re-locks the editor on returning to a thread whose run is still going", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-relock", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.composer.inputLocked).toBe(true));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-elsewhere" });
    expect(slot.inspection.composer.inputLocked).toBe(false);
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-relock" });
    expect(slot.inspection.composer.inputLocked).toBe(true);
  });

  it("re-checks @-mentions before writing", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-late-mention", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    act(() => setMentionCount("thread:b-late-mention", 1));
    rpc.resolvers[0]!({ ok: true, text: "Improved" });
    await waitFor(() => expect(getPrewalkState("thread:b-late-mention").status).not.toBe("running"));
    expect(slot.inspection.composer.text).toBe("fix login");
    expect(getPrewalkState("thread:b-late-mention")).toEqual({
      status: "error",
      message: expect.stringContaining("@-mentions"),
    });
  });

  it("wires richText.onDraftChange to the mention count", () => {
    customization.richText!.onDraftChange!(
      { text: "x", mentions: [{ from: 0, to: 1, provider: "p", id: "i", label: "x" }] },
      {
        scope: { kind: "thread", threadId: "w-1" },
        layout: "expanded",
        draft: { text: "x", isEmpty: false, attachmentCount: 0 },
        run: { isRunning: false, isSubmitting: false },
      },
    );
    expect(getMentionCount("thread:w-1")).toBe(1);
  });

  it("is disabled for a blank draft", () => {
    const slot = renderButton("b-blank", () => ({ ok: true, text: "x" }), "   ");
    expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true);
  });

  it("is disabled while the draft has @-mentions", async () => {
    const slot = renderButton("b-mention", () => ({ ok: true, text: "x" }));
    setMentionCount("thread:b-mention", 1);
    await waitFor(() => expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true));
  });

  it("is disabled for drafts over the size limit", () => {
    const slot = renderButton("b-long", () => ({ ok: true, text: "x" }), "a".repeat(MAX_DRAFT_CHARS + 1));
    expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true);
  });

  it("works in a new-thread composer without a thread or a project", async () => {
    const slot = renderSlot(button, {}, {
      composer: { text: "fix login", scope: { kind: "new-thread", projectId: null } },
      rpc: { improve: () => ({ ok: true, text: "x" }) },
    });
    fireEvent.click(slot.getByRole("button", BUTTON));
    expect(slot.inspection.rpcCalls[0]?.input).toStrictEqual({ requestId: expect.any(String), text: "fix login" });
    await waitFor(() => expect(getPrewalkState("new-thread").status).toBe("done"));
    act(() => setPrewalkState("new-thread", IDLE));
  });
});
