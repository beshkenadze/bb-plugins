# prompt-prewalk Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** bb-плагин, который по кнопке ✨ в composer переписывает черновик промпта отдельно выбранной моделью и подставляет результат в поле ввода.

**Architecture:** Frontend (`app.tsx`) добавляет в composer кнопку и баннер и вызывает RPC `improve`. Backend (`server.ts`) запускает скрытый worker-тред на выбранных провайдере и модели, ждёт `idle`, достаёт текст из `<prompt>…</prompt>` и всегда архивирует и останавливает worker. Чистая логика (промпт, разбор ответа, история, состояние UI) вынесена в `worker.ts` и `prewalk-store.ts`.

**Tech Stack:** TypeScript, React 19, `@get-bb/plugin-sdk` 0.5.9 (bb 0.43.4), zod 4, vitest + jsdom + Testing Library, npm.

**Design:** `docs/plans/2026-09-25-prompt-prewalk-design.md`.

---

## Соглашения

- `P` — `./plugins/prompt-prewalk`. Все команды запускаются из `P`, если не сказано иное.
- Корень репозитория `.` — коллекция плагинов. Каждый плагин лежит в `plugins/<name>/`.
- Удаление — только `trash <path>`, никаких `rm`.
- Dev-сервер `bb plugin dev` не запускать. Живая проверка — через `bb plugin build` + `bb plugin install` / `reload`, только после OK пользователя.
- Сигнатуры SDK сверены по `node_modules/@get-bb/plugin-sdk/bundled-types/*.d.ts`. Если `tsc` не согласен с планом, прав `tsc`: сверься с `.d.ts` и поправь код, не ослабляя тест.

---

### Task 1: Очистить scaffold и подготовить тесты

**Files:**
- Delete: `P/skills/example-todos/`
- Replace: `P/server.ts`, `P/app.tsx`
- Create: `P/vitest.config.ts`, `./.bb/plugins.json`
- Modify: `P/package.json` (через `npm pkg set` / `npm install`), `P/tsconfig.json`, `docs/plans/2026-09-25-prompt-prewalk-design.md`

**Step 1: Удалить пример todo**

```bash
trash skills/example-todos
```

**Step 2: Заменить `server.ts` минимальной фабрикой**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(_bb: BbPluginApi): Promise<void> {}
```

**Step 3: Заменить `app.tsx` пустым приложением**

```tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";

export default definePluginApp(() => {});
```

**Step 4: Манифест и скрипты**

```bash
npm pkg set bb.description="Improve a prompt with a separate model before you send it." \
  bb.branding.icon=AiContentGenerator01 \
  scripts.test="vitest run" scripts.typecheck="tsc --noEmit" scripts.build="bb plugin build"
```

**Step 5: Тестовые зависимости** (sandbox off)

```bash
npm install -D vitest jsdom @testing-library/react react react-dom
```

**Step 6: Разрешить нативную сборку better-sqlite3** (нужна fake-host для backend-тестов; sandbox off)

```bash
npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3
node -e "new (require('better-sqlite3'))(':memory:').close(); console.log('sqlite ok')"
```

Expected: `sqlite ok`. Если в npm нет подкоманды `install-scripts`, выполни `npm rebuild better-sqlite3 --foreground-scripts`.

**Step 7: `vitest.config.ts`**

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["*.test.ts", "*.test.tsx"] },
});
```

**Step 8: `tsconfig.json` — расширить `include`**

```json
  "include": [
    "server.ts",
    "app.tsx",
    "worker.ts",
    "prewalk-store.ts",
    "*.test.ts",
    "*.test.tsx",
    "vitest.config.ts",
    "components",
    "lib",
    "hooks"
  ]
```

**Step 9: Индекс коллекции плагинов** — `./.bb/plugins.json`

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "bb-project-plugins",
  "plugins": [{ "name": "prompt-prewalk", "source": "./plugins/prompt-prewalk" }]
}
```

**Step 10: Дописать в дизайн-документ раздел «Уточнения после сверки с SDK 0.5.9»**

```markdown
## Уточнения после сверки с SDK 0.5.9

- Плагин лежит в `plugins/prompt-prewalk/`. Корень репозитория — коллекция плагинов с индексом `.bb/plugins.json`.
- Scope `new-thread` несёт `projectId` (`null`, пока проект не выбран). Поддерживаем оба scope; при `null` кнопка неактивна.
- Read-only режима нет. Worker запускается с самым строгим `permissionMode: "accept-edits"`. Если модель всё же попросит разрешение, запрос упрётся в таймаут, и worker остановится.
- Окружение worker-а: в треде — `{ type: "reuse", environmentId }` этого треда, чтобы не плодить worktree; в новом треде — `project-default`.
- `threads.wait` бросает `ThreadWaitTimeoutError` и `ThreadWaitUnreachableError`. Они дают коды `timeout` и `worker_failed`.
- `bb.sdk` недоступен во время загрузки плагина. Поэтому sweep сирот выполняется один раз перед первым `improve`. Сироты — скрытые неархивные треды с `originPluginId` плагина.
- `useComposerView().draft` не содержит упоминаний. Их число даёт `richText.onDraftChange`. Вместо предупреждения кнопка неактивна, пока в черновике есть @-упоминания: пилюли не теряются молча.
- `getModel` предлагает модель по умолчанию первого доступного провайдера. `improve` работает только после явного сохранения модели.
- UI-тексты на английском, как весь интерфейс bb.
```

**Step 11: Проверить, что пустой плагин собирается**

```bash
npm run typecheck && npx vitest run --passWithNoTests
```

Expected: `tsc` без ошибок, vitest `No test files found, exiting with code 0`. Если `tsc` падает на `.d.ts` тестовых библиотек (включён `skipLibCheck: false`), сначала выясни, какой пакет не хватает (обычно `@testing-library/dom`), и добавь его через `npm install -D`.

**Step 12: Commit** (sandbox off)

```bash
cd .
git add .bb/plugins.json docs/plans plugins/prompt-prewalk
git commit -m "chore(prompt-prewalk): scaffold plugin and test tooling"
```

---

### Task 2: Чистая логика worker-а

**Files:**
- Create: `P/worker.ts`
- Test: `P/worker.test.ts`

**Step 1: Failing test** — `worker.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { buildWorkerPrompt, collectHistory, extractPrompt, MAX_HISTORY_CHARS } from "./worker";

describe("extractPrompt", () => {
  it("returns the trimmed text inside <prompt> tags", () => {
    expect(extractPrompt("Sure.\n<prompt>\n  Fix it  \n</prompt>")).toBe("Fix it");
  });

  it("returns null without tags, with empty tags, or without output", () => {
    expect(extractPrompt("Fix it")).toBeNull();
    expect(extractPrompt("<prompt>   </prompt>")).toBeNull();
    expect(extractPrompt(null)).toBeNull();
  });
});

