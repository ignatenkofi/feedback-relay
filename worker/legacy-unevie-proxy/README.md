# legacy-unevie-proxy — прокси старого эндпоинта unevie-feedback

Старый URL `unevie-feedback.<acc>.workers.dev` вшит в уже розданные офлайн-файлы
книги «ЖИЗНЬ» — после переезда unevie на relay он обязан продолжать работать
(DESIGN.md §8, worker/README.md «Миграция unevie», issue #8). Этот воркер
деплоится **поверх** старого (то же имя `unevie-feedback` → тот же URL) и
проксирует запросы на `…/v1/f/unevie`, вместо того чтобы держать вторую,
расходящуюся копию кода доставки.

Прокси stateless и без секретов. Свой rate limit не держит — лимитирует relay
по проброшенному реальному IP клиента (`CF-Connecting-IP`).

## Чек-лист замены (деплой — шаг ВЛАДЕЛЬЦА)

Предусловие: relay задеплоен, а проект `unevie` в `worker/projects.json` —
«живой» (реальный `channel`, снят `_draft`, бот приглашён в канал). Пока unevie
в статусе `_draft`, relay отвечает на него 404, и прокси будет отдавать 404.

1. **Подставить сабдомен relay.** В `wrangler.toml` заменить
   `<your-subdomain>` в `RELAY_ENDPOINT` на реальный
   (`https://feedback-relay.<acc>.workers.dev/v1/f/unevie`). Это URL, не секрет.
2. **Оффлайн-смоук (без сети/аккаунта).** Прогнать юнит-смоук прокси:
   ```bash
   node --test worker/legacy-unevie-proxy/test/
   ```
   Покрывает file://-кейс (Origin: null), проброс Origin/CF-Connecting-IP,
   сохранение контракта `{ok:…}` и кодов, ветки 405/500/502.
3. **Задеплоить поверх старого воркера** (тем же именем — заменяет код, URL цел):
   ```bash
   cd worker/legacy-unevie-proxy
   wrangler deploy          # тот же аккаунт, где живёт unevie-feedback
   ```
4. **Живой смоук из офлайн-контекста** (Origin: null — как шлёт розданный файл):
   ```bash
   curl -sS -X POST 'https://unevie-feedback.<acc>.workers.dev/' \
     -H 'Origin: null' -H 'Content-Type: application/json' \
     --data '{"text":"проверка legacy-прокси","sdk":"legacy"}'
   # ждём: {"ok":true}  → сообщение упало в Slack-канал unevie
   ```
   И проверить, что «чужой» origin по-прежнему отбивается (relay возвращает 403):
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST 'https://unevie-feedback.<acc>.workers.dev/' \
     -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
     --data '{"text":"x"}'    # ждём: 403
   ```
5. **Проверить rate limit по реальному IP.** В `wrangler tail` убедиться, что
   relay считает лимит по IP клиента, а не по egress-IP прокси (см. предупреждение
   ниже). Порог — общий binding relay (сейчас 6/мин, `worker/wrangler.toml`).

## Предупреждение (owner): CF-Connecting-IP на вызове воркер→воркер

Прокси выставляет `CF-Connecting-IP` реального клиента на исходящем запросе к
relay. Но при subrequest воркер→воркер Cloudflare может **переустановить** этот
заголовок на egress-IP прокси — тогда relay начнёт лимитировать по одному IP
(прокси) на всех. Проверить на живом стенде (`wrangler tail`). Если так —
это решение владельца отдельным шагом: например, relay читает
`X-Forwarded-For` от доверенного прокси. В этом PR relay НЕ трогается.

## Старый rate-limit binding (namespace 1001)

Не переносим: прокси свой лимит не держит (лимитирует relay). Старый namespace
`1001` тем самым освобождается. Комментарий в `worker/wrangler.toml` про
«1001 занят unevie-feedback» после этого деплоя устаревает — конфликта нет
(relay на 1002), правку комментария оставляю владельцу.

## Откат

`wrangler rollback` (или повторный деплой прежней версии) возвращает старый
воркер — URL при этом не меняется, офлайн-файлы продолжают работать.
