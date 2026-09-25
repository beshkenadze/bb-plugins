# prompt-prewalk: дизайн

Дата: 2026-09-25 · bb 0.43.4

## Цель

Плагин улучшает промпт пользователя до отправки агенту. Пользователь нажимает ✨ в composer, отдельная модель переписывает черновик, результат встаёт в поле ввода. Пользователь правит его и отправляет обычным Send.

## Решения

| Вопрос | Решение | Почему |
|---|---|---|
| Что делает pre-walk | Переписывает промпт | Выбор пользователя |
| Какая модель | Любой провайдер и модель bb, выбранные в настройках плагина, независимо от модели треда | Работает на подписке, ключи не нужны |
| Как вызывается модель | Скрытый worker-тред (`threads.spawn`, `visibility: "hidden"`) | Плагин не может вызвать helper-inference bb, он его только обслуживает |
| Триггер | Кнопка в composer | Не перехватывает обычную отправку. Хук `message.dispatch` не умеет переписывать текст |
| Контекст worker-а | Черновик + последние N сообщений треда | Нужен для follow-up. Обход репозитория слишком медленный |

Вне MVP: авто-режим на каждый Send, свой API-ключ, обход репозитория worker-ом.

## Архитектура

### Frontend — `app.tsx`

- `app.composer.customize({ id: "prewalk", scopes: ["thread", "new-thread"], actions: [PrewalkButton], banners: [PrewalkBanner] })`.
- **PrewalkButton.** Неактивна при пустом черновике, `isSubmitting`, черновике длиннее 20 000 символов и уже идущем запросе. По клику: `setInputLock(true)` → RPC `improve` → `setText(improved)` → сохранить оригинал → `setInputLock(false)`.
- **PrewalkBanner.** Показывает «Улучшаю промпт… [Отмена]», затем «Промпт улучшен · [Вернуть оригинал]» или текст ошибки. «Вернуть оригинал» доступна, пока текст в поле равен улучшенному.
- **Общий стор** на уровне модуля с ключом по scope: `{ status, requestId, original, improved, error }` через `useSyncExternalStore`.
- **`settingsSection`** содержит `experimental_ProviderModelPicker`. Выбор сохраняется через RPC `setModel`.

### Backend — `server.ts`

- RPC `improve({ requestId, text, threadId | projectId })` → `{ ok: true, text } | { ok: false, code, message }`.
- RPC `cancel({ requestId })` останавливает worker запроса.
- RPC `getModel` / `setModel` хранят `{ providerId, model, reasoningLevel }` в `bb.storage`.
- Настройки: `historyMessages` (6), `timeoutSec` (120), `extraInstructions` (пусто).
- Карта `requestId → workerThreadId` для отмены и `onDispose`.

### Документация — `skills/prompt-prewalk/SKILL.md`

Описывает кнопку, настройки и ограничения.

## Поток данных

1. `selection = storage.get("selection")`. Если пусто → `no_model`.
2. `projectId = threadId ? threads.get(threadId).projectId : projectId`.
3. При `threadId`: последние `historyMessages` сообщений user/assistant из `threads.timeline`, каждое обрезано до 2000 символов.
4. `threads.spawn({ projectId, environment: { type: "project-default" }, prompt, visibility: "hidden", providerId, model, reasoningLevel, pluginMetadata: { prewalk: true } })` без `parentThreadId`: иначе скрытый child репортит свои ходы в тред пользователя.
5. `threads.wait({ status: "idle" })` с таймаутом `timeoutSec` → `threads.output` → извлечь `<prompt>…</prompt>`.
6. `finally`: `threads.archive` + `threads.stop`.

### Промпт worker-а

```
You rewrite a user's request to a coding agent so it is clearer and more actionable.
Rules:
- Keep the user's intent, language, and every concrete detail (paths, names, numbers).
- Do not invent requirements. Put real ambiguities as explicit open questions at the end.
- Do not answer the request. Do not run tools. Do not read or modify files.
- Output ONLY the rewritten prompt inside <prompt>…</prompt>.
{extraInstructions}
<history>…</history>
<draft>…</draft>
```

## Ошибки

