---
name: prompt-cache
description: Explains the Prompt Cache plugin — the thread header badge and composer banner that show prompt-cache hits and the time until the cache expires, and its settings.
---

# Prompt Cache

The plugin shows how the prompt cache works in a thread. It does not cache anything: the agent CLI and its API do that. The plugin reads the usage they report to bb.

## What the user sees

- A badge in the thread header, such as `98% · 3:41`: the share of the last prompt read from the cache, and the time until the cache expires. Clicking it shows the read / written / new split, the cache lifetime and where it comes from.
- A banner above the composer when the cache is about to expire ("Reply before then") or has expired on a large context ("Compact the thread first"). Its **Compact** button compacts the thread.

## Settings

- `bb plugin config prompt-cache` shows the current settings.
- `bb plugin config prompt-cache set claudeCodeTtl <auto|5m|1h>` pins the Claude Code cache lifetime. `auto` means 1 hour on a Claude subscription within its plan, otherwise 5 minutes. `codexTtl` and `piTtl` do the same for Codex and Pi; their `auto` is 5 minutes.
- `bb plugin config prompt-cache set warnSeconds <seconds>` sets when the badge turns red and the banner appears (default 60).
- `bb plugin config prompt-cache set compactAtTokens <tokens>` sets the context size from which the composer banner offers Compact on an expired cache (default 100000). The badge details offer Compact on any expired cache.
- `bb plugin config prompt-cache set banner false` turns the banner off.
- `bb plugin config prompt-cache unset <key>` returns a setting to its default.

## Limits

- Claude Code reports usage once per turn, so its numbers sum the turn's requests, and the countdown runs long by the last request's duration.
- The plugin cannot read the CLI's environment, such as `CLAUDE_CODE_PROMPT_CACHE_TTL`. Pin the lifetime in the settings instead.
- ACP providers report no cache usage, so their threads show no badge.
