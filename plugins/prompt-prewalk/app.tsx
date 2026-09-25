import { useEffect, useRef } from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRpc,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { MAX_DRAFT_CHARS } from "./worker";
import {
  getMentionCount,
  getPrewalkState,
  IDLE,
  scopeKey,
  setMentionCount,
  setPrewalkState,
  useMentionCount,
  usePrewalkState,
} from "./prewalk-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const MENTIONS_BLOCKER = "Remove @-mentions first: pre-walk would turn them into plain text";

/**
 * The worker only needs a thread to read its history; a new-thread draft has none.
 * The key is omitted rather than undefined: rpc inputs must be JSON values.
 */
function historyInput(scope: PluginComposerScope): { threadId?: string } {
  return scope.kind === "thread" ? { threadId: scope.threadId } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PrewalkButton() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const state = usePrewalkState(key);
  const mentionCount = useMentionCount(key);
  const latestKey = useRef(key);
  useEffect(() => {
    latestKey.current = key;
  }, [key]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = state.status === "running";
  // `key` re-locks on return to a scope whose run is still going: the SDK drops the lock on a scope change.
  useEffect(() => {
    if (!running) return;
    composer.setInputLock(true);
    return () => composer.setInputLock(false);
  }, [composer, key, running]);

  const blocker =
    view.draft.text.trim() === ""
      ? "Write a prompt first"
      : view.draft.text.length > MAX_DRAFT_CHARS
        ? `Prompts longer than ${MAX_DRAFT_CHARS} characters are not supported`
        : mentionCount > 0
          ? MENTIONS_BLOCKER
          : view.run.isSubmitting
            ? "Sending…"
            : running
              ? "Pre-walk is running"
              : null;

  async function run(): Promise<void> {
    if (blocker !== null) return;
    const original = composer.text;
    const requestId = crypto.randomUUID();
    setPrewalkState(key, { status: "running", requestId });
    let result;
    try {
      result = await rpc.call("improve", { requestId, text: original, ...historyInput(view.scope) });
    } catch (error) {
      result = { ok: false as const, code: "rpc_error" as const, message: errorMessage(error) };
    }
    const current = getPrewalkState(key);
    if (current.status !== "running" || current.requestId !== requestId) return; // cancelled from the banner
    if (!mounted.current || latestKey.current !== key) {
      setPrewalkState(key, IDLE);
      return;
    }
    if (!result.ok) {
      setPrewalkState(key, result.code === "cancelled" ? IDLE : { status: "error", message: result.message });
      return;
    }
    // The mention count arrives debounced, so a mention typed just before the click is only seen now.
    if (getMentionCount(key) > 0) {
      setPrewalkState(key, { status: "error", message: MENTIONS_BLOCKER });
      return;
    }
    let applied = false;
    composer.updateText((now) => {
      if (now !== original) return now;
      applied = true;
      return result.text;
    });
    setPrewalkState(
      key,
      applied
        ? { status: "done", original, improved: result.text }
        : { status: "error", message: "The draft changed while pre-walk was running, so the result was not applied." },
    );
  }

  // The title sits on a wrapper: Button omits `title`, and a disabled Button has no pointer events.
  return (
    <span className="inline-flex" title={blocker ?? "Improve prompt with pre-walk"}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label="Improve prompt with pre-walk"
        disabled={blocker !== null}
        onClick={() => void run()}
      >
        <Icon name="AiContentGenerator01" className="size-4" />
      </Button>
    </span>
  );
}

function BannerRow(props: { text: string; action: string; onAction: () => void; role?: "status" | "alert" }) {
  return (
    <div
      role={props.role ?? "status"}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground"
    >
      <span className="min-w-0 truncate">{props.text}</span>
      <Button type="button" variant="ghost" size="sm" onClick={props.onAction}>
        {props.action}
      </Button>
    </div>
  );
}

function PrewalkBanner() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const state = usePrewalkState(key);
  const { isEmpty } = view.draft;
  useEffect(() => {
    // A sent or cleared draft ends the story: drop a lingering result or error.
    if (isEmpty && (state.status === "done" || state.status === "error")) setPrewalkState(key, IDLE);
  }, [isEmpty, key, state.status]);

  if (state.status === "running") {
    const cancel = () => {
      // Leaving "running" first makes PrewalkButton drop whatever the server returns for this request.
      setPrewalkState(key, IDLE);
      rpc
        .call("cancel", { requestId: state.requestId })
        .catch((error: unknown) =>
          setPrewalkState(key, { status: "error", message: `Could not cancel: ${errorMessage(error)}` }),
        );
    };
    return <BannerRow text="Improving your prompt…" action="Cancel" onAction={cancel} />;
  }
  if (state.status === "error") {
    return <BannerRow role="alert" text={state.message} action="Dismiss" onAction={() => setPrewalkState(key, IDLE)} />;
  }
  if (state.status === "done" && view.draft.text === state.improved) {
    const restore = () => {
      composer.setText(state.original);
      setPrewalkState(key, IDLE);
    };
    return <BannerRow text="Prompt improved." action="Restore original" onAction={restore} />;
  }
  return null;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prewalk",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "improve", component: PrewalkButton }],
    banners: [{ id: "status", chrome: "bare", component: PrewalkBanner }],
    richText: {
      onDraftChange: (draft, view) => setMentionCount(scopeKey(view.scope), draft.mentions.length),
    },
  });
});
