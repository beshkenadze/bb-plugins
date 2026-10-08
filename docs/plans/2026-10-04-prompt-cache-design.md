# prompt-cache: дизайн

Дата: 2026-10-04 · bb 0.45.0 · plugin SDK 0.6.15

## Цель

Плагин показывает, как работает кеш промпта в треде: какая доля промпта пришла из кеша, сколько осталось до истечения кеша и что делать, если кеш истёк на большом контексте. Аналог мода `observability/prompt-cache-control` из claude-code-templates, но для всех провайдеров bb.

Плагин ничего не кеширует. Кешем управляют CLI и API; bb не стоит между ними.

## Решения

| Вопрос | Решение | Почему |
|---|---|---|
| Один плагин или по плагину на CLI | Один | bb нормализует usage всех провайдеров в событие `thread/tokenUsage/updated` |
| Где логика | Во фронтенде (`useSdk`) | Браузерный SDK читает события треда, подписывается на изменения и вызывает `compact`. Бэкенд объявляет только настройки |
| Где UI | Бейдж в шапке треда, всплывающая панель, баннер над composer | Таблица по ходам, таймер в списке тредов и тосты — второй шаг |
| TTL | Настройка на провайдера: `auto` / `5m` / `1h` | Тип аккаунта и env CLI фронтенд не видит |

## Данные провайдеров (сверено на живых тредах)

| Провайдер | `inputTokens` | Кеш | Гранулярность |
|---|---|---|---|
| claude-code | только новые | `cacheReadInputTokens`, `cacheWriteInputTokens` | сумма за ход (из `result`) |
| codex | включает закешированные | `cachedInputTokens` = чтение, запись 0 | запрос |
| pi | только новые | чтение и запись раздельно | запрос |
| acp | — | событий usage нет | — |

Размер промпта последнего запроса даёт `thread/contextWindowUsage/updated.usedTokens`. У claude-code сумма за ход его не заменяет: ход из нескольких запросов даёт 2,7M при окне 1M.

## Модель — `cache-model.ts`

Чистые функции без React.

- `normalizeUsage(providerId, last)` → `{ read, write, fresh, prompt }`. Для `codex` `fresh = input − read − write`, `prompt = input`. Для остальных `fresh = input`, `prompt = input + read + write`.
- `resolveTtl(providerId, setting, rateLimits)`:
  - `5m` / `1h` из настройки;
  - `auto` для claude-code: `kind: "subscription-window"` со статусом `allowed` или `warning` → 1 ч, иначе 5 мин;
  - `auto` для остальных → 5 мин.
- `deriveCache({ providerId, events, rateLimits, ttlSetting })` → снимок или `null`:
  - события старше последнего `thread/compacted` или `thread/context/cleared` не учитываются;
  - нет usage → `null`, и бейдж не рисуется;
  - `lastActivityAt` = самое свежее из usage и contextWindowUsage;
  - `contextTokens` = `usedTokens` последнего contextWindowUsage, иначе `prompt`.
- `cachePhase(snapshot, now, warnMs)` → `warm` (больше 40% TTL), `cooling`, `expiring` (не больше `warnMs`), `expired`.

## Frontend — `app.tsx`

- `useThreadCache(threadId)`: `threads.get` (провайдер) и три `threads.events.list` с `order: "desc", limit: "1"`: последний usage, последний отчёт о контексте и последние rate limits. Запросы usage и контекста включают `thread/compacted` и `thread/context/cleared`, результаты сливаются по `seq`. Отдельные запросы нужны, чтобы много отчётов о контексте за долгий ход не вытеснили usage со страницы. Подписка `thread:changed` на тред перечитывает данные на `events-appended` с нашими типами событий или без `eventTypes`, а также на `history-compacted` и `history-rewritten`; переподключение realtime тоже перечитывает. Одновременно идёт не больше одной загрузки и ждёт не больше одной следующей; упавшая загрузка не отменяет ждущую.
- Dismiss баннера хранится в общем на модуль сторе (`useSyncExternalStore`), поэтому прячет баннеры треда во всех composer-ах.
- `useNow(active)`: тик раз в секунду, пока идёт отсчёт.
- `experimental_threadHeaderAction` → `CacheBadge`: `98% · 3:41`, цвет точки по фазе; истёкший кеш красит весь бейдж (`destructive`). По клику открывается `Popover` с TTL, полосой времени, разбивкой read / write / new и кнопкой Compact при любом истёкшем кеше.
- `composer.customize({ scopes: ["thread"], banners })` → `CacheBanner`:
  - `expiring` и контекст ≥ 20k: «Cache expires in 0:42…» [Dismiss];
  - `expired`, контекст ≥ `compactAtTokens`: «Cache expired…» [Compact] [Dismiss], красный;
  - не показывается, пока тред работает (`view.run.isRunning`);
  - Dismiss действует до следующей активности кеша.
- Compact: `sdk.threads.compact({ threadId })`, ошибка → `toast.error`.

## Backend — `server.ts`

Только `bb.settings.define`: `claudeCodeTtl`, `codexTtl`, `piTtl` (select `auto`/`5m`/`1h`), `warnSeconds` (60), `compactAtTokens` (100 000), `banner` (true).

## Ограничения

- claude-code: строка «Last turn» — сумма за ход. Отсчёт идёт от последнего события usage или контекста, а TTL — от начала последнего запроса, поэтому оставшееся время завышено на длительность этого запроса.
- `auto` для claude-code видит подписку только после события лимитов в этом треде. Env CLI (`CLAUDE_CODE_PROMPT_CACHE_TTL` и т. п.) плагин не видит — для них есть настройка.
- Codex: TTL у OpenAI плавающий (5–10 мин простоя, до 1 ч); `auto` берёт нижнюю границу.

## Тестирование

Vitest, TDD.

- `cache-model.test.ts`: нормализация трёх провайдеров на реальных числах, TTL, сброс после compact, фазы, форматирование.
- `app.test.tsx` (`renderSlot` с фейками `sdk`): бейдж, отсутствие бейджа без данных, баннер в фазах, Compact, Dismiss.
- Live: `bb plugin install` + тред claude-code и codex.
- Cross-model review: Codex (`codex exec --sandbox read-only`).
