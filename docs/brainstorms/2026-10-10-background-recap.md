# Background Recap

Date: 2026-10-10
Status: validated core behavior; compact banner is the stated default after the layout question was declined.

## Problem

User wants the existing Recap plugin to prepare summaries in the background and show a neat banner.
They selected background Recap (not new cache analytics), and only previously visited threads.
Prompt Cache already reports provider cache usage and must remain unchanged.

## Chosen behavior

- Opening a visible normal thread registers it as visited through a read-only/status RPC.
- Server prepares a full recap plus a <=400-character plain-text overview after the thread becomes
  idle and has had no history changes for 3 minutes. Never send to the main agent or alter its draft.
- Use the explicitly saved Recap model and existing hidden-worker timeout/cleanup policy.
- Do not launch a model request for unchanged cached history, or repeat failures for the same
  history/settings version. Limit automatic generation to one global job at a time.
- Persist at most 100 visited-thread records/results in plugin KV. Associate results with thread,
  source sequence, model selection, history budget, format and prompt version; separate short/full.
- Reconcile late history outcomes using the existing snapshot loader. Mark earlier summaries stale.
- Display a compact neutral banner above the thread composer: overview, updated time, Details, X.
  Hide while the main agent runs. X dismisses that summary until a new result replaces it.
- Details opens the saved full summary without another model request. Header Recap remains.
  Regenerate explicitly requests a fresh result; short mode remains available.
- When a foreground reader joins an automatic job, closing its dialog must not cancel that job.
- Background generation can be disabled in Recap settings. No model is selected automatically.

## SDK boundary

SDK 0.6.15 exposes thread.idle, thread.active, thread.deleted/archived, experimental_thread.events,
plugin KV, lifecycle disposal, and composer banners. No reliable server-side user-away event exists.
The selected policy uses visited-thread eligibility and execution/history inactivity, not inferred focus.
Mount/unmount and React StrictMode must never themselves spawn model workers.

## Verification

Baseline: 53 tests, typecheck pass. Add tests for idle delay/reset, unseen/hidden/active exclusion,
unchanged cache hits, settings invalidation, bounded records, failure deduplication, reload,
background disposal/cancellation and stale results. UI tests cover banner, detail reuse, dismissal,
running/thread-switch behavior, and existing manual generation. Run tests/typecheck/build and
independent correctness review before reload. No new dependencies, no Prompt Cache changes.

## Non-goals

Provider prompt-cache implementation/analytics, compaction, recurring BB automations, durable
in-flight jobs, native OS notifications, automatic tool execution or large-history summarization refactors.


## Approved amendment — brief default

User clarified that Recap should quickly orient them, not summarize the conversation: approximately two plain-text sentences about the topic/user goal and current focus or stopping point, without bullets or exhaustive decisions/work. This replaces the original full-summary background default and five-bullet short mode. Both automatic and manual defaults use the brief orientation; detailed mode remains an explicit option. Use the existing format flag, version the prompt/cache, and rephrase the short output instead of truncating a full summary.
