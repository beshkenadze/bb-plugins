import { useEffect, useState } from "react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";

// bb has no slot above its sidebar thread list, so the switcher anchors to the
// app sidebar's markup. If a bb update renames these, the switcher stays
// detached (invisible) instead of breaking the sidebar.
const LIST = '[data-sidebar="content"]';
const SIDEBAR_LIST = `[data-testid="app-sidebar-body"] > ${LIST}`;
const REVEAL_WAIT_MS = 2_000;

/**
 * A node kept above bb's sidebar thread list, following the sidebar across
 * remounts. It is detached while no app sidebar is rendered.
 */
export function useSidebarMount(): HTMLElement | null {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const node = document.createElement("div");
    node.setAttribute("data-project-switcher", "");
    // Anywhere above the list counts as placed, so another node kept in front of
    // the list (a second copy of this plugin, say) cannot start a move-war.
    let list: Element | null = null;
    const place = () => {
      if (!list?.isConnected) list = document.querySelector(SIDEBAR_LIST);
      if (list === null) node.remove();
      else if (node.parentElement !== list.parentElement || !(node.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)) list.before(node);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    setMount(node);
    return () => {
      observer.disconnect();
      node.remove();
    };
  }, []);
  return mount;
}

let cancelPending = () => {};

/** Stops a reveal that is still waiting for bb's list. */
export function cancelReveal(): void {
  cancelPending();
  cancelPending = () => {};
}

/**
 * Scrolls bb's sidebar thread list so the project's group starts at its top;
 * bb lists the personal project's threads in its Threads section instead. bb's
 * list does not follow navigation and renders the opened thread's group on a
 * later frame, so this waits briefly for it. A newer reveal replaces a waiting one.
 */
export function revealProject(project: Pick<PluginSidebarProject, "id" | "isPersonal">): void {
  cancelReveal();
  const selector = project.isPersonal
    ? '[data-sidebar-visibility-group="threads"]'
    : `[data-sidebar-project-id="${CSS.escape(project.id)}"]`;
  const reveal = (): boolean => {
    const list = document.querySelector(SIDEBAR_LIST);
    const target = list?.querySelector(selector);
    if (!list || !target) return false;
    // Keep the room bb leaves above its first group, or the group's sticky headers cover its first row.
    const stack = target.closest("[data-sidebar-sticky-stack]");
    const inset = stack ? Number.parseFloat(getComputedStyle(stack).paddingTop) || 0 : 0;
    list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - inset;
    return true;
  };
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (reveal()) return;
      const observer = new MutationObserver(() => {
        if (reveal()) cancelReveal();
      });
      const timer = setTimeout(cancelReveal, REVEAL_WAIT_MS);
      observer.observe(document.body, { childList: true, subtree: true });
      cancelPending = () => {
        observer.disconnect();
        clearTimeout(timer);
      };
    });
  });
  cancelPending = () => cancelAnimationFrame(frame);
}

/** bb hands an opened thread to the sidebar list only; close its phone drawer the way a tap outside does. */
export function closeMobileSidebar(): void {
  document.querySelector<HTMLElement>('[data-sidebar-mobile-backdrop][data-state="open"]')?.click();
}
