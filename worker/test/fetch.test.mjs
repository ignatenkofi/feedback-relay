/* Интеграционные тесты fetch-хендлера (issue #1, тест-пункт M1): полный
 * happy-path с mock Slack и все error-ветки, включая комбинированный сценарий
 * «429 + IP-атрибуция» — что лимит считается по ключу `${project}:${ip}`.
 *
 * Хендлер зовётся напрямую (node:test, без miniflare): ratelimit-binding
 * мокается объектом с limit(), Slack — подменой globalThis.fetch. Это
 * сознательный компромисс — CF-рантайм (настоящий binding, CORS-препроцесс
 * эджа) остаётся за wrangler-смоуком M1; здесь фиксируется логика хендлера. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const URL_OK = 'https://relay.example/v1/f/unevie';
const ORIGIN = 'https://unevie.pages.dev';

/* Slack-мок: успех по умолчанию, каждый вызов записывается. */
function slackMock({ status = 200, body = { ok: true } } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, payload: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

const realFetch = globalThis.fetch;
let slack;
beforeEach(() => { slack = slackMock(); globalThis.fetch = slack; });
afterEach(() => { globalThis.fetch = realFetch; });

/* env c валидным токеном; binding подставляется по месту. */
const env = (extra = {}) => ({ SLACK_BOT_TOKEN: 'xoxb-test', ...extra });

/* Запрос с валидным телом; ip обязателен почти везде — без него нет ключа RL. */
function req({ ip = '203.0.113.7', origin = ORIGIN, url = URL_OK, method = 'POST',
               body = JSON.stringify({ text: 'привет из теста' }), headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (origin !== undefined) h.Origin = origin;
  if (ip) h['CF-Connecting-IP'] = ip;
  return new Request(url, { method, headers: h, body: method === 'POST' ? body : undefined });
}

const jsonOf = async (res) => JSON.parse(await res.text());

test('fetch: happy-path — 200, Slack получает канал проекта и metadata feedback_v1', async () => {
  const res = await worker.fetch(req({ ip: '198.51.100.1' }), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonOf(res), { ok: true });
  assert.equal(slack.calls.length, 1);
  const sent = slack.calls[0];
  assert.equal(sent.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(sent.init.headers.Authorization, 'Bearer xoxb-test');
  assert.equal(sent.payload.channel, 'C0BCYPYFF2Q');
  assert.equal(sent.payload.metadata.event_type, 'feedback_v1');
  assert.ok(res.headers.get('Access-Control-Allow-Origin'), 'CORS в ответе');
});

test('fetch: OPTIONS — preflight с CORS без тела', async () => {
  const res = await worker.fetch(req({ method: 'OPTIONS' }), env());
  assert.ok(res.headers.get('Access-Control-Allow-Origin'));
  assert.equal(slack.calls.length, 0);
});

test('fetch: не-POST — 405, без токена — 500, кривой путь и чужой проект — 404', async () => {
  assert.equal((await worker.fetch(req({ method: 'GET' }), env())).status, 405);
  assert.equal((await worker.fetch(req(), { })).status, 500);
  assert.equal((await worker.fetch(req({ url: 'https://relay.example/other' }), env())).status, 404);
  assert.equal((await worker.fetch(req({ url: 'https://relay.example/v1/f/ghost' }), env())).status, 404);
  assert.equal(slack.calls.length, 0);
});

test('fetch: чужой Origin — 403; Origin: null проходит для unevie (офлайн file://)', async () => {
  const bad = await worker.fetch(req({ origin: 'https://evil.example' }), env());
  assert.equal(bad.status, 403);
  assert.deepEqual(await jsonOf(bad), { ok: false, error: 'origin' });
  const offline = await worker.fetch(req({ origin: 'null', ip: '198.51.100.2' }), env());
  assert.equal(offline.status, 200);
});

test('#22 fetch: 429 + IP-атрибуция — binding получает ключ project:ip и режет по нему', async () => {
  const keys = [];
  const rl = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const res = await worker.fetch(req({ ip: '203.0.113.77' }), env({ FEEDBACK_RL: rl }));
  assert.equal(res.status, 429);
  assert.deepEqual(await jsonOf(res), { ok: false, error: 'rate' });
  /* атрибуция: лимит считается на пару проект+IP, не глобально и не по проекту */
  assert.deepEqual(keys, ['unevie:203.0.113.77']);
  assert.equal(slack.calls.length, 0, 'до Slack не дошли');
});

test('#22 fetch: binding зелёный, но in-isolate фолбэк ужимает по cfg.rate.perMin; чужой IP не задет', async () => {
  const keys = [];
  const rl = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  const e = env({ FEEDBACK_RL: rl });
  /* у unevie perMin=6: первые 6 проходят, 7-й — 429 от фолбэка (binding при этом зелёный) */
  for (let i = 0; i < 6; i++)
    assert.equal((await worker.fetch(req({ ip: '203.0.113.88' }), e)).status, 200);
  const seventh = await worker.fetch(req({ ip: '203.0.113.88' }), e);
  assert.equal(seventh.status, 429);
  assert.equal(keys.length, 7, 'binding спрашивали каждый раз');
  /* IP-атрибуция фолбэка: другой IP того же проекта не задет */
  assert.equal((await worker.fetch(req({ ip: '203.0.113.89' }), e)).status, 200);
});

test('fetch: binding бросает (локальный dev) — работает фолбэк, а не открытые ворота', async () => {
  const rl = { limit: async () => { throw new Error('binding unavailable'); } };
  const e = env({ FEEDBACK_RL: rl });
  for (let i = 0; i < 6; i++)
    assert.equal((await worker.fetch(req({ ip: '203.0.113.99' }), e)).status, 200);
  assert.equal((await worker.fetch(req({ ip: '203.0.113.99' }), e)).status, 429);
});

test('fetch: без CF-Connecting-IP rate limit не применяется — задокументированное поведение', async () => {
  /* Вне Cloudflare заголовка нет; оба слоя пропускают. Фиксируем как контракт:
   * если он изменится — тест заставит осознанно перерешать. */
  const rl = { limit: async () => { throw new Error('не должен вызываться'); } };
  const res = await worker.fetch(req({ ip: '' }), env({ FEEDBACK_RL: rl }));
  assert.equal(res.status, 200);
});

test('fetch: Content-Length больше MAX_BODY — 413 до чтения тела', async () => {
  const res = await worker.fetch(
    req({ ip: '198.51.100.3', headers: { 'Content-Length': String(97 * 1024) } }), env());
  assert.equal(res.status, 413);
  assert.equal(slack.calls.length, 0);
});

test('fetch: битый payload — ошибка parsePayload, до Slack не доходит', async () => {
  const res = await worker.fetch(req({ ip: '198.51.100.4', body: '{"text":""}' }), env());
  assert.ok(res.status >= 400 && res.status < 500);
  assert.equal(slack.calls.length, 0);
});

test('fetch: логическая ошибка Slack — 502 slack_*, без ретрая', async () => {
  globalThis.fetch = slack = slackMock({ body: { ok: false, error: 'channel_not_found' } });
  const res = await worker.fetch(req({ ip: '198.51.100.5' }), env());
  assert.equal(res.status, 502);
  assert.deepEqual(await jsonOf(res), { ok: false, error: 'slack_channel_not_found' });
  assert.equal(slack.calls.length, 1, 'логические ошибки не ретраим');
});
