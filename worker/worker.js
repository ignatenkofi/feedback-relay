/* feedback-relay — multi-tenant Cloudflare Worker: приём фидбека со страниц проектов → Slack.
 *
 * POST /v1/f/{projectId}  { text, name?, context{}, sdk? }
 * Реестр проектов — projects.json (origin-политика, канал, лимиты — на проект).
 * Доставка — Slack chat.postMessage от бота (секрет SLACK_BOT_TOKEN) c message
 * metadata `feedback_v1` — машиночитаемый маркер для триаж-свипа (см. triage/ROUTINE.md).
 *
 * Свойства (см. DESIGN.md):
 *   • Stateless: воркер ничего не хранит, «инбокс» фидбека — Slack.
 *   • GitHub-кредов здесь нет: issues создаёт триаж-Routine, не relay.
 *   • Защита унаследована от unevie/feedback-worker и обобщена per-project:
 *     origin-allowlist (wildcard + 'null' для офлайн file://), санитизация от
 *     подделки Slack-разметки, жёсткие лимиты длины, rate limit в три слоя
 *     (CF ratelimit-binding по project:ip → per-project квота → in-isolate фолбэк).
 */
import PROJECTS from './projects.json' with { type: 'json' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* лимиты полезной нагрузки — дефолты, при необходимости сужаются per-project */
export const LIMITS = {
  MAX_BODY: 32 * 1024, // байт на всё тело
  MAX_TEXT: 4000,      // символов отзыва
  MAX_NAME: 80,        // имя
  MAX_CTX_KEYS: 20,    // ключей контекста
  MAX_CTX_KEY: 40,     // длина ключа
  MAX_CTX_VAL: 600,    // длина значения (длинные коды состояния — как фраза-сейв unevie)
  MAX_SDK: 40,         // строка версии SDK
  /* бюджет СОБРАННОГО сообщения: Slack режет text на ~40k, оставляем запас;
     текст отзыва после esc() ≤ ~20k, остаток бюджета получает контекст (#6) */
  MAX_MSG: 38000,
};

/* in-isolate фолбэк rate limit'а (пер-изолятный — только смягчение; основной
   лимит — кросс-изолятный binding FEEDBACK_RL, см. wrangler.toml) */
const RL_PER_MIN_DEFAULT = 5;
const RL_PER_HOUR = 30;
const rlLog = new Map(); // `${project}:${ip}` → [ts,…] за последний час

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* управляющие символы и переводы строк → пробел: Slack-разметку не подделать.
   Включая юникодные разделители U+2028/U+2029 и NEL U+0085 — часть клиентов
   Slack рендерит их как перевод строки (#5). */
export const flat = (s) =>
  String(s).replace(/[\u0000-\u001F\u007F\u0085\u2028\u2029]+/g, ' ').trim();

/* mrkdwn-спецсимволы — для полей, вставляемых внутрь чужой разметки *…*:
   имя (заголовок) и ключ контекста (`• *${k}:*`); `>` уже нейтрализует
   esc() (#5, #18) */
export const stripMrkdwn = (s) => String(s).replace(/[*_~`]/g, '');

const byteLen = (s) => new TextEncoder().encode(s).byteLength;

export function resolveProject(projectId, projects = PROJECTS) {
  if (!projectId || typeof projectId !== 'string') return null;
  const cfg = projects[projectId];
  if (!cfg || typeof cfg !== 'object' || projectId.startsWith('_')) return null;
  return cfg;
}

/* Origin-политика per-project.
 *  - точный host ('unevie.pages.dev') или wildcard ('*.unevie.pages.dev');
 *  - литерал 'null' — заголовок Origin: null (офлайн file:// — нужен unevie);
 *  - ОТСУТСТВИЕ Origin (curl и пр.) не блокируем: это защита от чужого
 *    фронтенда в браузере, а не от таргетированной атаки. */
export function originAllowed(origin, allowlist) {
  if (origin == null || origin === '') return true;
  if (origin === 'null') return allowlist.includes('null');
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return allowlist.some((a) => {
    if (a === 'null') return false;
    if (a.startsWith('*.')) return host === a.slice(2) || host.endsWith(a.slice(1));
    return host === a;
  });
}

export function rateLimitedFallback(key, now, perMin = RL_PER_MIN_DEFAULT, log = rlLog) {
  if (!key) return false;
  const hourAgo = now - 3600e3, minAgo = now - 60e3;
  let hits = (log.get(key) || []).filter((t) => t > hourAgo);
  const lastMin = hits.filter((t) => t > minAgo).length;
  if (lastMin >= perMin || hits.length >= RL_PER_HOUR) {
    log.set(key, hits);
    return true;
  }
  hits.push(now);
  log.set(key, hits);
  if (log.size > 10000) {
    for (const [k, v] of log) if (!v.length || v[v.length - 1] <= hourAgo) log.delete(k);
  }
  return false;
}

/* Валидация и нормализация тела запроса → {ok, error?, data?} (чистая функция). */
export function parsePayload(raw, limits = LIMITS) {
  /* MAX_BODY — байты, не code units: кириллица/эмодзи в UTF-8 до 4 байт на
     символ; проверка длины первой — дёшево отсекает и гигантский ASCII (#6) */
  if (raw.length > limits.MAX_BODY || byteLen(raw) > limits.MAX_BODY)
    return { ok: false, error: 'too_long', status: 413 };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'bad_json', status: 400 };
  }
  const text = String((body && body.text) || '').trim();
  if (!text) return { ok: false, error: 'empty', status: 400 };
  if (text.length > limits.MAX_TEXT) return { ok: false, error: 'too_long', status: 413 };
  const name = stripMrkdwn(flat((body && body.name) || '')).slice(0, limits.MAX_NAME).trim();
  const sdk = flat((body && body.sdk) || '').slice(0, limits.MAX_SDK);
  const rawCtx = body && body.context && typeof body.context === 'object' ? body.context : {};
  const context = {};
  for (const k of Object.keys(rawCtx)) {
    if (Object.keys(context).length >= limits.MAX_CTX_KEYS) break;
    /* stripMrkdwn как для name: ключ вставляется внутрь *…* в buildSlackMessage
       (`• *${k}:*`), иначе `*` в ключе закрывает bold досрочно (#18) */
    const key = stripMrkdwn(flat(k)).slice(0, limits.MAX_CTX_KEY);
    /* вырожденные (пустые после нормализации) и коллапсирующие ключи — пропуск,
       первый выигрывает: молчаливую перезапись значений не допускаем (#5) */
    if (!key || key in context) continue;
    context[key] = flat(rawCtx[k]).slice(0, limits.MAX_CTX_VAL);
  }
  return { ok: true, data: { text, name, sdk, context } };
}

/* Сообщение для chat.postMessage: текст + metadata-маркер для свипа.
 * Итоговый text укладывается в LIMITS.MAX_MSG: esc() раздувает худший случай
 * (`<` → `&lt;`) до ~4×, и текст+контекст по отдельным лимитам могут суммарно
 * превысить Slack-обрезку ~40k. Заголовок и текст отзыва влезают всегда
 * (≤ ~20.5k после esc); контекст добавляется построчно, пока есть бюджет (#6). */
export function buildSlackMessage(projectId, cfg, { text, name, sdk, context }, limits = LIMITS) {
  const head = `${cfg.emoji || '📝'} *${esc(cfg.title || projectId)} — отзыв*` +
    (name ? ` · от *${esc(name)}*` : '');
  const base = `${head}\n>>> ${esc(text)}`;

  const TRUNC = '_…контекст обрезан_';
  let ctxBlock = '';
  let used = base.length + 2; // разделитель '\n\n' перед контекстом
  for (const [k, v] of Object.entries(context)) {
    const line = `• *${esc(k)}:* ${esc(v)}`;
    if (used + line.length + 1 > limits.MAX_MSG - TRUNC.length - 1) {
      ctxBlock += (ctxBlock ? '\n' : '') + TRUNC;
      break;
    }
    ctxBlock += (ctxBlock ? '\n' : '') + line;
    used += line.length + 1;
  }

  return {
    channel: cfg.channel,
    text: base + (ctxBlock ? `\n\n${ctxBlock}` : ''),
    unfurl_links: false,
    unfurl_media: false,
    metadata: {
      event_type: 'feedback_v1',
      event_payload: { project: projectId, sdk: sdk || '' },
    },
  };
}

/* Доставка с одним ретраем (#7): транзиентные 429 (уважая Retry-After, cap 2 c)
 * и 5xx/сетевые — повторяем ровно один раз; логические ошибки Slack
 * (200 + ok:false: invalid_auth, channel_not_found…) не ретраим.
 * fetchFn/sleepFn инжектируются в тестах. */
export async function postToSlack(payload, token, { fetchFn, sleepFn } = {}) {
  const doFetch = fetchFn || fetch;
  const sleep = sleepFn || ((ms) => new Promise((res) => setTimeout(res, ms)));
  const attempt = async () => {
    const r = await doFetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    let out = null;
    try { out = await r.json(); } catch { /* не-JSON от Slack — считаем ошибкой уровня HTTP */ }
    return { r, out };
  };

  let res = null;
  try { res = await attempt(); } catch { /* сетевая ошибка — ретраибельна */ }
  if (res && res.r.ok && res.out && res.out.ok === true) return { ok: true };

  const retriable = !res || res.r.status === 429 || res.r.status >= 500;
  if (retriable) {
    const retryAfterSec = res && Number(res.r.headers && res.r.headers.get('Retry-After'));
    const delay = res && res.r.status === 429
      ? Math.min((retryAfterSec > 0 ? retryAfterSec : 1) * 1000, 2000)
      : 500;
    await sleep(delay);
    try { res = await attempt(); } catch { res = null; }
    if (res && res.r.ok && res.out && res.out.ok === true) return { ok: true };
  }

  if (!res) return { ok: false, error: 'relay_failed' };
  return { ok: false, error: 'slack_' + ((res.out && res.out.error) || res.r.status) };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/* /v1/f/{projectId} → projectId | null */
export function routeProjectId(pathname) {
  const m = /^\/v1\/f\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (!env.SLACK_BOT_TOKEN) return json({ ok: false, error: 'not_configured' }, 500);

    const projectId = routeProjectId(new URL(request.url).pathname);
    const cfg = resolveProject(projectId);
    /* 404 и на кривой путь, и на неизвестный проект — реестр не раскрываем */
    if (!cfg) return json({ ok: false, error: 'unknown_project' }, 404);

    if (!originAllowed(request.headers.get('Origin'), cfg.origins || []))
      return json({ ok: false, error: 'origin' }, 403);

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const rlKey = `${projectId}:${ip}`;
    if (env.FEEDBACK_RL && ip) {
      try {
        const { success } = await env.FEEDBACK_RL.limit({ key: rlKey });
        if (!success) return json({ ok: false, error: 'rate' }, 429);
      } catch { /* биндинг недоступен (локальный dev) — работает фолбэк ниже */ }
    }
    const perMin = (cfg.rate && cfg.rate.perMin) || undefined;
    if (ip && rateLimitedFallback(rlKey, Date.now(), perMin))
      return json({ ok: false, error: 'rate' }, 429);

    /* дешёвый отсев до чтения тела; истина в байтах — внутри parsePayload (#6) */
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LIMITS.MAX_BODY) return json({ ok: false, error: 'too_long' }, 413);

    const parsed = parsePayload(await request.text());
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);

    const sent = await postToSlack(
      buildSlackMessage(projectId, cfg, parsed.data), env.SLACK_BOT_TOKEN);
    if (!sent.ok) return json({ ok: false, error: sent.error }, 502);
    return json({ ok: true });
  },
};
