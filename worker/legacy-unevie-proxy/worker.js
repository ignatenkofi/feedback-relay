/* legacy-unevie-proxy — тонкий прокси старого эндпоинта unevie-feedback на relay.
 *
 * Старый URL `unevie-feedback.<acc>.workers.dev` вшит в уже розданные офлайн-файлы
 * книги «ЖИЗНЬ» — ломать нельзя (DESIGN.md §8 «Совместимость», worker/README.md
 * «Миграция unevie», issue #8). Деплоится ПОВЕРХ старого воркера (то же имя
 * `unevie-feedback`, wrangler.toml), превращая его в прокси на
 * `…/v1/f/unevie` вместо расходящейся копии кода доставки.
 *
 * Транспорт — service binding, НЕ публичный fetch. Обычный `fetch` на
 * `feedback-relay.<acc>.workers.dev` отдаёт Cloudflare Error 1042 («worker tried
 * to fetch from another worker on the same account»): межворкерные запросы по
 * `*.workers.dev` запрещены по умолчанию. Поймано живым деплоем 2026-07-25 —
 * оффлайн-тесты это увидеть не могли, потому что fetch в них инжектируется.
 * Альтернатива (кастомный домен + флаг `global_fetch_strictly_public`) отклонена:
 * биндинг не требует ни DNS, ни выхода запроса в интернет.
 *
 * Поведение:
 *   • POST (любой путь) → форвард тела в relay через биндинг `RELAY`; путь берётся
 *     из RELAY_ENDPOINT (хост в нём инертен — запрос не идёт по публичной сети),
 *     ответ relay проксируется как есть (status + `{ok:…}`-тело) — контракт для
 *     старых клиентов сохранён;
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

/* Ядро прокси. doFetch инжектится в смоук-тесте; в проде его нет и запрос идёт
   через service binding env.RELAY (глобальный fetch тут непригоден — Error 1042). */
export async function handleRequest(request, env, doFetch) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const endpoint = env && env.RELAY_ENDPOINT;
  const binding = env && env.RELAY;
  const send = doFetch || (binding && ((url, init) => binding.fetch(url, init)));
  /* без пути или без биндинга проксировать некуда — тот же код, что и раньше при
     незаданном RELAY_ENDPOINT: отсутствие [[services]] в wrangler.toml обязано
     быть громким, а не превращаться в 1042 на живом трафике */
  if (!endpoint || !send) return json({ ok: false, error: 'not_configured' }, 500);

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
    relayResp = await send(endpoint, { method: 'POST', headers, body });
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
