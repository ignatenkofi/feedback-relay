/* Тесты чистых функций формы-оверлея (feedback-form.js), node:test.
 * Запуск: node --test sdk/test/
 * DOM-часть (mount, focus trap, оверлей) проверяется вручную через sdk/demo.html
 * против `wrangler dev` — так же, как воркер откладывает miniflare-интеграцию. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mount, resolveLabels, errorText, pickLang, DEFAULT_LABELS } = require('../feedback-form.js');

test('DEFAULT_LABELS: два набора (ru/en) с одинаковыми ключами', () => {
  const ru = Object.keys(DEFAULT_LABELS.ru).sort();
  const en = Object.keys(DEFAULT_LABELS.en).sort();
  assert.deepEqual(ru, en);
  for (const k of ru) {
    assert.equal(typeof DEFAULT_LABELS.ru[k], 'string');
    assert.equal(typeof DEFAULT_LABELS.en[k], 'string');
  }
});

test('pickLang: явный ru/en, мусор и пусто → ru (в node нет <html lang>)', () => {
  assert.equal(pickLang('ru'), 'ru');
  assert.equal(pickLang('en'), 'en');
  assert.equal(pickLang(undefined), 'ru');
  assert.equal(pickLang('fr'), 'ru');
  assert.equal(pickLang(''), 'ru');
});

test('resolveLabels: встроенный набор + переопределения поверх', () => {
  const ru = resolveLabels(undefined, 'ru');
  assert.equal(ru.button, DEFAULT_LABELS.ru.button);
  assert.equal(ru.submit, 'Отправить');

  const en = resolveLabels(undefined, 'en');
  assert.equal(en.submit, 'Send');

  // переопределяется только переданный ключ, остальное — из набора
  const custom = resolveLabels({ button: 'Мнение', submit: 'Го' }, 'ru');
  assert.equal(custom.button, 'Мнение');
  assert.equal(custom.submit, 'Го');
  assert.equal(custom.title, DEFAULT_LABELS.ru.title);
});

test('resolveLabels: null/undefined-переопределения игнорируются, значения строкуются', () => {
  const L = resolveLabels({ button: null, submit: undefined, title: 42 }, 'ru');
  assert.equal(L.button, DEFAULT_LABELS.ru.button); // null не затирает
  assert.equal(L.submit, DEFAULT_LABELS.ru.submit); // undefined не затирает
  assert.equal(L.title, '42');                      // приведено к строке
});

test('resolveLabels: неизвестный язык → ru-фолбэк', () => {
  assert.equal(resolveLabels(undefined, 'xx').submit, DEFAULT_LABELS.ru.submit);
});

test('errorText: rate и client_empty различимы, остальное generic', () => {
  const L = resolveLabels(undefined, 'ru');
  assert.equal(errorText('client_empty', L), L.empty);
  assert.equal(errorText('rate', L), L.rate);
  assert.equal(errorText('slack_channel_not_found', L), L.error);
  assert.equal(errorText('network', L), L.error);
  assert.equal(errorText(undefined, L), L.error);
  // три исхода различны — «отправлено / слишком часто / не дошло» (DESIGN.md §8)
  assert.notEqual(L.rate, L.error);
});

test('mount: экспортирован как функция; без DOM бросает понятную ошибку', () => {
  assert.equal(typeof mount, 'function');
  assert.throws(() => mount({ endpoint: 'x', project: 'p' }), /требует DOM|DOM/);
});
