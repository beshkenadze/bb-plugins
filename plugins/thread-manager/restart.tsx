import { useEffect, useRef, useState } from "react";
import { experimental_useSidebarThreads, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function RestartThreadAction(props: PluginThreadHeaderActionProps) {
  // A split header or route change must never inherit another thread's operation.
  return <RestartThreadButton key={props.threadId} {...props} />;
}

function RestartThreadButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const sdk = useSdk();
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((candidate) => candidate.id === threadId);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  async function restart() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      // Use the header's explicit id, even when a different pane owns the composer.
      const current = await sdk.threads.get({ threadId });
      if (current.archivedAt !== null) throw new Error("Restore this archived thread before restarting its agent.");
      if (current.runtime.displayStatus === "waiting-for-host") throw new Error("Connect this thread's machine before restarting its agent.");
      if (current.status === "stopping") throw new Error("The agent is still stopping. Wait for it to finish, then try again.");

      // BB releases the runtime while retaining the provider conversation.
      // The next user message resumes it; do not fabricate or resend a prompt.
      await sdk.threads.stop({ threadId });
      const stopped = await sdk.threads.get({ threadId });
      if ((stopped.status !== "idle" && stopped.status !== "error") ||
        (stopped.runtime.displayStatus !== "idle" && stopped.runtime.displayStatus !== "error")) {
        throw new Error("BB has not confirmed that the agent stopped. Check the thread's status before trying again.");
      }
      if (live.current) toast.success("Agent ready to restart", {
        description: "Your next message resumes this thread with its existing history.",
      });
    } catch (cause) {
      if (live.current) toast.error("Could not restart agent", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <span title="Restart the agent on your next message. Stops current work and keeps this thread's history and draft.">
    <Button type="button" variant="ghost" size="sm" className={isCompactViewport ? "size-7 p-0" : "h-7 gap-1.5 px-2 text-xs"}
      aria-label="Restart agent" aria-busy={busy} disabled={busy || thread?.isArchived || thread?.status === "stopping"}
      onClick={() => { void restart(); }}>
      <Icon name="RotateCw" aria-hidden="true" className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
      {!isCompactViewport ? <span>{busy ? "Restarting…" : "Restart"}</span> : null}
    </Button>
  </span>;
}