describe("collectHistory", () => {
  const rows = [
    { kind: "conversation", role: "user", initiator: "user", id: "m1", text: "first question" },
    {
      kind: "turn",
      id: "t1",
      children: [
        { kind: "work", id: "w1" },
        { kind: "conversation", role: "assistant", id: "m2", text: "first answer" },
      ],
    },
    { kind: "conversation", role: "user", initiator: "system", id: "m3", text: "child thread finished" },
    { kind: "conversation", role: "assistant", id: "m2", text: "first answer" },
    { kind: "conversation", role: "user", initiator: "user", id: "m4", text: "second question" },
  ];

  it("keeps user and assistant messages in order, skipping system rows and duplicates", () => {
    expect(collectHistory(rows, 10)).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "first answer" },
      { role: "user", text: "second question" },
    ]);
  });

  it("keeps only the last `limit` messages", () => {
    expect(collectHistory(rows, 1)).toEqual([{ role: "user", text: "second question" }]);
  });

  it("returns nothing for limit 0", () => {
    expect(collectHistory(rows, 0)).toEqual([]);
  });

  it("truncates long messages", () => {
    const long = { kind: "conversation", role: "assistant", id: "x", text: "a".repeat(MAX_HISTORY_CHARS + 10) };
    const [message] = collectHistory([long], 1);
    expect(message?.text).toHaveLength(MAX_HISTORY_CHARS + 1);
    expect(message?.text.endsWith("…")).toBe(true);
  });
});

describe("buildWorkerPrompt", () => {
  it("wraps history and draft and appends extra instructions", () => {
    const prompt = buildWorkerPrompt({
      draft: "fix it",
      history: [{ role: "user", text: "hi" }],
      extraInstructions: "  Answer in English.  ",
    });
    expect(prompt).toContain("<draft>\nfix it\n</draft>");
    expect(prompt).toContain("<history>\n<user>\nhi\n</user>\n</history>");
    expect(prompt).toContain("\nAnswer in English.\n");
  });

  it("omits the extra instructions line when it is blank", () => {
    const prompt = buildWorkerPrompt({ draft: "fix it", history: [], extraInstructions: "   " });
    expect(prompt).toContain("inside <prompt>…</prompt>.\n\n<history>\n\n</history>");
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run worker.test.ts`
Expected: FAIL — `Failed to resolve import "./worker"`.

**Step 3: Implementation** — `worker.ts`

```ts
export const MAX_DRAFT_CHARS = 20_000;
export const MAX_HISTORY_CHARS = 2_000;

export interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

const RULES = [
  "You rewrite a user's request to a coding agent so it is clearer and more actionable.",
  "Rules:",
  "- Keep the user's intent, language, and every concrete detail (paths, names, numbers).",
  "- Do not invent requirements. Put real ambiguities as explicit open questions at the end.",
  "- Do not answer the request. Do not run tools. Do not read or modify files.",
  "- Output ONLY the rewritten prompt inside <prompt>…</prompt>.",
];

export function buildWorkerPrompt(input: {
  draft: string;
  history: readonly HistoryMessage[];
  extraInstructions: string;
}): string {
  const extra = input.extraInstructions.trim();
  const history = input.history.map(({ role, text }) => `<${role}>\n${text}\n</${role}>`).join("\n");
  return [
    ...RULES,
    ...(extra === "" ? [] : [extra]),
    "",
    `<history>\n${history}\n</history>`,
    "",
    `<draft>\n${input.draft}\n</draft>`,
  ].join("\n");
}

export function extractPrompt(output: string | null): string | null {
  return output?.match(/<prompt>([\s\S]*?)<\/prompt>/)?.[1]?.trim() || null;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;

function flatten(rows: readonly unknown[]): Row[] {
  return rows
    .filter(isRow)
    .flatMap((row) => [row, ...(Array.isArray(row.children) ? flatten(row.children) : [])]);
}

function truncate(text: string): string {
  return text.length > MAX_HISTORY_CHARS ? `${text.slice(0, MAX_HISTORY_CHARS)}…` : text;
}

/** Timeline rows → the last `limit` human and assistant messages, oldest first. */
export function collectHistory(rows: readonly unknown[], limit: number): HistoryMessage[] {
  if (limit <= 0) return [];
  const seen = new Set<string>();
  const messages: HistoryMessage[] = [];
  for (const row of flatten(rows)) {
    if (row.kind !== "conversation" || typeof row.id !== "string" || typeof row.text !== "string") continue;
    const role =
      row.role === "assistant" ? "assistant" : row.role === "user" && row.initiator === "user" ? "user" : null;
    const text = row.text.trim();
    if (role === null || text === "" || seen.has(row.id)) continue;
    seen.add(row.id);
    messages.push({ role, text: truncate(text) });
  }
  return messages.slice(-limit);
}
```

**Step 4: Run — expect PASS**

Run: `npx vitest run worker.test.ts`
Expected: 9 passed.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/worker.ts plugins/prompt-prewalk/worker.test.ts
git commit -m "feat(prompt-prewalk): worker prompt, answer parsing, thread history"
```

---

### Task 3: RPC-контракт и выбор модели

**Files:**
- Replace: `P/server.ts`
- Test: `P/server.test.ts`

**Step 1: Failing test** — `server.test.ts` (общие хелперы + тесты модели)

```ts
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const SELECTION = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" } as const;
const THREAD_INPUT = { requestId: "req-1", text: "fix the login bug", threadId: "thread-1" };
const PROJECT_INPUT = { requestId: "req-1", text: "fix the login bug", projectId: "project-1" };

type HostOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
type Harness = Awaited<ReturnType<typeof load>>;

function stubs() {
  return {
    providers: {
      list: async () => [
        { id: "codex", available: false },
        { id: "claude-code", available: true },
      ],
      models: async () => ({
        models: [
          { model: "claude-sonnet-5", isDefault: false, defaultReasoningEffort: "high" },
          { model: "claude-haiku-4-5", isDefault: true, defaultReasoningEffort: "low" },
        ],
      }),
    },
    threads: {
      get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }),
      timeline: async (): Promise<{ rows: unknown[] }> => ({ rows: [] }),
      list: async (): Promise<unknown[]> => [],
      spawn: async () => makeThreadResponse({ id: "worker-1", visibility: "hidden" }),
      wait: async (): Promise<unknown> => ({ matched: true }),
      output: async (): Promise<{ output: string | null }> => ({
        output: "<prompt>Fix the login bug in auth.ts</prompt>",
      }),
      archive: async () => ({ ok: true, archivedThreadIds: [] }),
      stop: async (): Promise<unknown> => ({ ok: true }),
    },
  } satisfies HostOptions["sdk"];
}

async function load(sdk: HostOptions["sdk"] = stubs(), settings: HostOptions["settings"] = {}) {
  const host = createFakePluginHost({ pluginId: "prompt-prewalk", sdk, settings });
  await plugin(host.bb);
  return host.harness;
}

async function loadWithModel(sdk?: HostOptions["sdk"], settings?: HostOptions["settings"]) {
  const harness = await load(sdk, settings);
  await harness.callRpc("setModel", SELECTION);
  return harness;
}

function argsOf(harness: Harness, path: string): unknown[] {
  return harness.inspection.sdk.callsTo(path).map((args) => args[0]);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("getModel / setModel", () => {
  it("offers the default model of the first available provider until one is saved", async () => {
    const harness = await load();
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: SELECTION, saved: false });
    expect(argsOf(harness, "providers.models")).toEqual([{ providerId: "claude-code" }]);
  });

  it("returns the saved selection", async () => {
    const harness = await load();
    const sonnet = { ...SELECTION, model: "claude-sonnet-5" };
    await expect(harness.callRpc("setModel", sonnet)).resolves.toEqual(sonnet);
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: sonnet, saved: true });
  });

  it("offers nothing when no provider is available", async () => {
    const sdk = stubs();
    sdk.providers.list = async () => [];
    const harness = await load(sdk);
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: null, saved: false });
  });

  it("rejects an unknown reasoning level", async () => {
    const harness = await load();
    await expect(
      harness.callRpc("setModel", { ...SELECTION, reasoningLevel: "extreme" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run server.test.ts`
Expected: FAIL — `unknown_method` / RPC `getModel` не зарегистрирован.

**Step 3: Implementation** — `server.ts`

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MAX_DRAFT_CHARS } from "./worker";

const reasoningLevelSchema = z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]);

const selectionSchema = z
  .object({ providerId: z.string().min(1), model: z.string().min(1), reasoningLevel: reasoningLevelSchema })
  .strict();
export type ModelSelection = z.infer<typeof selectionSchema>;

const improveErrorCodeSchema = z.enum(["no_model", "timeout", "worker_failed", "invalid_response", "cancelled"]);
export type ImproveErrorCode = z.infer<typeof improveErrorCodeSchema>;

const draftFields = {
  requestId: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(MAX_DRAFT_CHARS),
};

export const rpcContract = defineRpcContract({
  improve: {
    input: z.union([
      z.object({ ...draftFields, threadId: z.string().min(1) }).strict(),
      z.object({ ...draftFields, projectId: z.string().min(1) }).strict(),
    ]),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), text: z.string() }),
      z.object({ ok: z.literal(false), code: improveErrorCodeSchema, message: z.string() }),
    ]),
  },
  cancel: {
    input: z.object({ requestId: z.string().min(1) }).strict(),
    output: z.object({ cancelled: z.boolean() }),
  },
  getModel: {
    input: z.null(),
    output: z.object({ selection: selectionSchema.nullable(), saved: z.boolean() }),
  },
  setModel: { input: selectionSchema, output: selectionSchema },
});

