# sdk/ — клиентская часть

`feedback.js` — headless-ядро, один файл без зависимостей (~2 КБ). Работает
с хостинга, из офлайн-`file://` и как CommonJS-модуль. Готовая форма-оверлей
(`FeedbackRelay.mount`) — этап M3.

## Подключение

```html
<script src="feedback.js"></script> <!-- или инлайном в сборку, как делает unevie -->
<script>
var FEEDBACK_ENDPOINT = 'https://feedback-relay.<acc>.workers.dev'; // ПУСТО → кнопку скрыть

function sendFeedback(text, name) {
  return FeedbackRelay.send(FEEDBACK_ENDPOINT, 'unevie', {
    text: text,
    name: name,                          // опционально
    context: collectContext(),           // проект сам решает, что собрать:
  });                                    // версия, экран, состояние, устройство…
}

sendFeedback('Отличная книга!', 'Тестер')
  .then(function ()  { ui.showThanks(); })
  .catch(function (e) { ui.showError(e.code); });
</script>
```

## Контракт

`FeedbackRelay.send(endpoint, projectId, {text, name?, context?}, {timeoutMs?}) → Promise`

- resolve: `{ok: true}`;
- reject: `Error` с `e.code`:
  - клиентские — `client_empty` (пустой текст, сеть не трогали), `timeout` (8 с
    по умолчанию), `network`;
  - серверные — `empty | bad_json | too_long | origin | unknown_project | rate |
    relay_failed | slack_* | not_configured | http_*`.

Формулировки для пользователя выбирает проект (SDK не навязывает язык и тон);
разумный минимум — различать «отправлено», «слишком часто» (`rate`) и «не
дошло, попробуйте позже» (всё остальное).

## Паттерны из unevie (рекомендуются)

- Кнопка «Оставить отзыв» рендерится только при непустом `FEEDBACK_ENDPOINT` —
  выключение фидбека без пересборки логики.
- `context` собирается в момент отправки (актуальное состояние), ключи —
  человекочитаемые: они попадут в Slack и в issue как есть.
- Не слать ничего автоматически: только явное действие пользователя.
