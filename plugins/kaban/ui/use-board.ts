// Board data for one scope, kept current by the server's "board-changed"
// signal, realtime reconnects, window focus, and a slow keep-alive poll that
// also renews the host-side file watch.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { BoardSnapshot } from "../src/model";
import type { rpcContract } from "../src/rpc";

export type Scope = { projectId: string | null; threadId: string | null };
export type KabanRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const KEEP_ALIVE_MS = 4 * 60_000;

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useBoard(scope: Scope | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const projectId = scope?.projectId ?? null;
  const threadId = scope?.threadId ?? null;

  const refetch = useCallback(() => {
    if (projectId === null && threadId === null) return;
    const id = ++requestId.current;
    setLoading(true);
    rpc.call("board_get", { scope: { projectId, threadId } }).then(
      (next) => {
        if (id !== requestId.current) return; // a newer request superseded this one
        setSnapshot(next);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (id !== requestId.current) return;
        setError(errorMessage(cause));
        setLoading(false);
      },
    );
  }, [rpc, projectId, threadId]);

  useEffect(() => {
    setSnapshot(null);
    setError(null);
    refetch();
  }, [refetch]);

  // Only refetch for our project; threads resolve their project after the first load.
  const boardProjectId = snapshot?.target?.projectId ?? projectId;
  useRealtime("board-changed", (payload: unknown) => {
    const changed = (payload as { projectId?: unknown } | null)?.projectId;
    if (typeof changed !== "string" || boardProjectId === null || changed === boardProjectId) refetch();
  });

  // Signals are not replayed: reconcile after a reconnect (not the first connect).
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection !== "connected") return;
    if (wasConnected.current) refetch();
    wasConnected.current = true;
  }, [connection, refetch]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(onVisible, KEEP_ALIVE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [refetch]);

  return { rpc, snapshot, setSnapshot, error, loading, refetch };
}
