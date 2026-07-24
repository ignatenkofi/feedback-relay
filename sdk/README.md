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

## Готовая форма-оверлей (`mount`, M3)

`feedback-form.js` — опциональная надстройка над ядром: кнопка + модальный
оверлей (textarea + опц. имя) из коробки, для проектов **без своего UI**. unevie
её не подключает — у него свой диалог поверх только `send()` (DESIGN.md §2 п.4).
Грузится вторым скриптом, добавляет `FeedbackRelay.mount`:

```html
<script src="feedback.js"></script>       <!-- ядро: FeedbackRelay.send -->
<script src="feedback-form.js"></script>  <!-- надстройка: FeedbackRelay.mount -->
<script>
  var handle = FeedbackRelay.mount({
    endpoint: 'https://feedback-relay.<acc>.workers.dev',
    project:  'unevie',
    theme:    'auto',                       // 'auto' (по умолч.) | 'light' | 'dark'
    lang:     'ru',                         // 'ru' | 'en' | (авто по <html lang>)
    context:  function () { return { экран: location.pathname }; }, // собирается при отправке
  });
  // handle.open() / handle.close() / handle.destroy() — программное управление
</script>
```

**Опции:** `endpoint`, `project` (обязательны) · `button` — `false` (без кнопки,
свой триггер через `handle.open()`), CSS-селектор или DOM-элемент (привязка к
существующему), иначе плавающая кнопка · `labels` — переопределение любых
подписей (встроенные наборы `ru`/`en`) · `theme` · `lang` · `context` — коллектор,
вызывается в момент отправки · `timeoutMs` — проброс в `send()`.

**Свойства:** без зависимостей, один вшитый `<style>`; light/dark по
`prefers-color-scheme` с явным override в обе стороны; a11y — `role="dialog"`,
`aria-modal`, focus-trap, Esc, возврат фокуса на триггер; три исхода различимы
(«отправлено» / «слишком часто» = `rate` / «не дошло»). Ядро + форма ≤10 КБ в
проде (терсер: 9.6 КБ, gzip: 6.6 КБ; ядро «~2 КБ» — это его minified/gzip, как и
здесь). Ручное демо — `sdk/demo.html` против `wrangler dev`.

## Паттерны из unevie (рекомендуются)

- Кнопка «Оставить отзыв» рендерится только при непустом `FEEDBACK_ENDPOINT` —
  выключение фидбека без пересборки логики.
- `context` собирается в момент отправки (актуальное состояние), ключи —
  человекочитаемые: они попадут в Slack и в issue как есть.
- Не слать ничего автоматически: только явное действие пользователя.
