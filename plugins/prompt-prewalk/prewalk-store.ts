import { useSyncExternalStore } from "react";
import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";

export type PrewalkState =
  | { status: "idle" }
  | { status: "running"; requestId: string }
  | { status: "done"; original: string; improved: string }
  | { status: "error"; message: string };

export const IDLE: PrewalkState = { status: "idle" };

const states = new Map<string, PrewalkState>();
const mentionCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function scopeKey(scope: PluginComposerScope): string {
  switch (scope.kind) {
    case "thread":
      return `thread:${scope.threadId}`;
    case "new-thread":
      return "new-thread";
    case "queued-message":
      return `queued:${scope.queuedMessageId}`;
    case "side-chat":
      return `side-chat:${scope.tabId}`;
  }
}

export function getPrewalkState(key: string): PrewalkState {
  return states.get(key) ?? IDLE;
}

export function setPrewalkState(key: string, state: PrewalkState): void {
  if (state.status === "idle") states.delete(key);
  else states.set(key, state);
  notify();
}

export function getMentionCount(key: string): number {
  return mentionCounts.get(key) ?? 0;
}

export function setMentionCount(key: string, count: number): void {
  if (getMentionCount(key) === count) return;
  if (count === 0) mentionCounts.delete(key);
  else mentionCounts.set(key, count);
  notify();
}

export function usePrewalkState(key: string): PrewalkState {
  return useSyncExternalStore(subscribe, () => getPrewalkState(key));
}

export function useMentionCount(key: string): number {
  return useSyncExternalStore(subscribe, () => getMentionCount(key));
}
