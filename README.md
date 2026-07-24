# feedback-relay

Единый приём фидбека для всех проектов: кнопка «оставить отзыв» на странице →
Cloudflare Worker (multi-tenant relay) → Slack-канал проекта (карантин и
триаж) → Claude Routine → GitHub issues.

Выделен из `unevie/feedback-worker` — механизм обкатан на книге «ЖИЗНЬ» и
обобщён: новый проект подключается записью в конфиге и сниппетом на странице,
без собственного бэкенда и без копий воркера.

```
страница → POST /v1/f/{project} → [origin/санитизация/лимиты] → Slack #project-feedback
                                                                      │
GitHub issues  ◀─  Claude Routine (свип, ✅-протокол)  ◀──────────────┘
```

## Карта репозитория

| Путь | Что |
|---|---|
| `DESIGN.md` | архитектура, принятые решения, контракты, требования, этапы |
| `worker/` | multi-tenant CF Worker + реестр `projects.json` + тесты + деплой |
| `sdk/` | `feedback.js` — headless-ядро; `feedback-form.js` — готовая форма-оверлей (`mount`); `demo.html` |
| `triage/ROUTINE.md` | протокол триаж-свипа Slack → GitHub для Claude Routine |

## Быстрый старт

- **Развернуть relay:** `worker/README.md` (wrangler + один секрет `SLACK_BOT_TOKEN`).
- **Подключить проект:** там же, раздел «Добавить проект» (цель — ≤15 минут).
- **Встроить на страницу:** `sdk/README.md`.
- **Настроить триаж:** `triage/ROUTINE.md`.

## Статус

Скелет по итогам проектирования 2026-07-12 (решения зафиксированы в
`DESIGN.md` §2). Этапы M1–M4 — в issues репозитория.
