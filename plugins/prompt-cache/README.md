# Prompt Cache

A bb plugin that shows how the prompt cache works in a thread: how much of the prompt the cache served, how long until it expires, and what to do once it has. It works for every bb provider that reports cache usage: Claude Code, Codex and Pi.

The plugin does not cache anything. The agent CLI and its API do the caching; the plugin reads the usage they report to bb.

## What you see

- **Badge in the thread header**: `98% · 3:41` is the share of the last prompt read from the cache and the time left. The dot is green while the cache is warm, amber below 40% of its lifetime, red inside the warning window. Once the cache expired, the whole badge turns red.
- **Details** (click the badge): the time left against the lifetime and where the lifetime came from; what the next message costs once the cache expired against while it is warm; the last turn or request split into read / written / new tokens, flagged when it sent the earlier context again; how many cache rewrites the last 20 turns or requests paid; and **Compact** whenever the cache expired.
- **Banner above the composer**: "Prompt cache expires in 0:42…" inside the warning window, for contexts of 20k tokens or more; "Prompt cache expired…" in red with **Compact** for contexts at or above the Compact threshold. Both name the price of the next message for a model with a known price. The banner stays hidden while the agent runs, and **Dismiss** hides it until the cache is used again.

## How it works

- The app reads the thread's `thread/tokenUsage/updated`, `thread/contextWindowUsage/updated`, `provider/rateLimits/updated`, `client/turn/requested`, `thread/compacted` and `thread/context/cleared` events through `useSdk()`, and reloads them when the thread reports new ones.
- Providers count tokens differently. Claude Code and Pi report uncached input, cache reads and cache writes apart. Codex reports input with the cached part included, and no cache writes.
- The countdown starts at the latest request: the latest usage report, or a context report during a turn. The context snapshot bb takes after a turn is not a request, and neither is a turn that made none, such as a Claude Code mod's slash command: it reports zero usage, which the plugin skips. A compaction or clear starts over: nothing older describes the cache.

### Cache lifetime

| Provider | `auto` |
| --- | --- |
| Claude Code | 1 hour on a Claude subscription within its plan (the thread's latest rate-limit report says so), otherwise 5 minutes |
| Codex | 5 minutes, the shortest time OpenAI keeps an idle cache |
| Pi and others | 5 minutes |

Pin `5m` or `1h` in the settings when you know better, for example after setting `promptCacheTtl` in Claude Code's settings.json, or `CLAUDE_CODE_PROMPT_CACHE_TTL` or `ENABLE_PROMPT_CACHING_1H` in its environment: the plugin reads neither.

### Rewrites

A rewrite is a report that sent the earlier context again instead of reading it from the cache: the cache expired, or something changed the start of the prompt, such as the model or the tools.

- A request is a rewrite when it read less than half of the prompt it shares with the previous request (the smaller of the two) from the cache.
- Claude Code sums a turn's requests, so a turn reads its context many times even when its first request missed. The plugin compares what the turn wrote to the cache with how much it grew the context, from the context reports after this turn and the one before. A turn that wrote at least half of the earlier context beyond its own growth is a rewrite.
- Only contexts of 20k tokens or more count. Reports are not compared across a compaction or clear, whose next turn writes the new start of the prompt by design.

### Prices

Prices are Anthropic's API list prices as of October 2026, kept in `cache-model.ts`, for the model of the thread's latest turn. A rewrite costs the cache-write price of the lifetime (1.25 times the input price for 5 minutes, 2 times for an hour), a warm turn the cache-read price. On a Claude subscription they are a yardstick: the cost lands on your usage limits, not a bill. Models without a listed price, such as OpenAI's, show no prices.

## Install

```
cd plugins/prompt-cache
npm install
bb plugin install path:$PWD
```

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `claudeCodeTtl` | `auto` | Claude Code cache lifetime: `auto`, `5m` or `1h`. |
| `codexTtl` | `auto` | Codex cache lifetime. |
| `piTtl` | `auto` | Pi cache lifetime. |
| `warnSeconds` | 60 | From this many seconds left, the badge turns red and the banner asks you to reply. |
| `compactAtTokens` | 100000 | The composer banner offers Compact once the cache expired on a context this large or larger. The badge details offer it on any expired cache. |
| `banner` | true | Show the banner above the composer. |

```
bb plugin config prompt-cache
bb plugin config prompt-cache set claudeCodeTtl 1h
bb plugin config prompt-cache unset claudeCodeTtl
```

## Development

```
npm install
npm test
npm run typecheck
bb plugin build
```

After editing sources, run `bb plugin reload prompt-cache`.

- `cache-model.ts` — usage normalization per provider, the lifetime, the cache snapshot and its phase, rewrites, and prices.
- `settings.ts` — the settings form and its parsing in the app.
- `app.tsx` — the thread header badge with its details, and the composer banner.
- `server.ts` — declares the settings; everything else runs in the app.

## Limits

- Claude Code reports usage once per turn, so its numbers sum the turn's requests. The countdown starts at the latest report, not at the start of the last request, so it runs long by that request's duration.
- `auto` sees a Claude subscription only after the thread's first rate-limit report.
- ACP providers report no cache usage, so their threads show no badge.
- The rewrite count covers the last 20 usage reports and prices them all at the current model.
- Prices skip details: uncached input, output, and a request that wrote part of its prompt at both lifetimes.
