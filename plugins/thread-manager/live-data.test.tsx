// @vitest-environment jsdom
// The SDK harness keeps one thread snapshot per mount; these tests swap it to
// cover threads and sections that change while the page is open.
import { createElement } from "react";
import type { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projects, sections, thread } from "./test/fixtures";

type Snapshot = ReturnType<typeof experimental_useSidebarThreads>;
const live = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...await importOriginal<typeof import("@get-bb/plugin-sdk/app")>(),
  experimental_useSidebarThreads: () => live.snapshot,
}));

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
afterEach(cleanup);
function snapshot(patch: Partial<Snapshot>): Snapshot {
  return { status: "ready", threads: [], projects, sections, experimental_archived: null, ...patch } as Snapshot;
}
function mount(first: Snapshot, update = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }))) {
  live.snapshot = first;
  const slot = renderSlot(panel, { subPath: "" }, { sidebarThreads: first, sdk: { threads: { update } } });
  return { slot, update, refresh(next: Snapshot) { live.snapshot = next; slot.lifecycle.rerender(createElement(panel.component, { subPath: "" })); } };
}

describe("Thread Manager with changing data", () => {
  it("stops filtering by a provider once its last thread is gone", () => {
    const { slot, refresh } = mount(snapshot({ threads: [thread("Codex"), thread("Pi", { providerId: "pi" })] }));
    fireEvent.change(slot.getByRole("combobox", { name: "Provider" }), { target: { value: "pi" } });
    expect(slot.queryByRole("button", { name: "Actions for Codex" })).toBeNull();
    refresh(snapshot({ threads: [thread("Codex")] }));
    expect((slot.getByRole("combobox", { name: "Provider" }) as HTMLSelectElement).value).toBe("");
    expect(slot.getByRole("button", { name: "Actions for Codex" })).toBeTruthy();
  });
  it("does not move a thread into a section deleted while the dialog is open", async () => {
    const { slot, update, refresh } = mount(snapshot({ threads: [thread("Filed", { sectionId: "later" })] }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "Actions for Filed" }), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Move to section" }));
    refresh(snapshot({ threads: [thread("Filed")], sections: [] }));
    expect((slot.getByRole("combobox", { name: "Destination section" }) as HTMLSelectElement).value).toBe("");
    expect(slot.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(slot.getByRole("combobox", { name: "Destination section" }).closest("form")!);
    await waitFor(() => expect(slot.getByRole("dialog")).toBeTruthy());
    expect(update).not.toHaveBeenCalled();
  });
});