const SELECTION_KEY = "selection";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  async function readSelection(): Promise<ModelSelection | null> {
    const parsed = selectionSchema.safeParse(await bb.storage.kv.get(SELECTION_KEY));
    return parsed.success ? parsed.data : null;
  }

  async function defaultSelection(): Promise<ModelSelection | null> {
    const provider = (await bb.sdk.providers.list()).find((candidate) => candidate.available);
    if (provider === undefined) return null;
    const { models } = await bb.sdk.providers.models({ providerId: provider.id });
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    return model === undefined
      ? null
      : { providerId: provider.id, model: model.model, reasoningLevel: model.defaultReasoningEffort };
  }

  bb.rpc.register(rpcContract, {
    improve: () => {
      throw new Error("not implemented");
    },
    cancel: () => ({ cancelled: false }),
    getModel: async () => {
      const saved = await readSelection();
      return saved === null ? { selection: await defaultSelection(), saved: false } : { selection: saved, saved: true };
    },
    setModel: async (selection) => {
      await bb.storage.kv.set(SELECTION_KEY, selection);
      return selection;
    },
  });
}
```

**Step 4: Run — expect PASS**

Run: `npx vitest run server.test.ts && npm run typecheck`
Expected: 4 passed; `tsc` без ошибок.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/server.ts plugins/prompt-prewalk/server.test.ts
git commit -m "feat(prompt-prewalk): RPC contract and model selection"
```

---

### Task 4: `improve` — worker, история, ошибки, очистка

> **Выполнено с изменением после ревью (`06d2b51`):** worker запускается в `proj_personal` с `environment: { type: "host", workspace: { type: "personal" } }`, вход `improve` — `{ requestId, text, threadId? }` (без `projectId`), `resolveTarget` и `threads.get` удалены. Код ниже — исходный план; актуальное состояние — `server.ts`.

**Files:**
- Modify: `P/server.ts`
- Test: `P/server.test.ts` (дописать в конец)

**Step 1: Failing tests**

```ts
describe("improve", () => {
  it("asks for a model when none is saved", async () => {
    const harness = await load();
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toMatchObject({ ok: false, code: "no_model" });
    expect(argsOf(harness, "threads.spawn")).toEqual([]);
  });

  it("spawns a hidden worker in the thread's environment and returns the rewritten prompt", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toEqual({
      ok: true,
      text: "Fix the login bug in auth.ts",
    });
    const [spawn] = argsOf(harness, "threads.spawn");
    expect(spawn).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "env-1" },
      visibility: "hidden",
      permissionMode: "accept-edits",
      pluginMetadata: { prewalk: true },
      ...SELECTION,
    });
    expect(spawn).not.toHaveProperty("parentThreadId");
    expect(argsOf(harness, "threads.wait")).toEqual([{ threadId: "worker-1", status: "idle", timeoutMs: 120_000 }]);
  });

  it("feeds recent thread history and the draft into the worker prompt", async () => {
    const sdk = stubs();
    sdk.threads.timeline = async () => ({
      rows: [
        { kind: "conversation", role: "user", initiator: "user", id: "m1", text: "earlier question" },
        { kind: "conversation", role: "assistant", id: "m2", text: "earlier answer" },
      ],
    });
    const harness = await loadWithModel(sdk);
    await harness.callRpc("improve", THREAD_INPUT);
    const [spawn] = argsOf(harness, "threads.spawn");
    expect(spawn).toMatchObject({ prompt: expect.stringContaining("<assistant>\nearlier answer\n</assistant>") });
    expect(spawn).toMatchObject({ prompt: expect.stringContaining("<draft>\nfix the login bug\n</draft>") });
  });

  it("skips history when historyMessages is 0", async () => {
    const harness = await loadWithModel(stubs(), { historyMessages: 0 });
    await harness.callRpc("improve", THREAD_INPUT);
    expect(argsOf(harness, "threads.timeline")).toEqual([]);
  });

  it("uses the project default environment for a new thread", async () => {
    const harness = await loadWithModel();
    await harness.callRpc("improve", PROJECT_INPUT);
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({
      projectId: "project-1",
      environment: { type: "project-default" },
    });
    expect(argsOf(harness, "threads.get")).toEqual([]);
  });

  it("falls back to the project default environment when the thread has none", async () => {
    const sdk = stubs();
    sdk.threads.get = async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: null });
    const harness = await loadWithModel(sdk);
    await harness.callRpc("improve", THREAD_INPUT);
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({ environment: { type: "project-default" } });
  });

  it.each([
    ["invalid_response", { output: async () => ({ output: "Sure! Here is a better prompt." }) }],
    ["timeout", { wait: async () => Promise.reject(namedError("ThreadWaitTimeoutError")) }],
    ["worker_failed", { wait: async () => Promise.reject(namedError("ThreadWaitUnreachableError")) }],
  ] as const)("reports %s and cleans up the worker", async (code, threadOverrides) => {
    const sdk = stubs();
    Object.assign(sdk.threads, threadOverrides);
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toMatchObject({ ok: false, code });
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("cleans up the worker when an unexpected error escapes", async () => {
    const sdk = stubs();
    sdk.threads.output = async () => Promise.reject(new Error("boom"));
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).rejects.toThrow("boom");
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("rejects input with both threadId and projectId", async () => {
    const harness = await loadWithModel();
    await expect(
      harness.callRpc("improve", { ...THREAD_INPUT, projectId: "project-1" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a blank draft", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", { ...THREAD_INPUT, text: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run server.test.ts`
