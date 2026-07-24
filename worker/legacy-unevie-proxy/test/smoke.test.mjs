/* Смоук legacy-unevie-proxy — оффлайн, инжектированный fetch (без сети/аккаунта),
 * как чистые тесты relay. Запуск: node --test worker/legacy-unevie-proxy/test/
 *
 * Ключевой кейс — офлайн-клиент из file:// (Origin: null): его отправляют
 * розданные книги, и после переезда он обязан работать через прокси. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, CORS } from '../worker.js';

const ENDPOINT = 'https://feedback-relay.example.workers.dev/v1/f/unevie';
const ENV = { RELAY_ENDPOINT: ENDPOINT };

/* fake fetch: пишет вызов в calls, возвращает заготовленный ответ relay */
function fakeFetch(calls, resp) {
  return async (url, init) => {
    calls.push({ url, init });
    if (typeof resp === 'function') return resp();
    return resp;
  };
}
const relayJson = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function req(method, headers, body) {
  return new Request('https://unevie-feedback.example.workers.dev/', { method, headers, body });
}

test('OPTIONS → 200 с прежним CORS-preflight, без обращения к relay', async () => {
  const calls = [];
  const res = await handleRequest(req('OPTIONS'), ENV, fakeFetch(calls, relayJson({ ok: true })));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), CORS['Access-Control-Allow-Methods']);
  assert.equal(calls.length, 0);
});

test('POST из file:// (Origin: null) → форвард с пробросом Origin и CF-Connecting-IP', async () => {
  const calls = [];
  const body = JSON.stringify({ text: 'офлайн-отзыв', sdk: '0.1.0' });
  const res = await handleRequest(
    req('POST', { 'Origin': 'null', 'CF-Connecting-IP': '203.0.113.7', 'Content-Type': 'application/json' }, body),
    ENV, fakeFetch(calls, relayJson({ ok: true })));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);                       // на relay-эндпоинт unevie
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Origin'], 'null');      // офлайн-origin проброшен как есть
  assert.equal(calls[0].init.headers['CF-Connecting-IP'], '203.0.113.7'); // реальный IP, не прокси
  assert.equal(calls[0].init.body, body);                     // тело форвардится дословно

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });           // прежний контракт клиенту
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('POST без Origin (curl) → Origin на форварде не выставляется', async () => {
  const calls = [];
  const res = await handleRequest(
    req('POST', { 'CF-Connecting-IP': '198.51.100.9' }, JSON.stringify({ text: 'x' })),
    ENV, fakeFetch(calls, relayJson({ ok: true })));
  assert.equal(res.status, 200);
  assert.ok(!('Origin' in calls[0].init.headers));            // отсутствие Origin не подделываем
  assert.equal(calls[0].init.headers['CF-Connecting-IP'], '198.51.100.9');
});

test('ответ relay проксируется как есть — статус и коды сохранены (429 rate)', async () => {
  const calls = [];
  const res = await handleRequest(
    req('POST', { 'Origin': 'null' }, JSON.stringify({ text: 'x' })),
    ENV, fakeFetch(calls, relayJson({ ok: false, error: 'rate' }, 429)));
  assert.equal(res.status, 429);                              // код как у relay
  assert.deepEqual(await res.json(), { ok: false, error: 'rate' });
});

test('не-POST метод → 405, как у relay', async () => {
  const calls = [];
  const res = await handleRequest(req('GET'), ENV, fakeFetch(calls, relayJson({ ok: true })));
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { ok: false, error: 'method' });
  assert.equal(calls.length, 0);
});

test('RELAY_ENDPOINT не задан → 500 not_configured, relay не дёргаем', async () => {
  const calls = [];
  const res = await handleRequest(req('POST', { 'Origin': 'null' }, '{"text":"x"}'), {}, fakeFetch(calls, relayJson({ ok: true })));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'not_configured' });
  assert.equal(calls.length, 0);
});

test('relay недоступен (fetch бросает) → 502 relay_failed', async () => {
  const throwing = async () => { throw new Error('network down'); };
  const res = await handleRequest(req('POST', { 'Origin': 'null' }, '{"text":"x"}'), ENV, throwing);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { ok: false, error: 'relay_failed' });
});
