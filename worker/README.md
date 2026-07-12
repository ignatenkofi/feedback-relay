# worker/ — multi-tenant relay (Cloudflare Worker)

Один деплой на все проекты. Принимает `POST /v1/f/{projectId}`, валидирует,
санитизирует и пересылает в Slack-канал проекта через `chat.postMessage`
(бот-токен). Stateless: ничего не хранит. GitHub-кредов нет по дизайну.

## Первичный деплой

```bash
cd worker
npm install -g wrangler        # если ещё нет
wrangler login                 # один раз
wrangler secret put SLACK_BOT_TOKEN   # xoxb-… (см. «Slack App» ниже)
wrangler deploy
# → https://feedback-relay.<твой-сабдомен>.workers.dev
```

## Slack App (один раз)

1. api.slack.com/apps → Create New App → From scratch.
2. OAuth & Permissions → Bot Token Scopes: `chat:write` (+`chat:write.customize`
   не нужен; metadata входит в chat:write).
3. Install to Workspace → скопировать `xoxb-…` → `wrangler secret put SLACK_BOT_TOKEN`.
4. Пригласить бота в каждый канал `*-feedback` (`/invite @feedback-relay`).

## Добавить проект (цель — ≤15 минут)

1. Создать Slack-канал `#<проект>-feedback`, пригласить бота, скопировать
   channel ID (в UI: детали канала → внизу).
2. PR в `projects.json`: `origins` (хосты + `"null"`, если нужен офлайн-файл),
   `channel`, `repo`, `title`, `emoji`, опц. `rate.perMin`.
3. `wrangler deploy`.
4. На страницу проекта — `sdk/feedback.js` + вызов
   `FeedbackRelay.send(ENDPOINT, '<projectId>', {…})` (см. `sdk/README.md`).

## Тесты

```bash
node --test worker/test/       # чистые функции: origin/санитизация/лимиты/формат
```

Интеграционные тесты fetch-хендлера (miniflare/vitest) — этап M1.

## Операции

- Перевыложить после правок: `wrangler deploy`
- Ротация токена: `wrangler secret put SLACK_BOT_TOKEN` (заново) — без редеплоя проектов
- Логи: `wrangler tail`
- Удалить: `wrangler delete`

## Защита (унаследована от unevie/feedback-worker, обобщена per-project)

- **Origin-политика** — per-project allowlist: точный хост, `*.wildcard`,
  литерал `"null"` для офлайн `file://`; чужим сайтам — 403; отсутствие
  Origin (curl) не блокируем — это защита от чужого фронтенда, не от
  таргетированной атаки. Неизвестный проект — 404, реестр не раскрываем.
- **Санитизация** — управляющие символы/переводы строк из имени и контекста →
  пробел (Slack-разметку и @-упоминания не подделать), экранирование `&<>`;
  лимиты: тело ≤32 КБ, текст ≤4000, имя ≤80, контекст ≤20 ключей.
- **Rate limit, три слоя:** CF ratelimit-binding по ключу `project:ip`
  (кросс-изолятный, `wrangler.toml`) → per-project `rate.perMin` →
  in-isolate скользящее окно (фолбэк для локального dev).
- **Приватность:** IP используется только как ключ лимита, в Slack/issue
  не попадает; воркер не логирует тела запросов.

## Миграция unevie (M1)

Старый воркер `unevie-feedback` **не удалять**: URL вшит в уже розданные
офлайн-файлы. После переезда превратить его в тонкий прокси на
`…/v1/f/unevie` (или оставить как есть до конца жизни офлайн-артефактов),
а `FEEDBACK_URL` в `src/parts/09-engine-ui.js` перевести на новый эндпоинт.