Expected: FAIL — тесты `improve` падают на `not implemented`.

**Step 3: Implementation** — правки `server.ts`

Заменить импорт `./worker`:

```ts
import {
  buildWorkerPrompt,
  collectHistory,
  extractPrompt,
  MAX_DRAFT_CHARS,
  type HistoryMessage,
} from "./worker";
```

После `const SELECTION_KEY = "selection";` добавить:

```ts
type ImproveInput = z.infer<(typeof rpcContract)["improve"]["input"]>;
type ImproveResult = z.infer<(typeof rpcContract)["improve"]["output"]>;
type SpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

interface WorkerTarget {
  projectId: string;
  environment: SpawnArgs["environment"];
  history: HistoryMessage[];
}

const fail = (code: ImproveErrorCode, message: string): ImproveResult => ({ ok: false, code, message });

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : "";
}
```

(`errorMessage` уже добавлен фиксом ревью задачи 3 — не дублировать.)

В начале фабрики, перед `readSelection`, объявить настройки:

```ts
  const settings = bb.settings.define({
    historyMessages: {
      type: "number",
      label: "History messages",
      description: "How many recent thread messages the pre-walk model sees. 0 turns history off.",
      default: 6,
      experimental_schema: z.number().int().min(0).max(50),
    },
    timeoutSec: {
      type: "number",
      label: "Timeout (seconds)",
      description: "How long to wait for the pre-walk model.",
      default: 120,
      experimental_schema: z.number().int().min(10).max(900),
    },
    extraInstructions: {
      type: "string",
      label: "Extra instructions",
      description: "Your own rules for rewriting prompts. They are appended to the built-in rules.",
      default: "",
      experimental_multiline: true,
    },
  });
```

После `defaultSelection` добавить:

```ts
  async function disposeWorker(threadId: string): Promise<void> {
    await bb.sdk.threads
      .archive({ threadId })
      .catch((error: unknown) => bb.log.warn(`archive ${threadId} failed: ${errorMessage(error)}`));
    await bb.sdk.threads
      .stop({ threadId })
      .catch((error: unknown) => bb.log.warn(`stop ${threadId} failed: ${errorMessage(error)}`));
  }

  async function resolveTarget(input: ImproveInput, historyMessages: number): Promise<WorkerTarget> {
    if (!("threadId" in input)) {
      return { projectId: input.projectId, environment: { type: "project-default" }, history: [] };
    }
    const thread = await bb.sdk.threads.get({ threadId: input.threadId });
    const history =
      historyMessages > 0
        ? collectHistory((await bb.sdk.threads.timeline({ threadId: input.threadId })).rows, historyMessages)
        : [];
    return {
      projectId: thread.projectId,
      environment:
        thread.environmentId === null
          ? { type: "project-default" }
          : { type: "reuse", environmentId: thread.environmentId },
      history,
    };
  }

  async function awaitWorker(workerId: string, timeoutSec: number): Promise<ImproveResult> {
    try {
      await bb.sdk.threads.wait({ threadId: workerId, status: "idle", timeoutMs: timeoutSec * 1000 });
    } catch (error) {
      if (errorName(error) === "ThreadWaitTimeoutError") {
        return fail("timeout", `The pre-walk model did not answer within ${timeoutSec} s.`);
      }
      if (errorName(error) === "ThreadWaitUnreachableError") {
        return fail("worker_failed", "The pre-walk worker failed. Check the model in the plugin settings.");
      }
      throw error;
    }
    const { output } = await bb.sdk.threads.output({ threadId: workerId });
    const text = extractPrompt(output);
    return text === null ? fail("invalid_response", "The pre-walk model returned an unexpected answer.") : { ok: true, text };
  }

  async function improve(input: ImproveInput): Promise<ImproveResult> {
    const selection = await readSelection();
    if (selection === null) return fail("no_model", "Choose a pre-walk model in the Prompt Prewalk settings.");
    const { historyMessages, timeoutSec, extraInstructions } = await settings.get();
    const target = await resolveTarget(input, historyMessages);
    const worker = await bb.sdk.threads.spawn({
      projectId: target.projectId,
      environment: target.environment,
      prompt: buildWorkerPrompt({ draft: input.text, history: target.history, extraInstructions }),
      title: "Prompt pre-walk",
      visibility: "hidden",
      permissionMode: "accept-edits",
      pluginMetadata: { prewalk: true },
      ...selection,
    });
    try {
      return await awaitWorker(worker.id, timeoutSec);
    } finally {
      await disposeWorker(worker.id);
    }
  }
```

В `bb.rpc.register` заменить заглушку `improve: () => { throw … }` на `improve,`.

**Step 4: Run — expect PASS**

