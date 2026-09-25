---
name: prompt-prewalk
description: Explains the Prompt Prewalk plugin — the composer button that rewrites a draft prompt with a separately chosen model, its settings, and its hidden "Prompt pre-walk" worker threads.
---

# Prompt Prewalk

The user can press the pre-walk button in the composer. A separately chosen model then rewrites the draft prompt, and the result replaces the draft before the user sends it. The button works in a thread and in a new-thread composer, with or without a selected project. In a thread, the model also sees the thread's recent messages.

## Hidden worker threads

Each run spawns one hidden thread titled "Prompt pre-walk" in bb's personal project. It runs in a fresh, empty personal workspace, never in the user's checkout. The plugin archives and stops it when the run ends, and bb removes the workspace on archive. Before the first run after a load, the plugin also sweeps workers left behind by a crash.

Do not message, resume, or reuse these threads.

## Settings

- Model: Settings → Installed plugins → Prompt Prewalk → "Pre-walk model". Pre-walk stays off until a model is saved. `bb plugin config` does not cover the model.
- `bb plugin config prompt-prewalk` shows the current settings.
- `bb plugin config prompt-prewalk set historyMessages <0-50>` sets how many recent thread messages the model sees (default 6, 0 turns history off).
- `bb plugin config prompt-prewalk set timeoutSec <10-900>` sets how many seconds to wait for the model (default 120).
- `bb plugin config prompt-prewalk set extraInstructions "<text>"` appends rules to the built-in rewrite rules.
- `bb plugin config prompt-prewalk unset <key>` returns a setting to its default.

## Limits

- The button is disabled for a blank draft, a draft over 20,000 characters, a draft with @-mentions (a rewrite would turn them into plain text), while a message is sending, and while a run is going. Its tooltip says why.
- The result replaces the draft only if the draft did not change during the run.
- Each run starts a full agent on the chosen provider, so it takes seconds, not milliseconds.
