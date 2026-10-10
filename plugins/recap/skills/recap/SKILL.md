---
name: recap
description: Explain the Recap BB plugin: its automatic visited-thread summaries, compact banner, header dialog, saved results, independent provider/model settings, short mode, history coverage and worker lifecycle. Use when the user asks how to use or configure Recap.
---

# Recap

Recap is a BB UI plugin with optional background generation, not a slash command or a task for the main agent.

- The **Recap** button is in the thread header and defaults to a brief orientation, not a full-summary dialog.
- Set **Plugins → Recap → Recap model** and explicitly save a provider/model first. Selection uses BB's native picker and is independent of the thread's model.
- **Background recap** is enabled by default once a model is explicitly saved. Only visited normal threads are eligible, after three minutes of execution/history inactivity. Disable this setting for manual-only use.
- New execution activity or a settings change cancels unfinished automatic work and restarts the delay; actual failures/timeouts still require Regenerate for an unchanged version. Archived normal threads remain readable for manual Recap, not background generation.
- A compact banner above the thread composer shows the generated overview and update time. Details opens the saved summary; × dismisses that version. It is hidden while the main agent works, and older results are marked stale.
- Saved full/short results use the history/settings version; up to 100 visited-thread records/results persist across reload. This is distinct from provider prompt caching; do not duplicate the Prompt Cache plugin.
- The default uses the thread's language and approximately two plain-text sentences: topic/user goal, then current focus or stopping point. No bullets, headings, exhaustive decisions or work log.
- Enable **Detailed recap** and click **Regenerate** for the longer Context → Decisions → Done → Open / blocked → Next steps format. Regenerate forces a fresh snapshot; Copy copies the result. Cancel/close cancels a manually owned request, but does not cancel a background job the dialog merely joined.
- Recap reads paginated source-thread history, including command/tool outcomes and file-change paths. It never sends the result as a message to the source agent.
- History is bounded by the **History character budget** (default 100,000), 6,000 characters per message and 2,000 per work row, and 50 pages each of timeline and collapsed details. A warning shows clipping or incomplete coverage. Attachments and unsupported work-row types are not read.
- **Timeout (seconds)** defaults to 120. Worker creation is a normal BB SDK request; cancellation while creating waits for its id before stopping it.
- The saved provider processes included history in a hidden worker on the primary host's personal workspace, including for automatic summaries. The worker is archived and stopped afterward. Its archived transcript remains in BB's normal history; summaries are stored in bounded plugin storage, not source files or the main agent's context.
- History can contain sensitive tool inputs/output. Prompt-level read-only rules are not a new security sandbox or a provider-wide removal of tools.
- No Recap CLI, agent tool, or BB recurring automation is registered. Do not guess `bb recap` commands or launch extra workers yourself. Background generation is owned by the plugin; it reuses current results and does not repeatedly retry the same failed version.
