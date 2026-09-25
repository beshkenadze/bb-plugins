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
  latestKey.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const blocker =
    view.draft.text.trim() === ""
      ? "Write a prompt first"
      : view.draft.text.length > MAX_DRAFT_CHARS
        ? `Prompts longer than ${MAX_DRAFT_CHARS} characters are not supported`
        : mentionCount > 0
          ? "Remove @-mentions first: pre-walk would turn them into plain text"
          : view.run.isSubmitting
            ? "Sending…"
            : state.status === "running"
              ? "Pre-walk is running"
              : null;

  async function run(): Promise<void> {
    if (blocker !== null) return;
    const original = composer.text;
    const requestId = crypto.randomUUID();
    setPrewalkState(key, { status: "running", requestId });
    composer.setInputLock(true);
    const result = await rpc
      .call("improve", { requestId, text: original, ...historyInput(view.scope) })
      .catch((error: unknown) => ({ ok: false as const, code: "rpc_error" as const, message: errorMessage(error) }));
    composer.setInputLock(false);
    const current = getPrewalkState(key);
    if (current.status !== "running" || current.requestId !== requestId) return; // cancelled from the banner
    if (!mounted.current || latestKey.current !== key) {
      setPrewalkState(key, IDLE);
      return;
    }
    if (result.ok) {
      composer.setText(result.text);
      setPrewalkState(key, { status: "done", original, improved: result.text });
    } else {
      setPrewalkState(key, result.code === "cancelled" ? IDLE : { status: "error", message: result.message });
    }
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

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prewalk",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "improve", component: PrewalkButton }],
    richText: {
      onDraftChange: (draft, view) => setMentionCount(scopeKey(view.scope), draft.mentions.length),
    },
  });
});