Ошибки возвращаются результатом, а не исключением. При любой ошибке черновик остаётся нетронутым, lock снимается.

| Код | Условие |
|---|---|
| `no_model` | модель не выбрана |
| `timeout` | worker не дошёл до `idle` за `timeoutSec` |
| `worker_failed` | worker перешёл в `error` |
| `invalid_response` | в ответе нет `<prompt>…</prompt>` |
| `cancelled` | пользователь нажал «Отмена» |

**Очистка worker-ов:**
- `finally` при каждом запросе.
- Sweep при старте: неархивные скрытые треды плагина с `pluginMetadata.prewalk` архивируются и останавливаются.
- `onDispose` останавливает активные worker-ы.

**Граница доверия.** Вход RPC — `z.object().strict()`: ровно одно из `threadId` / `projectId`, текст от 1 до 20 000 символов. `threadId` проверяется через `threads.get`.

**Смена composer.** Если scope сменился во время запроса, ответ игнорируется.

## Ограничения

- `setText` заменяет весь текст: @-mention-пилюли становятся обычным текстом, вложения сохраняются. Баннер предупреждает об этом.
- Задержка равна старту агента провайдера: 5–20 с.

## Проверить при реализации

- Принимает ли `threads.spawn` поля `providerId`, `model`, `reasoningLevel` и read-only permission mode.
- Несёт ли scope `new-thread` `projectId`. Если нет, MVP ограничится scope `thread`.
- Фильтрует ли `threads.list` по `originPluginId` скрытые треды (`includeHidden: true`).

## Тестирование

Vitest + `@get-bb/plugin-sdk/testing`, TDD.

**Backend** (`createFakePluginHost`):
- happy path;
- история треда и её обрезка;
- `no_model`, `invalid_response`, `timeout`, `worker_failed`;
- archive и stop при каждом исходе;
- `cancel`;
- sweep не трогает чужие треды;
- отказ схемы на неверном входе.

**Frontend** (`loadPluginApp` + `renderSlot`):
- неактивная кнопка;
- клик → `improve` → `composer.text` обновлён, lock снят;
- ошибка → баннер, черновик не изменился;
- «Вернуть оригинал» и её скрытие после правки;
- смена scope во время запроса.

**Live** (`bb plugin dev`):
- выбор модели в настройках;
- ✨ в существующем и новом треде;
- скрытый тред исчезает после ответа.

**Cross-model review.** Staged diff ревьюит Codex (`codex exec --sandbox read-only`). Каждый принятый фикс получает тест, который падает без фикса.

## Уточнения после сверки с SDK 0.5.9

- Плагин лежит в `plugins/prompt-prewalk/`. Корень репозитория — коллекция плагинов с индексом `.bb/plugins.json`.
- Проект worker-у не нужен: тред пользователя нужен только для истории. Кнопка работает в треде и в новом треде, даже без выбранного проекта.
- Read-only режима нет. Worker запускается с самым строгим `permissionMode: "accept-edits"` в изолированной папке, поэтому его правки не затрагивают репозиторий пользователя.
- Worker изолирован: он запускается в личном проекте bb (`proj_personal`) с `environment: { type: "host", workspace: { type: "personal" } }` — пустой временной папкой, которую bb удаляет при архивации. В checkout пользователя worker не попадает, даже с `accept-edits`, который в Claude Code авто-одобряет правки файлов.
- `threads.wait` бросает `ThreadWaitTimeoutError` и `ThreadWaitUnreachableError`. Они дают коды `timeout` и `worker_failed`.
- `bb.sdk` недоступен во время загрузки плагина. Поэтому sweep сирот выполняется один раз перед первым `improve`. Сироты — скрытые неархивные треды с `originPluginId` плагина.
- `useComposerView().draft` не содержит упоминаний. Их число даёт `richText.onDraftChange`. Вместо предупреждения кнопка неактивна, пока в черновике есть @-упоминания: пилюли не теряются молча.
- `getModel` предлагает модель по умолчанию первого доступного провайдера. `improve` работает только после явного сохранения модели.
- UI-тексты на английском, как весь интерфейс bb.
