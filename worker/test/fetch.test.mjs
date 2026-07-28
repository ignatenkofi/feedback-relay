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

/* ---------- GET /v1/health/{projectId} (#12) ---------- */

import { HEALTH_CACHE } from '../worker.js';

/* Slack-мок с раздельными ответами по методам API: url → body */
function slackApiMock(map) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body });
    const method = String(url).split('/').pop();
    const body = (map && map[method]) || { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const HURL = 'https://relay.example/v1/health/unevie';
const hreq = ({ ip = '10.9.0.1', url = HURL } = {}) =>
  new Request(url, { method: 'GET', headers: ip ? { 'CF-Connecting-IP': ip } : {} });

test('health: happy-path — auth.test + conversations.info, 200 {ok:true}', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock();
  const res = await worker.fetch(hreq({ ip: '10.9.1.1' }), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await jsonOf(res), { ok: true });
  assert.equal(slack.calls.length, 2);
  assert.ok(slack.calls[0].url.endsWith('/auth.test'));
  assert.ok(slack.calls[1].url.endsWith('/conversations.info'));
  assert.match(String(slack.calls[1].body), /channel=C0BCYPYFF2Q/);
  assert.equal(slack.calls[0].init.headers.Authorization, 'Bearer xoxb-test');
});

test('health: invalid_auth — 503 {ok:false}, канал не проверяем', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock({ 'auth.test': { ok: false, error: 'invalid_auth' } });
  const res = await worker.fetch(hreq({ ip: '10.9.2.1' }), env());
  assert.equal(res.status, 503);
  assert.deepEqual(await jsonOf(res), { ok: false });
  assert.equal(slack.calls.length, 1, 'после падения auth канал скипаем');
});

test('health: channel_not_found — 503, наружу без кода ошибки', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock({
    'conversations.info': { ok: false, error: 'channel_not_found' },
  });
  const res = await worker.fetch(hreq({ ip: '10.9.3.1' }), env());
  assert.equal(res.status, 503);
  assert.deepEqual(await jsonOf(res), { ok: false }, 'код ошибки Slack наружу не утекает');
  assert.equal(slack.calls.length, 2);
});

test('health: неизвестный проект — 404, GET на прочие пути — 405, Slack не зовём', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock();
  assert.equal((await worker.fetch(hreq({ url: 'https://relay.example/v1/health/ghost', ip: '10.9.4.1' }), env())).status, 404);
  assert.equal((await worker.fetch(hreq({ url: 'https://relay.example/v1/f/unevie', ip: '10.9.4.2' }), env())).status, 405);
  assert.equal(slack.calls.length, 0);
});

test('health: кэш изолята — повторный GET в TTL не зовёт Slack снова', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock();
  await worker.fetch(hreq({ ip: '10.9.5.1' }), env());
  const res2 = await worker.fetch(hreq({ ip: '10.9.5.2' }), env());
  assert.equal(res2.status, 200);
  assert.equal(slack.calls.length, 2, 'вторая проба — из кэша, всё те же 2 вызова');
});

test('health: binding зовётся с ключом health:{project}:{ip}', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock();
  const keys = [];
  const rl = { limit: async ({ key }) => { keys.push(key); return { success: true }; } };
  await worker.fetch(hreq({ ip: '10.9.6.1' }), env({ FEEDBACK_RL: rl }));
  assert.deepEqual(keys, ['health:unevie:10.9.6.1']);
});

test('health: in-isolate фолбэк — 4-й GET с одного ip за минуту → 429', async () => {
  HEALTH_CACHE.clear();
  globalThis.fetch = slack = slackApiMock();
  for (let i = 0; i < 3; i++)
    assert.equal((await worker.fetch(hreq({ ip: '10.9.7.1' }), env())).status, 200);
  const res = await worker.fetch(hreq({ ip: '10.9.7.1' }), env());
  assert.equal(res.status, 429);
});

/* ---------- Analytics Engine точки исходов (#12, opt-in) ---------- */

function aeMock() {
  const points = [];
  return { writeDataPoint: (p) => points.push(p), points };
}

test('AE: happy-path POST пишет точку {project, ok}; без биндинга — работает как раньше', async () => {
  const ae = aeMock();
  const res = await worker.fetch(req({ ip: '198.51.101.1' }), env({ FEEDBACK_AE: ae }));
  assert.equal(res.status, 200);
  assert.equal(ae.points.length, 1);
  assert.deepEqual(ae.points[0].blobs, ['unevie', 'ok']);
  assert.equal(ae.points[0].indexes[0], 'unevie');
});

test('AE: ошибочные исходы — origin и unknown_project (без раскрутки кардинальности)', async () => {
  const ae = aeMock();
  await worker.fetch(req({ ip: '198.51.101.2', origin: 'https://evil.example' }), env({ FEEDBACK_AE: ae }));
  await worker.fetch(req({ ip: '198.51.101.3', url: 'https://relay.example/v1/f/ghost' }), env({ FEEDBACK_AE: ae }));
  assert.deepEqual(ae.points.map((p) => p.blobs), [['unevie', 'origin'], ['unknown', 'unknown_project']]);
});

test('AE: сломанный writeDataPoint не роняет доставку', async () => {
  const ae = { writeDataPoint: () => { throw new Error('ae down'); } };
  const res = await worker.fetch(req({ ip: '198.51.101.4' }), env({ FEEDBACK_AE: ae }));
  assert.equal(res.status, 200);
});
