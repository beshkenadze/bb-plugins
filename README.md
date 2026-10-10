# bb-plugins

Plugins for [bb](https://getbb.app). Each one lives in its own directory under
`plugins/`, and `.bb/plugins.json` indexes them so bb can install one plugin of
this repository by name.

| Plugin | What it does |
|---|---|
| [prompt-prewalk](plugins/prompt-prewalk) | Composer button that rewrites a draft prompt with a separately chosen model |
| [prompt-cache](plugins/prompt-cache) | Thread header badge and composer banner showing prompt-cache hits and time until the cache expires |
| [recap](plugins/recap) | Thread-header button that summarizes decisions, completed work, blockers, and next steps with its own provider and model |
| [kaban](plugins/kaban) | Project kanban boards, task-linked threads, and the `bb kaban` agent CLI |

## Install

bb clones the repository and builds the plugin on the server:

```sh
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin prompt-prewalk
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin prompt-cache
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin recap
bb plugin install git:github.com/beshkenadze/bb-plugins@main --plugin kaban
```

Installs from a branch track it: `bb plugin outdated` shows new commits and
`bb plugin update <id>` applies them. A private repository needs git access to
GitHub on the bb server machine (for example `gh auth setup-git`).

Kaban also requires the standalone Kaban CLI on each machine with a project
checkout: `npm i -g @kaban-board/cli` or `brew install beshkenadze/tap/kaban`.
Installing the BB plugin does not install that CLI or publish your board data.

## Develop

See each plugin's README. In short:

```sh
cd plugins/<name>
npm install
npm test
bb plugin install path:$PWD   # or `bb plugin reload <id>` after edits
```


## License

Original plugin code is [MIT licensed](LICENSE). The Kaban integration retains its [upstream MIT license](plugins/kaban/LICENSE). Copied BB components retain their upstream license and attribution; see [third-party notices](THIRD_PARTY_NOTICES.md).
