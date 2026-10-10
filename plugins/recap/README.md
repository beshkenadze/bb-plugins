# Recap

Quickly grasp what a BB thread is about without rereading the conversation. By default, Recap prepares a two-sentence orientation—not a list or a full summary—and shows it above the composer. The **Recap** header button opens the saved text, using a separately selected provider/model without messaging the main agent. A detailed recap remains available explicitly.

## Install

Requires BB 0.45+ and Plugin SDK 0.6.15+.

```sh
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin recap
```

Local development:

```sh
cd plugins/recap
npm install
bb plugin build
bb plugin install path:$PWD
```

## Use

1. Open **Plugins → Recap → Recap model**, choose a provider/model, and save it. The picker is the same host-owned picker used by Prompt Prewalk, including reasoning and service tier.
2. Open a thread to register it as visited. With background recap enabled, the plugin prepares a brief orientation after the thread is idle and its history has not changed for three minutes: two plain-text sentences about the topic and current focus/stopping point, without bullets or a work log.
3. Read the compact banner above the composer. **Details** opens the saved summary without another model request; **×** hides that result until a new summary replaces it. The banner is hidden while the main agent is running and explicitly marks stale results.
   If the current source cannot be checked, a saved recap is marked **Unverified**, not falsely reported as outdated.
4. The header **Recap** button also defaults to the brief orientation. It reuses a current saved result or generates one when needed. For the longer version, enable **Detailed recap** and click **Regenerate**. Regenerate requests a fresh snapshot; **Copy** copies the result.
5. Cancel or close the dialog to cancel a manually owned request. If it is waiting for an already-running background job, closing the dialog stops waiting but does not cancel that job.

The model matches the conversation's language. The default orientation is composed as two sentences, usually 20–35 words, about the user's topic and current focus—not a report of test results or the agent's workflow, and not a full summary cut short. Explicit **Detailed recap** retains the longer format:

- **Context** — what the thread is trying to achieve and its current state.
- **Decisions** — agreed choices and the reasons actually recorded.
- **Done** — what changed and how, including useful paths, commands, outcomes and gotchas.
- **Open / blocked** — unresolved questions, failures and blockers.
- **Next steps** — what to do next, not a chronological transcript.

## Settings

- **Recap model**: independent of the source thread's provider/model. The suggested default must be explicitly saved before generation is enabled. Configure provider credentials in BB, not in this plugin.
- **Timeout (seconds)**: 120 by default; allowed range 10–900. Applies to history reads and model generation after configuration is loaded. Worker creation uses BB's normal request timeout and cannot be interrupted before it returns an id.
- **History character budget**: 100,000 by default; allowed range 10,000–250,000. This bounds normalized history, not model tokens or serialized prompt length. Choose a budget that fits your model.
- **Background recap**: enabled by default, but still requires an explicitly saved model. Only visited, visible/non-archived threads are eligible. Turn it off to keep generation manual.

### Background and saved results

Visited status means the thread was displayed in BB; it does not mean the server knows whether a user is currently away. The delay follows execution/history inactivity, not global window focus. Background jobs use the existing timeout, and at most one automatic generation runs at a time.

Saved results are associated with the source sequence, selected model/settings, format and prompt version. Unchanged history reuses the result. Failed automatic attempts are not repeatedly retried for the same version; use Regenerate to retry. Changes during generation leave the older result marked stale. Up to 100 visited-thread records and their bounded results are kept in plugin storage and survive reload; older entries can be evicted.
Prompt-version changes invalidate earlier formats: old five-bullet results may remain visible as outdated until regenerated, but are not reused as current brief output.

New execution activity or a settings change interrupts an unfinished automatic recap and starts a new inactivity window; that cancellation does not permanently block a later attempt. Genuine failures/timeouts remain deduplicated. Archived normal threads can still be summarized manually, but are never automatically scheduled.

This result cache is separate from provider prompt caching. **Prompt Cache** already reports provider cache usage; Recap does not duplicate or alter it. A Recap worker is a separate request and does not guarantee reuse of the main thread's prompt-cache prefix.

## History and privacy

Recap reads the source thread's paginated BB timeline, including older conversation and nested work. It includes command outcomes, tool inputs/results and file-change paths; it does not read source files, search other threads, or request private reasoning/thinking content. Unsupported work-row types and attachment contents are not included.

Messages are capped at 6,000 characters and work entries at 2,000, retaining both ends. When the total budget is exceeded, initial context plus the most recent work are retained. Up to 50 timeline pages and 50 collapsed-turn detail pages are read. The dialog warns when entries are omitted, shortened, provider output is only a preview, or older history remains unread. A recap is not proof that a claimed task or test actually succeeded.

The first timeline page sets the snapshot sequence. Outcomes that changed after that sequence are omitted and reported as a coverage gap, rather than presented as already completed in the snapshot.

The selected provider receives this history as a normal model request, including during automatic generation for visited threads. Tool arguments and outputs may contain sensitive information: choose the provider deliberately and disable Background recap if history must only be sent on demand. Prompt instructions treat history as quoted data and prohibit tools; this is not an additional security sandbox or a provider-wide removal of tools.

Generation uses an isolated **hidden BB worker** in the primary host's personal workspace, not the source checkout. Workers are archived and stopped after completion, failure, cancellation or plugin reload; unarchived orphan workers are reclaimed before the first generation after reload. BB retains archived worker transcripts under its usual history policy. Recap saves bounded summary results in plugin storage, not in `RECAP.md`, source files, or the main agent's context. Timers/in-flight workers do not survive reload; eligible state is checked again before later generation.

## Development

```sh
npm test
npm run typecheck
bb plugin types --check
npm run build
```

Tests use the public BB backend/frontend harnesses and cover history pagination/clipping, saved-model settings, background inactivity/eligibility, bounded persistent caching, reload and late-worker cleanup, request ownership/cancellation, race conditions, and the header/dialog/banner. No lint configuration is included; run the existing checks above.
