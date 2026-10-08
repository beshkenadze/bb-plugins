# bb-plugins

Plugins for [bb](https://getbb.app). Each one lives in its own directory under
`plugins/`, and `.bb/plugins.json` indexes them so bb can install one plugin of
this repository by name.

| Plugin | What it does |
|---|---|
| [prompt-prewalk](plugins/prompt-prewalk) | Composer button that rewrites a draft prompt with a separately chosen model |
| [prompt-cache](plugins/prompt-cache) | Thread header badge and composer banner showing prompt-cache hits and time until the cache expires |

## Install

bb clones the repository and builds the plugin on the server:

```sh
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin prompt-prewalk
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin prompt-cache
```

Installs from a branch track it: `bb plugin outdated` shows new commits and
`bb plugin update <id>` applies them. A private repository needs git access to
GitHub on the bb server machine (for example `gh auth setup-git`).

## Develop

See each plugin's README. In short:

```sh
cd plugins/<name>
npm install
npm test
bb plugin install path:$PWD   # or `bb plugin reload <id>` after edits
```
