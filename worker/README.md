# worker/ — multi-tenant relay (Cloudflare Worker)

Один деплой на все проекты. Принимает `POST /v1/f/{projectId}`, валидирует,
санитизирует и пересылает в Slack-канал проекта через `chat.postMessage`
(бот-токен). Stateless: ничего не хранит. GitHub-кредов нет по дизайну.

Наблюдаемость деливери (#12): `GET /v1/health/{projectId}` — проба пути
доставки (`auth.test` + `conversations.info`). Наружу только `{ok}` /
`{ok:false}` (503) — публичный эндпоинт не оракул конфигурации; коды ошибок
Slack — в логе (`wrangler tail`). Результат кэшируется в изоляте 60 с, лимит
жёстче POST-пути (3/мин с ip). Задуман как шаг триаж-Routine (M2): раз в свип
дёрнуть health каждого проекта, fail → строка в сводке владельцу.

## Первичный деплой

```bash
cd worker
npm install -g wrangler        # если ещё нет
wrangler login                 # один раз
wrangler secret put SLACK_BOT_TOKEN   # xoxb-… (см. «Slack App» ниже)
wrangler deploy
# → https://feedback-relay.<твой-сабдомен>.workers.dev
```

> Требуется **wrangler ≥ 4.0**: воркер импортирует реестр через import attributes
> (`import PROJECTS from './projects.json' with { type: 'json' }`), ранние версии
> его не собирают. CI гоняет `wrangler deploy --dry-run` — ловит несовместимость
> версии и синтаксис `wrangler.toml` без аккаунта и секретов.

## Slack App (один раз)

> **Один токен — один воркспейс, и это архитектурное следствие.** Воркер держит
> единственный секрет `SLACK_BOT_TOKEN` и постит им в канал любого тенанта
> (`worker.js` → `chat.postMessage`), а токен бота действует в пределах одного
> воркспейса. Значит мультитенантность здесь — **канал на проект внутри одного
> воркспейса**, а не воркспейс на проект. Тот воркспейс, куда установлено
> приложение, становится домом каналов ВСЕХ проектов.
> Решение (2026-07-25): хаб фидбека портфеля — личный воркспейс владельца, тот
> самый, где уже жило приложение `unevie-feedback`; так у канала unevie
> сохранилась история отзывов. Вариант «воркспейс на проект» потребовал бы
> токена на тенанта в реестре — от секрета-на-канал отказались в DESIGN §2.2.

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
npm test   # = node --test test/worker.test.mjs test/fetch.test.mjs
```

`worker.test.mjs` — чистые функции (origin/санитизация/лимиты/формат);
`fetch.test.mjs` — хендлер целиком с mock Slack: happy-path, error-ветки,
health-проба, AE-точки. CF-рантайм (настоящий binding, эдж-CORS) — за
wrangler-смоуком.

## Операции

- Перевыложить после правок: `wrangler deploy`
- Ротация токена: `wrangler secret put SLACK_BOT_TOKEN` (заново) — без редеплоя проектов
- Логи: `wrangler tail`
- Здоровье доставки проекта: `curl https://<worker>/v1/health/<projectId>` →
  `{"ok":true}` | 503; детали фейла — в `wrangler tail`
- Счётчики исходов (opt-in): раскомментировать AE-биндинг в `wrangler.toml`
  (см. комментарий там же) — точки пишутся без текста отзывов
- Удалить: `wrangler delete`

## Защита (унаследована от unevie/feedback-worker, обобщена per-project)

- **Origin-политика** — per-project allowlist: точный хост, `*.wildcard`,
  литерал `"null"` для офлайн `file://`; чужим сайтам — 403; отсутствие
  Origin (curl) не блокируем — это защита от чужого фронтенда, не от
  таргетированной атаки. Неизвестный проект — 404, реестр не раскрываем.
- **Санитизация** — управляющие символы/переводы строк из имени и контекста →
  пробел (Slack-разметку и @-упоминания не подделать), экранирование `&<>`;
  лимиты: тело ≤96 КБ (UTF-8-байты, DoS-guard — сумма пофилдовых лимитов влезает
  и в кириллице/эмодзи), текст ≤4000 символов, имя ≤80, контекст ≤20 ключей.
- **Rate limit:** кросс-изолятный CF ratelimit-binding по ключу `project:ip` —
  **фиксированный потолок** (сейчас 6/мин для всех проектов, `wrangler.toml`);
  `rate.perMin` — **best-effort** ужатие в пределах изолята (фолбэк для локального
  dev и точечного ужесточения ниже потолка; поднять лимит выше binding им нельзя).
  CI отклоняет `perMin` больше потолка binding.
- **Приватность:** IP используется только как ключ лимита, в Slack/issue
  не попадает; воркер не логирует тела запросов.

## Миграция unevie (M1)

Старый воркер `unevie-feedback` **не удалять**: URL вшит в уже розданные
офлайн-файлы. После переезда превратить его в тонкий прокси на
`…/v1/f/unevie` (или оставить как есть до конца жизни офлайн-артефактов),
а `FEEDBACK_URL` в `src/parts/09-engine-ui.js` перевести на новый эндпоинт.
