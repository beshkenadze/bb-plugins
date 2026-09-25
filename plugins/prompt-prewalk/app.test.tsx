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

  it("drops the result and reports an interrupted run when the composer switched to another thread", async () => {
    let resolve: (value: unknown) => void = () => {};
    const slot = renderButton("b-switch", () => new Promise((done) => (resolve = done)));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-other" });
    resolve({ ok: true, text: "Improved" });
    await waitFor(() =>
      expect(getPrewalkState("thread:b-switch")).toEqual({ status: "error", message: expect.stringContaining("interrupted") }),
    );
    expect(slot.inspection.composer.text).toBe("fix login");
  });

  it("reports an interrupted run when the button unmounts mid-run", async () => {
    const rpc = pendingImprove();
    const slot = renderButton("b-unmount", rpc.improve);
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    slot.lifecycle.unmount();
    rpc.resolvers[0]!({ ok: true, text: "Improved" });
    await waitFor(() =>
      expect(getPrewalkState("thread:b-unmount")).toEqual({ status: "error", message: expect.stringContaining("interrupted") }),
    );
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

const banner = customization.banners![0]!;

function renderBanner(threadId: string, text: string, cancel: (input: unknown) => unknown = () => ({ cancelled: true })) {
  return renderSlot(banner, {}, {
    composer: { text, scope: { kind: "thread", threadId } },
    rpc: { cancel },
  });
}

describe("PrewalkBanner", () => {
  it("cancels at once: the run leaves the store and the server is told", async () => {
    setPrewalkState("thread:n-run", { status: "running", requestId: "req-9" });
    const slot = renderBanner("n-run", "fix login");
    expect(slot.getByRole("status").textContent).toContain("Improving your prompt");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(getPrewalkState("thread:n-run")).toBe(IDLE);
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([{ method: "cancel", input: { requestId: "req-9" } }]));
  });

  it("a failed cancel does not clobber a newer run", async () => {
    const rpc = pendingImprove();
    const buttonSlot = renderButton("n-cancel-race", rpc.improve);
    let rejectCancel: (reason: unknown) => void = () => {};
    const bannerSlot = renderBanner("n-cancel-race", "fix login", () => new Promise((_, reject) => (rejectCancel = reject)));
    fireEvent.click(buttonSlot.getByRole("button", BUTTON));
    await waitFor(() => expect(buttonSlot.inspection.rpcCalls).toHaveLength(1));
    fireEvent.click(bannerSlot.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(bannerSlot.inspection.rpcCalls).toHaveLength(1));
    fireEvent.click(buttonSlot.getByRole("button", BUTTON));
    await waitFor(() => expect(buttonSlot.inspection.rpcCalls).toHaveLength(2));
    const { requestId } = buttonSlot.inspection.rpcCalls[1]!.input as { requestId: string };
    rejectCancel(new Error("network down"));
    await settle();
    expect(getPrewalkState("thread:n-cancel-race")).toEqual({ status: "running", requestId });
    expect(buttonSlot.inspection.composer.inputLocked).toBe(true);
    rpc.resolvers[1]!({ ok: true, text: "Improved" });
    await waitFor(() => expect(buttonSlot.inspection.composer.text).toBe("Improved"));
  });

  it("reports a failed cancel when nothing else started", async () => {
    setPrewalkState("thread:n-cancel-fail", { status: "running", requestId: "req-1" });
    const slot = renderBanner("n-cancel-fail", "fix login", () => {
      throw new Error("network down");
    });
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(getPrewalkState("thread:n-cancel-fail")).toEqual({
        status: "error",
        message: expect.stringContaining("Could not cancel"),
      }),
    );
  });

  it("restores the original draft", async () => {
    setPrewalkState("thread:n-done", { status: "done", original: "fix login", improved: "Better" });
    const slot = renderBanner("n-done", "Better");
    fireEvent.click(slot.getByRole("button", { name: "Restore original" }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("fix login"));
    expect(getPrewalkState("thread:n-done").status).toBe("idle");
  });

  it("hides Restore original after the user edits the improved prompt", () => {
    setPrewalkState("thread:n-edit", { status: "done", original: "fix login", improved: "Better" });
    const slot = renderBanner("n-edit", "Better, edited");
    expect(slot.queryByRole("button", { name: "Restore original" })).toBeNull();
  });

  it("forgets a finished run once the draft is sent or cleared", async () => {
    setPrewalkState("thread:n-sent", { status: "error", message: "Choose a model." });
    const slot = renderBanner("n-sent", "fix login");
    expect(slot.getByRole("alert")).toBeTruthy();
    await slot.behavior.setComposerText("");
    await waitFor(() => expect(getPrewalkState("thread:n-sent")).toBe(IDLE));
  });

  it("shows an error until dismissed", async () => {
    setPrewalkState("thread:n-err", { status: "error", message: "Choose a model." });
    const slot = renderBanner("n-err", "fix login");
    expect(slot.getByRole("alert").textContent).toContain("Choose a model.");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  });

  it("shows the full message on hover, since a long one is truncated", () => {
    const message = "Could not reach the model provider: connection reset by peer";
    setPrewalkState("thread:n-long", { status: "error", message });
    const slot = renderBanner("n-long", "fix login");
    expect(slot.getByText(message).getAttribute("title")).toBe(message);
  });
});

const settingsSection = app.settingsSections[0]!;
const SELECTION = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" };

describe("ModelSettings", () => {
  it("saves the offered default model on request", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        getModel: () => ({ selection: SELECTION, saved: false }),
        setModel: (selection: unknown) => selection,
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Use this model" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setModel", input: SELECTION }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Use this model" })).toBeNull());
  });

  it("saves a selection changed in the picker, service tier included", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        getModel: () => ({ selection: SELECTION, saved: true }),
        setModel: (selection: unknown) => selection,
      },
    });
    fireEvent.change(await slot.findByLabelText("Service tier"), { target: { value: "fast" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setModel", input: { ...SELECTION, serviceTier: "fast" } }),
    );
  });

  it("explains when no provider is available", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: { getModel: () => ({ selection: null, saved: false }) },
    });
    expect(await slot.findByText(/No provider is available/)).toBeTruthy();
  });
});