Run: `npx vitest run server.test.ts && npm run typecheck`
Expected: все тесты `getModel / setModel` и `improve` зелёные; `tsc` без ошибок.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/server.ts plugins/prompt-prewalk/server.test.ts
git commit -m "feat(prompt-prewalk): improve prompts with a hidden worker thread"
```

---

### Task 5: Отмена и `onDispose`

> **Выполнено с фиксами ревью (`68847bd`):** запрос регистрируется в `active` до первого `await`, `finally` удаляет только свою запись, ошибка после отмены ловится одним `catch` на весь `try`. Код ниже — исходный план; актуальное состояние — `server.ts`.

**Files:**
- Modify: `P/server.ts`
- Test: `P/server.test.ts` (дописать в конец)

**Step 1: Failing tests**

```ts
describe("cancel and dispose", () => {
  function blockingStubs() {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sdk = stubs();
    sdk.threads.wait = async () => {
      await released;
      return { matched: true };
    };
    sdk.threads.stop = async () => {
      release();
      return { ok: true };
    };
    return sdk;
  }

  it("stops the worker and resolves the request as cancelled", async () => {
    const harness = await loadWithModel(blockingStubs());
    const pending = harness.callRpc("improve", THREAD_INPUT);
    await vi.waitFor(() => expect(argsOf(harness, "threads.wait")).toHaveLength(1));
    await expect(harness.callRpc("cancel", { requestId: "req-1" })).resolves.toEqual({ cancelled: true });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
  });

  it("treats cancel of an unknown request as a no-op", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("cancel", { requestId: "nope" })).resolves.toEqual({ cancelled: false });
  });

  it("stops in-flight workers on dispose", async () => {
    const harness = await loadWithModel(blockingStubs());
    const pending = harness.callRpc("improve", THREAD_INPUT).catch(() => undefined);
    await vi.waitFor(() => expect(argsOf(harness, "threads.wait")).toHaveLength(1));
    await harness.lifecycle.dispose();
    expect(argsOf(harness, "threads.stop")).toContainEqual({ threadId: "worker-1" });
    await pending;
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run server.test.ts -t "cancel and dispose"`
Expected: FAIL — `cancel` возвращает `{ cancelled: false }`, запрос висит до таймаута теста.

**Step 3: Implementation** — правки `server.ts`

После `interface WorkerTarget` добавить:

```ts
interface ActiveRequest {
  workerId: string | null;
  cancelled: boolean;
}
```

После `const fail = …` добавить:

```ts
const CANCELLED = fail("cancelled", "Pre-walk cancelled.");
```

В фабрике перед `readSelection` добавить:

```ts
  const active = new Map<string, ActiveRequest>();
```

Заменить функцию `improve` целиком:

```ts
  async function improve(input: ImproveInput): Promise<ImproveResult> {
    const selection = await readSelection();
    if (selection === null) return fail("no_model", "Choose a pre-walk model in the Prompt Prewalk settings.");
    const request: ActiveRequest = { workerId: null, cancelled: false };
    active.set(input.requestId, request);
    try {
      const { historyMessages, timeoutSec, extraInstructions } = await settings.get();
      const history =
        input.threadId !== undefined && historyMessages > 0
          ? collectHistory((await bb.sdk.threads.timeline({ threadId: input.threadId })).rows, historyMessages)
          : [];
      if (request.cancelled) return CANCELLED;
      const worker = await bb.sdk.threads.spawn({
        projectId: PERSONAL_PROJECT_ID,
        environment: { type: "host", workspace: { type: "personal" } },
        prompt: buildWorkerPrompt({ draft: input.text, history, extraInstructions }),
        title: "Prompt pre-walk",
        visibility: "hidden",
        permissionMode: "accept-edits",
        pluginMetadata: { prewalk: true },
        ...selection,
      });
      request.workerId = worker.id;
      if (request.cancelled) return CANCELLED;
      const result = await awaitWorker(worker.id, timeoutSec).catch((error: unknown) => {
        if (request.cancelled) return CANCELLED;
        throw error;
      });
      return request.cancelled ? CANCELLED : result;
    } finally {
      active.delete(input.requestId);
      if (request.workerId !== null) await disposeWorker(request.workerId);
    }
  }
```

В `bb.rpc.register` заменить `cancel`:

```ts
    cancel: async ({ requestId }) => {
      const request = active.get(requestId);
      if (request === undefined) return { cancelled: false };
      request.cancelled = true;
      const { workerId } = request;
      if (workerId !== null) {
        await bb.sdk.threads
          .stop({ threadId: workerId })
          .catch((error: unknown) => bb.log.warn(`stop ${workerId} failed: ${errorMessage(error)}`));
      }
      return { cancelled: true };
    },
```

После `bb.rpc.register(...)` добавить:

```ts
  bb.onDispose(async () => {
    const requests = [...active.values()];
    active.clear();
    await Promise.all(
      requests.map(async (request) => {
        request.cancelled = true;
        const { workerId } = request;
        request.workerId = null;
        if (workerId !== null) await disposeWorker(workerId);
      }),
    );
  });
```

`request.workerId = null` не даёт `finally` в `improve` повторно освобождать уже освобождённый worker. Если dispose пришёлся на момент, когда `spawn` ещё в полёте, worker освободит `finally` во время drain хоста (до 5 с) или sweep из задачи 6 при следующей загрузке.

**Step 4: Run — expect PASS**

Run: `npx vitest run server.test.ts && npm run typecheck`
Expected: все тесты зелёные.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/server.ts plugins/prompt-prewalk/server.test.ts
git commit -m "feat(prompt-prewalk): cancel requests and stop workers on dispose"
```

---

### Task 6: Зачистка осиротевших worker-ов

**Files:**
- Modify: `P/server.ts`
- Test: `P/server.test.ts` (дописать в конец)

**Step 1: Failing tests**

```ts
describe("orphan sweep", () => {
  it("archives and stops hidden orphan workers once, before the first spawn", async () => {
    const sdk = stubs();
    sdk.threads.list = async () => [
      { id: "orphan-1", visibility: "hidden" },
      { id: "visible-1", visibility: "visible" },
    ];
    const harness = await loadWithModel(sdk);
    await harness.callRpc("improve", THREAD_INPUT);
    await harness.callRpc("improve", { ...THREAD_INPUT, requestId: "req-2" });

    expect(argsOf(harness, "threads.list")).toEqual([
      { originPluginId: "prompt-prewalk", includeHidden: true, archived: false },
    ]);
    expect(argsOf(harness, "threads.archive")).toEqual([
      { threadId: "orphan-1" },
      { threadId: "worker-1" },
      { threadId: "worker-1" },
    ]);
    const paths = harness.inspection.sdk.calls.map((call) => call.path);
    expect(paths.indexOf("threads.stop")).toBeLessThan(paths.indexOf("threads.spawn"));
  });

  it("does not block improve when the sweep fails", async () => {
    const sdk = stubs();
    sdk.threads.list = async () => Promise.reject(new Error("list down"));
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toMatchObject({ ok: true });
    expect(harness.inspection.logEntries).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("list down") }),
    );
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run server.test.ts -t "orphan sweep"`
Expected: FAIL — `threads.list` не вызывается.

**Step 3: Implementation** — правки `server.ts`

После `disposeWorker` добавить:

```ts
  let sweep: Promise<void> | null = null;

  /** bb.sdk is unavailable while the plugin loads, so the sweep runs before the first request. */
  function sweepOrphansOnce(): Promise<void> {
    sweep ??= (async () => {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false });
      await Promise.all(threads.filter((thread) => thread.visibility === "hidden").map((thread) => disposeWorker(thread.id)));
    })().catch((error: unknown) => bb.log.warn(`orphan sweep failed: ${errorMessage(error)}`));
    return sweep;
  }
```

В `improve` первой строкой внутри `try` добавить:

```ts
      await sweepOrphansOnce();
```

**Step 4: Run — expect PASS**

Run: `npx vitest run server.test.ts && npm run typecheck`
Expected: все тесты зелёные.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/server.ts plugins/prompt-prewalk/server.test.ts
git commit -m "feat(prompt-prewalk): sweep orphaned worker threads"
```

---

### Task 7: Стор состояния composer-а

**Files:**
- Create: `P/prewalk-store.ts`
- Test: `P/prewalk-store.test.ts`

**Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { getPrewalkState, IDLE, scopeKey, setPrewalkState } from "./prewalk-store";

describe("scopeKey", () => {
  it("gives each composer surface its own key", () => {
    expect(scopeKey({ kind: "thread", threadId: "t1" })).toBe("thread:t1");
    expect(scopeKey({ kind: "new-thread", projectId: "p1" })).toBe("new-thread");
    expect(scopeKey({ kind: "new-thread", projectId: null })).toBe("new-thread");
    expect(scopeKey({ kind: "queued-message", threadId: "t1", queuedMessageId: "q1" })).toBe("queued:q1");
  });
});

describe("prewalk state", () => {
  it("defaults to idle and keeps states per key", () => {
    expect(getPrewalkState("thread:s1")).toBe(IDLE);
    setPrewalkState("thread:s1", { status: "running", requestId: "r1" });
    expect(getPrewalkState("thread:s1")).toEqual({ status: "running", requestId: "r1" });
    expect(getPrewalkState("thread:s2")).toBe(IDLE);
    setPrewalkState("thread:s1", IDLE);
    expect(getPrewalkState("thread:s1")).toBe(IDLE);
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run prewalk-store.test.ts`
Expected: FAIL — `Failed to resolve import "./prewalk-store"`.

**Step 3: Implementation** — `prewalk-store.ts`

```ts
import { useSyncExternalStore } from "react";
import type { PluginComposerScope } from "@get-bb/plugin-sdk/app";

export type PrewalkState =
  | { status: "idle" }
  | { status: "running"; requestId: string }
  | { status: "done"; original: string; improved: string }
  | { status: "error"; message: string };

export const IDLE: PrewalkState = { status: "idle" };

const states = new Map<string, PrewalkState>();
const mentionCounts = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function scopeKey(scope: PluginComposerScope): string {
  switch (scope.kind) {
    case "thread":
      return `thread:${scope.threadId}`;
    case "new-thread":
      return "new-thread";
    case "queued-message":
      return `queued:${scope.queuedMessageId}`;
    case "side-chat":
      return `side-chat:${scope.tabId}`;
  }
}

export function getPrewalkState(key: string): PrewalkState {
  return states.get(key) ?? IDLE;
}

export function setPrewalkState(key: string, state: PrewalkState): void {
  if (state.status === "idle") states.delete(key);
  else states.set(key, state);
  notify();
}

export function setMentionCount(key: string, count: number): void {
  if ((mentionCounts.get(key) ?? 0) === count) return;
  if (count === 0) mentionCounts.delete(key);
  else mentionCounts.set(key, count);
  notify();
}

export function usePrewalkState(key: string): PrewalkState {
  return useSyncExternalStore(subscribe, () => getPrewalkState(key));
}

export function useMentionCount(key: string): number {
  return useSyncExternalStore(subscribe, () => mentionCounts.get(key) ?? 0);
}
```

**Step 4: Run — expect PASS**

Run: `npx vitest run prewalk-store.test.ts && npm run typecheck`
Expected: 2 passed.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/prewalk-store.ts plugins/prompt-prewalk/prewalk-store.test.ts
git commit -m "feat(prompt-prewalk): per-composer pre-walk state"
```

---

### Task 8: Кнопка ✨ в composer

**Files:**
- Replace: `P/app.tsx`
- Test: `P/app.test.tsx`

**Step 1: Failing test** — `app.test.tsx`

```tsx
// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act } from "@testing-library/react";
import { getPrewalkState, IDLE, setMentionCount, setPrewalkState } from "./prewalk-store";

const app = await loadPluginApp(() => import("./app"));
const customization = app.composerCustomizations[0]!;
const button = customization.actions![0]!;
const BUTTON = { name: "Improve prompt with pre-walk" };

function renderButton(
  threadId: string,
  improve: (input: unknown) => unknown,
  text = "fix login",
) {
  return renderSlot(button, {}, {
    composer: { text, scope: { kind: "thread", threadId } },
    rpc: { improve },
  });
}

describe("PrewalkButton", () => {
  it("is registered for thread and new-thread composers", () => {
    expect(customization.scopes).toEqual(["thread", "new-thread"]);
  });

  it("replaces the draft with the improved prompt", async () => {
    const slot = renderButton("b-ok", () => ({ ok: true, text: "Fix the login bug in auth.ts" }));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("Fix the login bug in auth.ts"));
    expect(slot.inspection.composer.inputLockCalls).toEqual([true, false]);
    expect(slot.inspection.rpcCalls[0]).toMatchObject({
      method: "improve",
      input: { text: "fix login", threadId: "b-ok" },
    });
    expect(getPrewalkState("thread:b-ok")).toEqual({
      status: "done",
      original: "fix login",
      improved: "Fix the login bug in auth.ts",
    });
  });

  it("keeps the draft and records the error when the server refuses", async () => {
    const slot = renderButton("b-err", () => ({ ok: false, code: "no_model", message: "Choose a model." }));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(getPrewalkState("thread:b-err")).toEqual({ status: "error", message: "Choose a model." }));
    expect(slot.inspection.composer.text).toBe("fix login");
    expect(slot.inspection.composer.inputLocked).toBe(false);
  });

  it("records a failed RPC call as an error", async () => {
    const slot = renderButton("b-throw", () => {
      throw new Error("server down");
    });
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(getPrewalkState("thread:b-throw")).toEqual({ status: "error", message: "server down" }));
  });

  it("drops the result when the run was cancelled from the banner", async () => {
    let resolve: (value: unknown) => void = () => {};
    const slot = renderButton("b-cancel", () => new Promise((done) => (resolve = done)));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    act(() => setPrewalkState("thread:b-cancel", IDLE));
    resolve({ ok: true, text: "Improved" });
    await waitFor(() => expect(slot.inspection.composer.inputLocked).toBe(false));
    expect(slot.inspection.composer.text).toBe("fix login");
    expect(getPrewalkState("thread:b-cancel")).toBe(IDLE);
  });

  it("drops the result when the composer switched to another thread", async () => {
    let resolve: (value: unknown) => void = () => {};
    const slot = renderButton("b-switch", () => new Promise((done) => (resolve = done)));
    fireEvent.click(slot.getByRole("button", BUTTON));
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(1));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "b-other" });
    resolve({ ok: true, text: "Improved" });
    await waitFor(() => expect(getPrewalkState("thread:b-switch").status).toBe("idle"));
    expect(slot.inspection.composer.text).toBe("fix login");
  });

  it("is disabled for a blank draft", () => {
    const slot = renderButton("b-blank", () => ({ ok: true, text: "x" }), "   ");
    expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true);
  });

  it("is disabled while the draft has @-mentions", async () => {
    const slot = renderButton("b-mention", () => ({ ok: true, text: "x" }));
    setMentionCount("thread:b-mention", 1);
    await waitFor(() => expect(slot.getByRole("button", BUTTON)).toHaveProperty("disabled", true));
  });

  it("works in a new-thread composer without a thread or a project", () => {
    const slot = renderSlot(button, {}, {
      composer: { text: "fix login", scope: { kind: "new-thread", projectId: null } },
      rpc: { improve: () => ({ ok: true, text: "x" }) },
    });
    fireEvent.click(slot.getByRole("button", BUTTON));
    expect(slot.inspection.rpcCalls[0]?.input).toEqual({ requestId: expect.any(String), text: "fix login" });
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run app.test.tsx`
Expected: FAIL — `composerCustomizations[0]` undefined.

**Step 3: Implementation** — `app.tsx`

```tsx
import { useEffect, useRef } from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRpc,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { MAX_DRAFT_CHARS } from "./worker";
import {
  getPrewalkState,
  IDLE,
  scopeKey,
  setMentionCount,
  setPrewalkState,
  useMentionCount,
  usePrewalkState,
} from "./prewalk-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** The worker only needs a thread to read its history; a new-thread draft has none. */
function historyThreadId(scope: PluginComposerScope): string | undefined {
  return scope.kind === "thread" ? scope.threadId : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PrewalkButton() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const state = usePrewalkState(key);
  const mentionCount = useMentionCount(key);
  const latestKey = useRef(key);
  latestKey.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const blocker =
    view.draft.text.trim() === ""
      ? "Write a prompt first"
      : view.draft.text.length > MAX_DRAFT_CHARS
        ? `Prompts longer than ${MAX_DRAFT_CHARS} characters are not supported`
        : mentionCount > 0
          ? "Remove @-mentions first: pre-walk would turn them into plain text"
          : view.run.isSubmitting
            ? "Sending…"
            : state.status === "running"
              ? "Pre-walk is running"
              : null;

  async function run(): Promise<void> {
    if (blocker !== null) return;
    const original = composer.text;
    const requestId = crypto.randomUUID();
    setPrewalkState(key, { status: "running", requestId });
    composer.setInputLock(true);
    const result = await rpc
      .call("improve", { requestId, text: original, threadId: historyThreadId(view.scope) })
      .catch((error: unknown) => ({ ok: false as const, code: "rpc_error" as const, message: errorMessage(error) }));
    composer.setInputLock(false);
    const current = getPrewalkState(key);
    if (current.status !== "running" || current.requestId !== requestId) return; // cancelled from the banner
    if (!mounted.current || latestKey.current !== key) {
      setPrewalkState(key, IDLE);
      return;
    }
    if (result.ok) {
      composer.setText(result.text);
      setPrewalkState(key, { status: "done", original, improved: result.text });
    } else {
      setPrewalkState(key, result.code === "cancelled" ? IDLE : { status: "error", message: result.message });
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      aria-label="Improve prompt with pre-walk"
      title={blocker ?? "Improve prompt with pre-walk"}
      disabled={blocker !== null}
      onClick={() => void run()}
    >
      <Icon name="AiContentGenerator01" className="size-4" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prewalk",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "improve", component: PrewalkButton }],
    richText: {
      onDraftChange: (draft, view) => setMentionCount(scopeKey(view.scope), draft.mentions.length),
    },
  });
});
```

**Step 4: Run — expect PASS**

Run: `npx vitest run app.test.tsx && npm run typecheck`
Expected: 8 passed. Если harness не прокидывает `richText.onDraftChange` в тест, тест «@-mentions» всё равно зелёный: он вызывает `setMentionCount` напрямую.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/app.tsx plugins/prompt-prewalk/app.test.tsx
git commit -m "feat(prompt-prewalk): composer button that rewrites the draft"
```

---

### Task 9: Баннер статуса

**Files:**
- Modify: `P/app.tsx`
- Test: `P/app.test.tsx` (дописать в конец)

**Step 1: Failing tests**

`setPrewalkState` и `IDLE` уже импортированы в задаче 8. В конец файла:

```tsx
const banner = customization.banners![0]!;

function renderBanner(threadId: string, text: string) {
  return renderSlot(banner, {}, {
    composer: { text, scope: { kind: "thread", threadId } },
    rpc: { cancel: () => ({ cancelled: true }) },
  });
}

describe("PrewalkBanner", () => {
  it("cancels at once: the run leaves the store and the server is told", async () => {
    setPrewalkState("thread:n-run", { status: "running", requestId: "req-9" });
    const slot = renderBanner("n-run", "fix login");
    expect(slot.getByRole("status").textContent).toContain("Improving your prompt");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(getPrewalkState("thread:n-run")).toBe(IDLE);
    await waitFor(() => expect(slot.inspection.rpcCalls).toEqual([{ method: "cancel", input: { requestId: "req-9" } }]));
  });

  it("restores the original draft", async () => {
    setPrewalkState("thread:n-done", { status: "done", original: "fix login", improved: "Better" });
    const slot = renderBanner("n-done", "Better");
    fireEvent.click(slot.getByRole("button", { name: "Restore original" }));
    await waitFor(() => expect(slot.inspection.composer.text).toBe("fix login"));
    expect(getPrewalkState("thread:n-done").status).toBe("idle");
  });

  it("hides Restore original after the user edits the improved prompt", () => {
    setPrewalkState("thread:n-edit", { status: "done", original: "fix login", improved: "Better" });
    const slot = renderBanner("n-edit", "Better, edited");
    expect(slot.queryByRole("button", { name: "Restore original" })).toBeNull();
  });

  it("shows an error until dismissed", async () => {
    setPrewalkState("thread:n-err", { status: "error", message: "Choose a model." });
    const slot = renderBanner("n-err", "fix login");
    expect(slot.getByRole("alert").textContent).toContain("Choose a model.");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run app.test.tsx -t PrewalkBanner`
Expected: FAIL — `customization.banners` undefined.

**Step 3: Implementation** — правки `app.tsx`

Перед `export default definePluginApp` добавить:

```tsx
function BannerRow(props: { text: string; action: string; onAction: () => void; role?: "status" | "alert" }) {
  return (
    <div
      role={props.role ?? "status"}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground"
    >
      <span className="min-w-0 truncate">{props.text}</span>
      <Button type="button" variant="ghost" size="sm" onClick={props.onAction}>
        {props.action}
      </Button>
    </div>
  );
}

function PrewalkBanner() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const key = scopeKey(view.scope);
  const state = usePrewalkState(key);

  if (state.status === "running") {
    const cancel = () => {
      // Leaving "running" first makes PrewalkButton drop whatever the server returns for this request.
      setPrewalkState(key, IDLE);
      rpc
        .call("cancel", { requestId: state.requestId })
        .catch((error: unknown) =>
          setPrewalkState(key, { status: "error", message: `Could not cancel: ${errorMessage(error)}` }),
        );
    };
    return <BannerRow text="Improving your prompt…" action="Cancel" onAction={cancel} />;
  }
  if (state.status === "error") {
    return <BannerRow role="alert" text={state.message} action="Dismiss" onAction={() => setPrewalkState(key, IDLE)} />;
  }
  if (state.status === "done" && view.draft.text === state.improved) {
    const restore = () => {
      composer.setText(state.original);
      setPrewalkState(key, IDLE);
    };
    return <BannerRow text="Prompt improved." action="Restore original" onAction={restore} />;
  }
  return null;
}
```

В `app.composer.customize` после `actions` добавить:

```tsx
    banners: [{ id: "status", chrome: "bare", component: PrewalkBanner }],
```

**Step 4: Run — expect PASS**

Run: `npx vitest run app.test.tsx && npm run typecheck`
Expected: все тесты зелёные.

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/app.tsx plugins/prompt-prewalk/app.test.tsx
git commit -m "feat(prompt-prewalk): status banner with cancel and restore"
```

---

### Task 10: Раздел настроек с выбором модели

**Files:**
- Modify: `P/app.tsx`
- Test: `P/app.test.tsx` (дописать в конец)

**Step 1: Failing tests**

```tsx
const settingsSection = app.settingsSections[0]!;
const SELECTION = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" };

describe("ModelSettings", () => {
  it("saves the offered default model on request", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: {
        getModel: () => ({ selection: SELECTION, saved: false }),
        setModel: (selection: unknown) => selection,
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Use this model" }));
    await waitFor(() => expect(slot.inspection.rpcCalls.at(-1)).toEqual({ method: "setModel", input: SELECTION }));
    await waitFor(() => expect(slot.queryByRole("button", { name: "Use this model" })).toBeNull());
  });

  it("explains when no provider is available", async () => {
    const slot = renderSlot(settingsSection, {}, {
      rpc: { getModel: () => ({ selection: null, saved: false }) },
    });
    expect(await slot.findByText(/No provider is available/)).toBeTruthy();
  });
});
```

**Step 2: Run — expect FAIL**

Run: `npx vitest run app.test.tsx -t ModelSettings`
Expected: FAIL — `settingsSections[0]` undefined.

**Step 3: Implementation** — правки `app.tsx`

Импорты: `useState` из react, `experimental_ProviderModelPicker as ProviderModelPicker` из `@get-bb/plugin-sdk/app`, тип `ModelSelection` из `./server`:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useComposer,
  useComposerView,
  useRpc,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import type { ModelSelection, rpcContract } from "./server";
```

Перед `export default definePluginApp` добавить:

```tsx
function ModelSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [model, setModel] = useState<{ selection: ModelSelection | null; saved: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("getModel").then(setModel, (cause: unknown) => setError(errorMessage(cause)));
  }, [rpc]);

  function save(selection: ModelSelection): void {
    setError(null);
    rpc.call("setModel", selection).then(
      (saved) => setModel({ selection: saved, saved: true }),
      (cause: unknown) => setError(errorMessage(cause)),
    );
  }

  const errorLine = error === null ? null : <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (model === null) return errorLine ?? <p className="text-sm text-muted-foreground">Loading…</p>;
  if (model.selection === null) {
    return <p className="text-sm text-muted-foreground">No provider is available. Set up a provider in bb first.</p>;
  }
  const { selection } = model;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <ProviderModelPicker value={selection} onChange={save} />
      {model.saved ? null : (
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">Pre-walk stays off until you save a model.</span>
          <Button type="button" size="sm" onClick={() => save(selection)}>
            Use this model
          </Button>
        </div>
      )}
      {errorLine}
    </div>
  );
}
```

В `definePluginApp` после `app.composer.customize(...)` добавить:

```tsx
  app.slots.settingsSection({
    id: "model",
    title: "Pre-walk model",
    description: "The model that rewrites your prompt. It does not depend on the thread's model.",
    component: ModelSettings,
  });
```

**Step 4: Run — expect PASS**

Run: `npx vitest run app.test.tsx && npm run typecheck`
Expected: все тесты зелёные. Если `ProviderModelPicker` не рендерится в jsdom-harness (падает на host-зависимостях), замокай его через `vi.mock("@get-bb/plugin-sdk/app", …)` только в этом `describe` и оставь проверку пикера на живой тест (Task 13).

**Step 5: Commit**

```bash
git add plugins/prompt-prewalk/app.tsx plugins/prompt-prewalk/app.test.tsx
git commit -m "feat(prompt-prewalk): settings section with a separate model picker"
```

---

### Task 11: Документация плагина

**Files:**
- Create: `P/skills/prompt-prewalk/SKILL.md`
- Replace: `P/README.md`, `P/PLUGIN_OVERVIEW.md`

**Step 1: `skills/prompt-prewalk/SKILL.md`**

```markdown
---
name: prompt-prewalk
description: Explains the Prompt Prewalk plugin — the composer button that rewrites a draft prompt with a separate model, its settings, and its hidden "Prompt pre-walk" worker threads.
---

# Prompt Prewalk

The user can press the pre-walk button in the composer. A separately chosen model then rewrites the draft prompt, and the result replaces the draft before the user sends it.

## Hidden worker threads

Each run spawns one hidden thread titled "Prompt pre-walk". The plugin archives and stops it when the run ends. Do not message, resume, or reuse these threads.

## Settings

- Model: Settings → Installed plugins → Prompt Prewalk → "Pre-walk model". Pre-walk stays off until a model is saved.
- `bb plugin config prompt-prewalk set historyMessages <0-50>` sets how many recent thread messages the model sees.
- `bb plugin config prompt-prewalk set timeoutSec <10-900>` sets how long to wait for the model.
- `bb plugin config prompt-prewalk set extraInstructions "<text>"` adds rules for rewriting.

## Limits

- The button is disabled while the draft has @-mentions: a rewrite would turn them into plain text.
- A run takes as long as the provider needs to start an agent, usually 5–20 s.
```

**Step 2: `README.md`** — коротко: назначение, установка из коллекции (`bb plugin install path:$PWD`), настройки, `npm test`, `npm run typecheck`, `bb plugin build`.

**Step 3: `PLUGIN_OVERVIEW.md`** — 3–5 предложений для каталога: что делает кнопка, что модель выбирается отдельно, что ничего не уходит наружу, кроме вызова выбранного провайдера bb.

**Step 4: Commit**

```bash
git add plugins/prompt-prewalk/skills plugins/prompt-prewalk/README.md plugins/prompt-prewalk/PLUGIN_OVERVIEW.md
git commit -m "docs(prompt-prewalk): skill, readme, overview"
```

---

### Task 12: Полная проверка и сборка

**Step 1:** `npm test` — Expected: все тесты зелёные, 0 failed.
**Step 2:** `npm run typecheck` — Expected: без ошибок.
**Step 3:** `bb plugin build` — Expected: `dist/server.js`, `dist/app.js`, `dist/*.meta.json`, без ошибок про иконку `AiContentGenerator01` или манифест.
**Step 4:** Если сборка потребовала правок — тест на поведение, если оно менялось, затем commit `fix(prompt-prewalk): …`.

---

### Task 13: Cross-model review (Codex)

**Step 1:** Запустить из корня репозитория:

```bash
codex exec --sandbox read-only "Review \`git diff HEAD~1..HEAD -- plugins/prompt-prewalk\` in .. It is a bb plugin: server.ts spawns a hidden worker thread per request and must always archive and stop it; app.tsx adds a composer button and banner. Report only real correctness bugs: races, wrong results, cancellation leaks, leaked worker threads, deadlocks, stale-composer writes, tests that pass for the wrong reason. For each: file:line, failure scenario, fix. 'Nothing found' is a valid answer."
```

**Step 2:** Оценить каждую находку по коду, а не применять вслепую. Для каждой принятой: падающий тест → фикс → зелёный → commit `fix(prompt-prewalk): …`.

---

### Task 14: Живая проверка (только с OK пользователя)

Установка меняет рабочий bb пользователя. Спроси разрешение перед Step 1.

1. `bb plugin install path:$PWD --yes`
2. Settings → Prompt Prewalk: выбрать модель, убедиться, что после сохранения «Use this model» пропадает.
3. В существующем треде: черновик → ✨ → текст заменён, баннер «Prompt improved», «Restore original» возвращает оригинал.
4. В новом треде с выбранным проектом: то же самое.
5. «Cancel» во время работы: баннер исчезает, черновик не тронут.
6. `bb thread list` — скрытых «Prompt pre-walk» тредов не осталось.
7. Черновик с @-упоминанием: кнопка неактивна, в подсказке причина.
8. Проверить, что после `setText` `view.draft.text` совпадает с ответом. Если редактор нормализует текст (перевод строки в конце), «Restore original» не появится — тогда сравнивать через `trimEnd()` и добавить тест.
9. На реальном треде с несколькими ходами: `threads.timeline` отдаёт строки от старых к новым, и в истории worker-а последняя просьба пользователя не вытеснена промежуточными сообщениями агента.
10. Worker на Claude Code и на Codex только переписывает черновик и ничего не делает в worktree (`git status` в окружении треда чистый).
11. Выбрать провайдера, у которого разрешён только режим `full` (например, pi): `threads.spawn` с `permissionMode: "accept-edits"` должен отказать, а не молча поднять режим до `full`. Если поднимает — фильтровать такие провайдеры в `improve` и в `defaultSelection`.
