// @vitest-environment jsdom
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "./project-switcher";
import { cancelReveal } from "./sidebar";
import { project, thread } from "./test/fixtures";

const app = await loadPluginApp(() => import("./app"));
const overlay = app.appOverlays[0]!;

const projects = [project("proj_g", "gamma"), project("proj_a", "Alpha"), project("proj_b", "Beta")];
const threads = [
  thread("alpha-old", { projectId: "proj_a", latestAttentionAt: 1 }),
  thread("alpha-new", { projectId: "proj_a", latestAttentionAt: 2 }),
  thread("beta-only", { projectId: "proj_b" }),
];

function renderSidebar(): HTMLElement {
  const body = document.createElement("div");
  body.dataset.testid = "app-sidebar-body";
  body.innerHTML = `<div data-testid="app-sidebar-top-reserve-row"></div><div data-sidebar="content"></div>`;
  document.body.append(body);
  return body;
}

function mount(options: Parameters<typeof renderSlot>[2] = {}) {
  return renderSlot(overlay, {}, {
    sidebarThreads: { status: "ready", projects, threads },
    context: { projectId: "proj_b", threadId: "beta-only" },
    ...options,
  });
}

async function openSwitcher() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Switch project|Select a project/ }));
  });
  return screen.findByRole("listbox");
}

async function search(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByRole("combobox", { name: "Search projects" }), { target: { value: text } });
  });
}

const optionNames = (list: HTMLElement) => within(list).queryAllByRole("option").map((option) => option.textContent);

function withCompactViewport() {
  const matchMedia = vi.fn((query: string) => ({
    matches: query === "(max-width: 767px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("matchMedia", matchMedia);
}

afterEach(() => {
  cancelReveal();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("Project Switcher", () => {
  it("adds an app overlay and keeps the user's sidebar list", () => {
    expect(app.appOverlays).toHaveLength(1);
    expect(app.threadLists).toHaveLength(0);
  });

  it("shows the current project above the sidebar's thread list", () => {
    const sidebar = renderSidebar();
    mount();
    const trigger = screen.getByRole("button", { name: "Switch project (current: Beta)" });
    expect(trigger.textContent).toContain("Beta");
    const row = sidebar.querySelector("[data-project-switcher]")!;
    expect(row.contains(trigger)).toBe(true);
    expect(row.nextElementSibling).toBe(sidebar.querySelector('[data-sidebar="content"]'));
  });

  it("scopes the portaled row to the plugin so its styles apply outside the slot", () => {
    renderSidebar();
    mount({ pluginId: "project-switcher" });
    const scope = screen.getByRole("button", { name: /Switch project/ }).closest("[data-bb-plugin]")!;
    expect(scope.getAttribute("data-bb-plugin")).toBe("project-switcher");
    expect(scope.hasAttribute("data-bb-plugin-root")).toBe(true);
    expect(scope.closest("[data-project-switcher]")).not.toBeNull();
  });

  it("names the trigger by its visible text outside a project route", () => {
    renderSidebar();
    mount({ context: { projectId: null, threadId: null } });
    expect(screen.getByRole("button", { name: "Select a project" }).textContent).toContain("Select a project");
  });

  it("lists projects alphabetically in a named dialog and marks the current one", async () => {
    renderSidebar();
    mount();
    const list = await openSwitcher();
    expect(screen.getByRole("dialog", { name: "Projects" }).contains(list)).toBe(true);
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Alpha", "Beta", "gamma"]);
    expect(options[1]!.getAttribute("aria-current")).toBe("true");
    expect(options[0]!.hasAttribute("aria-current")).toBe(false);
  });

  it("narrows the list by project name only", async () => {
    renderSidebar();
    mount();
    const list = await openSwitcher();
    await search("ET");
    expect(optionNames(list)).toEqual(["Beta"]);
    await search("proj_");
    expect(optionNames(list)).toEqual([]);
    expect(screen.getByText("No projects found.")).toBeTruthy();
  });

  it("opens the selected project's first thread and closes the list", async () => {
    renderSidebar();
    const slot = mount();
    const list = await openSwitcher();
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: "Alpha" }));
    });
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toThread", threadId: "alpha-new" }]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("scrolls the sidebar to the chosen project's group", async () => {
    const list = renderSidebar().querySelector('[data-sidebar="content"]')!;
    const group = document.createElement("div");
    group.setAttribute("data-sidebar-project-id", "proj_a");
    list.append(group);
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 270, 800));
    vi.spyOn(group, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 100 + 1200 - list.scrollTop, 270, 300));
    mount();
    const options = await openSwitcher();
    await act(async () => {
      fireEvent.click(within(options).getByRole("option", { name: "Alpha" }));
    });
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
    expect(list.scrollTop).toBe(1200);
  });

  it("starts a new thread in a project that has none", async () => {
    renderSidebar();
    const slot = mount();
    const list = await openSwitcher();
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: "gamma" }));
    });
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toCompose", options: { projectId: "proj_g", focusPrompt: true } },
    ]);
  });

  it("closes bb's mobile sidebar drawer after navigating", async () => {
    renderSidebar();
    const backdrop = document.createElement("div");
    backdrop.setAttribute("data-sidebar-mobile-backdrop", "");
    backdrop.dataset.state = "open";
    const close = vi.fn();
    backdrop.addEventListener("click", close);
    document.body.append(backdrop);
    mount();
    const list = await openSwitcher();
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: "Beta" }));
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves a closed mobile drawer alone", async () => {
    renderSidebar();
    const backdrop = document.createElement("div");
    backdrop.setAttribute("data-sidebar-mobile-backdrop", "");
    backdrop.dataset.state = "closed";
    const close = vi.fn();
    backdrop.addEventListener("click", close);
    document.body.append(backdrop);
    mount();
    const list = await openSwitcher();
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: "Beta" }));
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("starts each phone-sized opening with an empty search", async () => {
    withCompactViewport();
    renderSidebar();
    mount();
    let list = await openSwitcher();
    await search("gam");
    await act(async () => {
      fireEvent.click(within(list).getByRole("option", { name: "gamma" }));
    });
    list = await openSwitcher();
    expect((screen.getByRole("combobox", { name: "Search projects" }) as HTMLInputElement).value).toBe("");
    expect(optionNames(list)).toEqual(["Alpha", "Beta", "gamma"]);
  });

  it("renders nothing while bb shows no sidebar", () => {
    mount();
    expect(screen.queryByRole("button", { name: /Switch project/ })).toBeNull();
  });
});

describe("ProjectSwitcher", () => {
  it("finds a project by its new name after a rename while the list is open", async () => {
    installTestPluginRuntime();
    const onSelect = vi.fn();
    const view = render(<ProjectSwitcher projects={[project("proj_a", "Alpha")]} activeProjectId={null} onSelect={onSelect} />);
    const list = await openSwitcher();
    view.rerender(<ProjectSwitcher projects={[project("proj_a", "Zulu")]} activeProjectId={null} onSelect={onSelect} />);
    await search("zul");
    expect(optionNames(list)).toEqual(["Zulu"]);
    await search("alp");
    expect(optionNames(list)).toEqual([]);
  });
});
