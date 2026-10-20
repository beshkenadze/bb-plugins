// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelReveal, revealProject, useSidebarMount } from "./sidebar";

function renderSidebar(): HTMLElement {
  const body = document.createElement("div");
  body.dataset.testid = "app-sidebar-body";
  body.innerHTML = `<div data-testid="app-sidebar-top-reserve-row"></div><div data-sidebar="content"></div><div data-testid="sidebar-footer-row"></div>`;
  document.body.append(body);
  return body;
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))));

const project = (id: string, isPersonal = false) => ({ id, isPersonal });
const listOf = (sidebar: HTMLElement) => sidebar.querySelector<HTMLElement>('[data-sidebar="content"]')!;

/** An element `offset` px below the top of `list` at scrollTop 0, appended to `parent`. */
function place(list: Element, attribute: [string, string], offset: number, parent: Element = list) {
  const element = document.createElement("div");
  element.setAttribute(...attribute);
  vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 270, 800));
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 100 + offset - list.scrollTop, 270, 300));
  parent.append(element);
  return element;
}
const placeGroup = (list: Element, projectId: string, offset: number, parent?: Element) =>
  place(list, ["data-sidebar-project-id", projectId], offset, parent);

afterEach(() => {
  cancelReveal();
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("revealProject", () => {
  it("scrolls bb's thread list so the project's group starts at its top", async () => {
    const list = listOf(renderSidebar());
    placeGroup(list, "proj_a", 900);
    revealProject(project("proj_a"));
    await frames();
    expect(list.scrollTop).toBe(900);
  });

  it("leaves the sticky stack's top padding free, as bb's own layout does", async () => {
    const list = listOf(renderSidebar());
    const stack = document.createElement("div");
    stack.setAttribute("data-sidebar-sticky-stack", "");
    stack.style.paddingTop = "8px";
    list.append(stack);
    placeGroup(list, "proj_a", 900, stack);
    revealProject(project("proj_a"));
    await frames();
    expect(list.scrollTop).toBe(892);
  });

  it("scrolls to bb's Threads section for the personal project, which has no group", async () => {
    const list = listOf(renderSidebar());
    placeGroup(list, "proj_personal", 300);
    place(list, ["data-sidebar-visibility-group", "threads"], 1500);
    revealProject(project("proj_personal", true));
    await frames();
    expect(list.scrollTop).toBe(1500);
  });

  it("waits for bb to render the group after navigation", async () => {
    const list = listOf(renderSidebar());
    revealProject(project("proj_a"));
    await frames();
    placeGroup(list, "proj_a", 400);
    await frames();
    expect(list.scrollTop).toBe(400);
  });

  it("lets a newer reveal replace one that is still waiting", async () => {
    const list = listOf(renderSidebar());
    revealProject(project("proj_a"));
    await frames();
    placeGroup(list, "proj_b", 600);
    revealProject(project("proj_b"));
    await frames();
    placeGroup(list, "proj_a", 200);
    await frames();
    expect(list.scrollTop).toBe(600);
  });

  it("does nothing once cancelled", async () => {
    const list = listOf(renderSidebar());
    revealProject(project("proj_a"));
    cancelReveal();
    placeGroup(list, "proj_a", 400);
    await frames();
    await frames();
    expect(list.scrollTop).toBe(0);
  });

  it("ignores groups outside the app sidebar's list", async () => {
    const list = listOf(renderSidebar());
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    placeGroup(elsewhere, "proj_a", 700);
    revealProject(project("proj_a"));
    await frames();
    expect(list.scrollTop).toBe(0);
  });

  it("stops waiting when the project never shows up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
      renderSidebar();
      revealProject(project("proj_missing"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useSidebarMount", () => {
  it("places its node directly above the sidebar's thread list", () => {
    const sidebar = renderSidebar();
    const { result } = renderHook(() => useSidebarMount());
    const mount = result.current;
    expect(mount).not.toBeNull();
    expect(mount!.parentElement).toBe(sidebar);
    expect(mount!.nextElementSibling).toBe(sidebar.querySelector('[data-sidebar="content"]'));
  });

  it("waits for a sidebar that renders later", async () => {
    const { result } = renderHook(() => useSidebarMount());
    expect(result.current!.isConnected).toBe(false);
    const sidebar = renderSidebar();
    await flush();
    expect(result.current!.parentElement).toBe(sidebar);
  });

  it("follows the sidebar when bb remounts it", async () => {
    const first = renderSidebar();
    const { result } = renderHook(() => useSidebarMount());
    const mount = result.current!;
    first.remove();
    await flush();
    expect(mount.isConnected).toBe(false);
    const second = renderSidebar();
    await flush();
    expect(result.current).toBe(mount);
    expect(mount.nextElementSibling).toBe(second.querySelector('[data-sidebar="content"]'));
  });

  it("stays put above the list when bb inserts its own row there", async () => {
    const sidebar = renderSidebar();
    const { result } = renderHook(() => useSidebarMount());
    const content = sidebar.querySelector('[data-sidebar="content"]')!;
    const banner = document.createElement("div");
    content.before(banner);
    await flush();
    expect(result.current!.parentElement).toBe(sidebar);
    expect(result.current!.nextElementSibling).toBe(banner);
  });

  it("settles when another copy anchors above the same list", async () => {
    const sidebar = renderSidebar();
    const content = sidebar.querySelector('[data-sidebar="content"]')!;
    const before = Element.prototype.before;
    let moves = 0;
    Element.prototype.before = function guardedBefore(this: Element, ...nodes: (Node | string)[]) {
      if (++moves > 50) throw new Error("runaway re-placement");
      before.apply(this, nodes);
    };
    try {
      const first = renderHook(() => useSidebarMount());
      const second = renderHook(() => useSidebarMount());
      await flush();
      await flush();
      expect(moves).toBeLessThanOrEqual(2);
      for (const node of [first.result.current!, second.result.current!]) {
        expect(node.parentElement).toBe(sidebar);
        expect(node.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
    } finally {
      Element.prototype.before = before;
    }
  });

  it("ignores sidebar content outside the app sidebar", () => {
    const settings = document.createElement("div");
    settings.innerHTML = `<div data-sidebar="content"></div>`;
    document.body.append(settings);
    const { result } = renderHook(() => useSidebarMount());
    expect(result.current!.isConnected).toBe(false);
  });

  it("removes its node and stops following the sidebar on unmount", async () => {
    renderSidebar();
    const { result, unmount } = renderHook(() => useSidebarMount());
    const mount = result.current!;
    unmount();
    expect(mount.isConnected).toBe(false);
    renderSidebar();
    await flush();
    expect(mount.isConnected).toBe(false);
  });
});
