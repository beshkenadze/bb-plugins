# Prompt Prewalk

A bb plugin that improves a draft prompt before you send it. Press the pre-walk button in the composer: a model you chose for pre-walk rewrites the draft to be clearer and more actionable, and the result replaces the draft. Edit it and send as usual.

## How it works

- The button works in a thread and in a new-thread composer, with or without a selected project. In a thread, the model also sees the last few messages.
- Each run spawns a hidden "Prompt pre-walk" thread in bb's personal project. It runs in a fresh, empty personal workspace with the `accept-edits` permission mode, never in your checkout.
- The plugin archives and stops the worker after every run, on cancel, and when the plugin unloads; bb then deletes its workspace. Before the first run after a load, the plugin sweeps workers orphaned by a crash.
- The result replaces the draft only if you did not edit the draft during the run; otherwise the banner explains why. **Cancel** in the banner stops a run, and **Restore original** stays available while the draft still equals the improved text.

## Install

```
cd plugins/prompt-prewalk
npm install
bb plugin install path:$PWD
```

Then open Settings → Installed plugins → Prompt Prewalk → **Pre-walk model** and pick a provider, model, reasoning level, and service tier. Pre-walk stays off until you save a model: pick one, or press **Use this model** to keep the suggested default.

## Settings

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `historyMessages` | 6 | 0–50 | Recent thread messages the model sees; 0 turns history off. Each message is cut to 2,000 characters. |
| `timeoutSec` | 120 | 10–900 | Seconds to wait for the model. |
| `extraInstructions` | empty | multiline text | Your own rules, appended to the built-in ones. |

```
bb plugin config prompt-prewalk
bb plugin config prompt-prewalk set historyMessages 10
bb plugin config prompt-prewalk set extraInstructions "List acceptance criteria at the end."
bb plugin config prompt-prewalk unset historyMessages
```

The plugin reads these settings at the start of each run.

## Development

```
npm install
npm test
npm run typecheck
bb plugin build
```

After editing sources, run `bb plugin reload prompt-prewalk`.

- `server.ts` — RPC methods (`improve`, `cancel`, `getModel`, `setModel`), settings, and the worker lifecycle.
- `worker.ts` — the worker prompt, thread history, and answer parsing.
- `app.tsx` — the composer button, the status banner, and the model settings section.
- `prewalk-store.ts` — per-composer run state shared by the button and the banner.
- `skills/prompt-prewalk/SKILL.md` — tells agents in bb about the plugin and its hidden threads.

## Limits

- Drafts with @-mentions: the button stays disabled, because a rewrite would turn mentions into plain text.
- Drafts over 20,000 characters are not supported.
- The model gets only the draft and recent thread messages, not your repository.
- Each run starts a full agent on the chosen provider, so it takes seconds, not milliseconds.
