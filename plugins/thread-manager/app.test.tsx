// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projects, sections, thread } from "./test/fixtures";

const app = await loadPluginApp(() => import("./app"));
const panel = app.navPanels[0]!;
afterEach(cleanup);
function mount(rows = [thread("One"), thread("Two", { projectId: "project-b" })], extra: Parameters<typeof renderSlot>[2] = {}) {
  return renderSlot(panel, { subPath: "" }, { sidebarThreads: { status: "ready", threads: rows, projects, sections }, ...extra });
}
function openMenu(slot: ReturnType<typeof mount>, title: string) {
  fireEvent.pointerDown(slot.getByRole("button", { name: `Actions for ${title}` }), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("Thread Manager", () => {
  it("registers a dedicated page without replacing the sidebar", () => {
    expect(panel).toMatchObject({ id: "threads", title: "Threads", path: "threads" });
    expect(app.threadLists).toHaveLength(0);
  });
  it("searches, opens through the host, and clears selection on scope changes", async () => {
    const slot = mount();
    fireEvent.click(slot.getByRole("checkbox", { name: "Select One" }));
    expect(slot.getByRole("toolbar")).toBeTruthy();
    fireEvent.change(slot.getByRole("combobox", { name: "Project" }), { target: { value: "project-b" } });
    expect(slot.queryByRole("toolbar")).toBeNull();
    expect(slot.queryByRole("link", { name: "One" })).toBeNull();
    fireEvent.click(slot.getByRole("link", { name: "Two" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "Two", options: undefined });
    fireEvent.change(slot.getByRole("searchbox"), { target: { value: "No match" } });
    expect(slot.queryByRole("link", { name: "Two" })).toBeNull();
  });
  it("selects only the current page and clears it on pagination", async () => {
    const slot = mount(Array.from({ length: 52 }, (_, index) => thread(`Thread-${String(index).padStart(2, "0")}`)));
    expect(slot.getAllByRole("link")).toHaveLength(50);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select this page" }));
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(slot.inspection.sidebarActionCalls.filter((call) => call.method === "setPinned")).toHaveLength(50));
    fireEvent.click(slot.getByRole("button", { name: "Next" }));
    expect(slot.getAllByRole("link")).toHaveLength(2);
    expect(slot.queryByRole("toolbar")).toBeNull();
  });
  it("moves selected threads using the exact public SDK contract", async () => {
    const update = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }));
    const slot = mount(undefined, { sdk: { threads: { update } } });
    fireEvent.click(slot.getByRole("checkbox", { name: "Select One" }));
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Move to section" }));
    fireEvent.change(slot.getByRole("combobox", { name: "Destination section" }), { target: { value: "later" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ threadId: "One", sectionId: "later" }));
    expect(update).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });
  it("starts a move from the threads' current section, not from No section", async () => {
    const update = vi.fn(async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }));
    const slot = mount([thread("Filed", { sectionId: "later" }), thread("Loose")], { sdk: { threads: { update } } });
    openMenu(slot, "Filed");
    fireEvent.click(await slot.findByRole("menuitem", { name: "Move to section" }));
    expect((slot.getByRole("combobox", { name: "Destination section" }) as HTMLSelectElement).value).toBe("later");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Select this page" }));
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Move to section" }));
    expect((slot.getByRole("combobox", { name: "Destination section" }) as HTMLSelectElement).value).toBe("");
    expect(slot.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(slot.getByRole("combobox", { name: "Destination section" }).closest("form")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(update).not.toHaveBeenCalled();
  });
  it("keeps only failed bulk moves selected and explains the failure", async () => {
    const slot = mount(undefined, { sdk: { threads: { update: async ({ threadId }) => {
      if (threadId === "Two") throw new Error("Offline");
      return makeThreadResponse({ id: threadId });
    } } } });
    fireEvent.click(slot.getByRole("checkbox", { name: "Select this page" }));
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Move to section" }));
    fireEvent.change(slot.getByRole("combobox", { name: "Destination section" }), { target: { value: "later" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.getAllByRole("alert")[0]?.textContent).toContain("1 failed: Offline"));
    expect(slot.getByRole("dialog")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.getByRole("checkbox", { name: "Select One" }).getAttribute("aria-checked")).toBe("false");
    expect(slot.getByRole("checkbox", { name: "Select Two" }).getAttribute("aria-checked")).toBe("true");
  });
  it("delegates archive and delete confirmations to the host", async () => {
    const slot = mount([thread("Parent")]);
    openMenu(slot, "Parent");
    fireEvent.click(await slot.findByRole("menuitem", { name: "Archive…" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "archive", threadId: "Parent" });
    openMenu(slot, "Parent");
    fireEvent.click(await slot.findByRole("menuitem", { name: "Delete…" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "requestDelete", threadId: "Parent" });
    expect(slot.inspection.sdkCalls).toEqual([]);
  });
  it("renames through the host and restores with the SDK", async () => {
    const unarchive = vi.fn(async () => ({ ok: true as const }));
    const slot = mount([thread("Old"), thread("Archived", { isArchived: true })], { sdk: { threads: { unarchive } } });
    openMenu(slot, "Old");
    fireEvent.click(await slot.findByRole("menuitem", { name: "Rename" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Thread title" }), { target: { value: "  New title  " } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.inspection.sidebarActionCalls).toContainEqual({ method: "rename", threadId: "Old", title: "New title" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    fireEvent.click(slot.getByRole("button", { name: "Archived" }));
    openMenu(slot, "Archived");
    fireEvent.click(await slot.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith({ threadId: "Archived" }));
  });
  it("loads more archived results without claiming full search coverage", async () => {
    const fetchNextPage = vi.fn(async () => {});
    const slot = mount([thread("Archived", { isArchived: true })], { sidebarThreads: {
      status: "ready", threads: [thread("Archived", { isArchived: true })], projects, sections,
      experimental_archived: { status: "ready", hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage },
    } });
    fireEvent.click(slot.getByRole("button", { name: "Archived" }));
    expect(slot.getByText("Search and counts cover loaded archived threads.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Load more archived threads" }));
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(1));
  });
});
