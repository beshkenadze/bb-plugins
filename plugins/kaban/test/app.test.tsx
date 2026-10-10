// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import type { BoardSnapshot, KabanTask } from "../src/model";

const target = { projectId: "proj_1", projectName: "Demo", hostId: "host_a", root: "/repo", via: "project-source" as const };

function task(overrides: Partial<KabanTask>): KabanTask {
  return {
    id: "01TASK0001",
    number: 1,
    title: "Task",
    description: null,
    columnId: "todo",
    position: 0,
    createdBy: "user",
    assignedTo: null,
    labels: [],
    dependsOn: [],
    blockedReason: null,
    dueDate: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const ready: BoardSnapshot = {
  state: "ready",
  target,
  status: {
    name: "Demo board",
    columns: [
      { id: "todo", name: "Todo", count: 1, wipLimit: null, isTerminal: false },
      { id: "in_progress", name: "In Progress", count: 1, wipLimit: 3, isTerminal: false },
      { id: "done", name: "Done", count: 0, wipLimit: null, isTerminal: true },
    ],
    blockedCount: 0,
    totalTasks: 2,
  },
  tasks: [
    task({ id: "01TASK0001", number: 1, title: "Write the README" }),
    task({ id: "01TASK0002", number: 2, title: "Wire the CLI", columnId: "in_progress", assignedTo: "codex" }),
  ],
  links: {
    "01TASK0002": [{ threadId: "thr_1", title: "Implement CLI", status: "active", archived: false }],
  },
};

describe("Kaban board page", () => {
  it("renders columns, cards, assignees, and linked threads for the project in the URL", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0];
    if (panel === undefined) throw new Error("no nav panel");
    const slot = renderSlot(panel, { subPath: "proj_1" }, {
      rpc: {
        projects_list: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
        board_get: () => ready,
      },
    });
    expect(await slot.findByText("Demo board")).toBeTruthy();
    expect(await slot.findByText("Write the README")).toBeTruthy();
    expect(await slot.findByText("Wire the CLI")).toBeTruthy();
    expect(await slot.findByText("codex")).toBeTruthy();
    expect(await slot.findByText("Implement CLI")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "board_get")).toBe(true);
    slot.lifecycle.unmount();
  });

  it("offers to create a board when the project has none", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0];
    if (panel === undefined) throw new Error("no nav panel");
    const slot = renderSlot(panel, { subPath: "proj_1" }, {
      rpc: {
        projects_list: () => ({ projects: [{ id: "proj_1", name: "Demo" }] }),
        board_get: (): BoardSnapshot => ({ state: "unavailable", target, code: "no_board", message: "No Kaban board in this project yet." }),
      },
    });
    expect(await slot.findByText("No Kaban board in this project yet.")).toBeTruthy();
    expect(await slot.findByText("Create board")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("redirects an empty subPath to a project", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panel = app.navPanels[0];
    if (panel === undefined) throw new Error("no nav panel");
    const slot = renderSlot(panel, { subPath: "" }, {
      rpc: { projects_list: () => ({ projects: [{ id: "proj_9", name: "Nine" }] }) },
    });
    await slot.findByText("Loading projects…");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain("proj_9");
    slot.lifecycle.unmount();
  });
});
