// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { getPrewalkState, IDLE, setMentionCount, setPrewalkState } from "./prewalk-store";

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

  it("is disabled for a blank draft", () => {
    const slot = renderButton("b-blank", () => ({ ok: true, text: "x" }), "   ");
    expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true);
  });

  it("is disabled while the draft has @-mentions", async () => {
    const slot = renderButton("b-mention", () => ({ ok: true, text: "x" }));
    setMentionCount("thread:b-mention", 1);
    await waitFor(() => expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true));
  });

  it("works in a new-thread composer without a thread or a project", () => {
    const slot = renderSlot(button, {}, {
      composer: { text: "fix login", scope: { kind: "new-thread", projectId: null } },
      rpc: { improve: () => ({ ok: true, text: "x" }) },
    });
    fireEvent.click(slot.getByRole("button", BUTTON));
    expect(slot.inspection.rpcCalls[0]?.input).toEqual({ requestId: expect.any(String), text: "fix login" });
  });
});
