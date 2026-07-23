/* legacy-unevie-proxy — тонкий прокси старого эндпоинта unevie-feedback на relay.
 *
 * Старый URL `unevie-feedback.<acc>.workers.dev` вшит в уже розданные офлайн-файлы
 * книги «ЖИЗНЬ» — ломать нельзя (DESIGN.md §8 «Совместимость», worker/README.md
 * «Миграция unevie», issue #8). Деплоится ПОВЕРХ старого воркера (то же имя
 * `unevie-feedback`, wrangler.toml), превращая его в прокси на
 * `…/v1/f/unevie` вместо расходящейся копии кода доставки.
 *
 * Поведение:
 *   • POST (любой путь) → форвард тела на RELAY_ENDPOINT, ответ relay проксируется
 *     как есть (status + `{ok:…}`-тело) — контракт для старых клиентов сохранён;
 *   • Origin и CF-Connecting-IP пробрасываются: relay проверяет origin-allowlist
 *     ('null' для офлайн file://) и считает rate limit по РЕАЛЬНОМУ IP клиента,
 *     а не по IP прокси;
 *   • OPTIONS → прежний CORS-preflight;
 *   • прочие методы → 405, как у relay.
 *
 * Stateless, без секретов. Свой rate limit НЕ держит: лимитирует relay
 * (по проброшенному project:ip). RELAY_ENDPOINT — обычная var (не секрет),
 * реальный сабдомен проставляет владелец при деплое (wrangler.toml).
 */

/* тот же CORS, что отдавал старый воркер и отдаёт relay */
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

/* Ядро прокси. doFetch инжектится в смоук-тесте (по умолчанию — глобальный fetch). */
export async function handleRequest(request, env, doFetch = fetch) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const endpoint = env && env.RELAY_ENDPOINT;
  if (!endpoint) return json({ ok: false, error: 'not_configured' }, 500);

  /* только нужные заголовки; тело — как текст (payload'ы крошечные, поток не нужен) */
  const headers = {
    'Content-Type': request.headers.get('Content-Type') || 'application/json',
  };
  /* Origin пробрасываем как есть, включая литерал 'null' (офлайн file://): relay
     сверяет его с origins проекта. Отсутствие Origin (curl) не подделываем —
     relay не блокирует запрос без Origin. */
  const origin = request.headers.get('Origin');
  if (origin != null) headers['Origin'] = origin;
  /* реальный IP клиента → relay считает лимит по нему, а не по IP прокси.
     ВНИМАНИЕ (owner): при вызове воркер→воркер Cloudflare может переустановить
     CF-Connecting-IP на egress-IP прокси — проверить `wrangler tail` после
     деплоя; если лимит поедет по IP прокси, вынести решение (relay читает
     X-Forwarded-For от доверенного прокси) отдельным шагом. */
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers['CF-Connecting-IP'] = ip;

  const body = await request.text();

  let relayResp;
  try {
    relayResp = await doFetch(endpoint, { method: 'POST', headers, body });
  } catch {
    /* relay недоступен — тот же код, что отдал бы relay при сетевом сбое доставки */
    return json({ ok: false, error: 'relay_failed' }, 502);
  }

  /* ответ relay проксируется как есть: статус + JSON-тело (`{ok:…}`), плюс CORS.
     Так старые клиенты получают прежний контракт и коды (200/400/403/404/413/429/…). */
  const text = await relayResp.text();
  return new Response(text, {
    status: relayResp.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
