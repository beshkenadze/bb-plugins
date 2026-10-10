## Pick up where you left off

Return to a visited thread to see a compact **Recap** banner above the composer: two sentences about the topic and current focus, plus its update time. **Details** opens the saved orientation without another model request. The header button uses the same brief default; enable **Detailed recap** and choose **Regenerate** for the longer format. Neither view sends a task to the thread's main agent.

## Your summary model

Choose and save a provider and model in **Recap model** settings using BB's native picker, including reasoning and service tier. The choice is independent of the thread's model. Requests use your configured BB provider and its normal model costs or subscription limits; no separate API key is required by Recap.

## Background, not busywork

After a visited thread becomes idle and its history stays unchanged for three minutes, Recap prepares a two-sentence orientation using your saved model. Only one automatic generation runs at a time. Current results are reused; automatic failures are not retried repeatedly for the same history/settings version. Turn off **Background recap** to use manual generation only.

The banner is hidden while the main agent works. Stale results are labelled, and closing the banner hides that summary until the next result. Up to 100 visited-thread records/results survive plugin reload. This is a cache of summaries, not a replacement for the existing Prompt Cache plugin.

## Recorded history, not guesses

Recap reads older messages plus recorded commands, tool results and file-change paths. The model matches the conversation's language and distinguishes verified outcomes from plans and failures. The default is a brief orientation, not a compressed summary or bullet list. Explicit detailed mode retains Context, Decisions, Done, Open / blocked and Next steps. Regenerate for fresh state, copy a result, or cancel a request.

Input is bounded. The dialog warns when history is shortened or incomplete. Attachments, unsupported work-row types and private reasoning are not included. The selected provider receives the included history, which may contain sensitive tool inputs and outputs.

## Requirements and lifecycle

Requires BB 0.45 or newer and an available agent provider on the primary host. A hidden worker runs in that host's personal workspace and is archived and stopped afterward. BB retains its archived transcript under normal history rules. Bounded saved summaries live in plugin storage; Recap does not write recap files or change the main agent's context. Automatic generation sends included thread history to the selected provider and uses its normal costs or subscription limits.
