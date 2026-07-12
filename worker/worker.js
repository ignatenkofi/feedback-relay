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
};

/* in-isolate фолбэк rate limit'а (пер-изолятный — только смягчение; основной
   лимит — кросс-изолятный binding FEEDBACK_RL, см. wrangler.toml) */
const RL_PER_MIN_DEFAULT = 5;
const RL_PER_HOUR = 30;
const rlLog = new Map(); // `${project}:${ip}` → [ts,…] за последний час

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* управляющие символы и переводы строк → пробел: Slack-разметку не подделать */
export const flat = (s) => String(s).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();

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
  if (raw.length > limits.MAX_BODY) return { ok: false, error: 'too_long', status: 413 };
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'bad_json', status: 400 };
  }
  const text = String((body && body.text) || '').trim();
  if (!text) return { ok: false, error: 'empty', status: 400 };
  if (text.length > limits.MAX_TEXT) return { ok: false, error: 'too_long', status: 413 };
  const name = flat((body && body.name) || '').slice(0, limits.MAX_NAME);
  const sdk = flat((body && body.sdk) || '').slice(0, limits.MAX_SDK);
  const rawCtx = body && body.context && typeof body.context === 'object' ? body.context : {};
  const context = {};
  for (const k of Object.keys(rawCtx).slice(0, limits.MAX_CTX_KEYS)) {
    context[flat(k).slice(0, limits.MAX_CTX_KEY)] = flat(rawCtx[k]).slice(0, limits.MAX_CTX_VAL);
  }
  return { ok: true, data: { text, name, sdk, context } };
}

/* Сообщение для chat.postMessage: текст + metadata-маркер для свипа. */
export function buildSlackMessage(projectId, cfg, { text, name, sdk, context }) {
  const head = `${cfg.emoji || '📝'} *${esc(cfg.title || projectId)} — отзыв*` +
    (name ? ` · от *${esc(name)}*` : '');
  const ctxLines = Object.entries(context)
    .map(([k, v]) => `• *${esc(k)}:* ${esc(v)}`)
    .join('\n');
  return {
    channel: cfg.channel,
    text: `${head}\n>>> ${esc(text)}` + (ctxLines ? `\n\n${ctxLines}` : ''),
    unfurl_links: false,
    unfurl_media: false,
    metadata: {
      event_type: 'feedback_v1',
      event_payload: { project: projectId, sdk: sdk || '' },
    },
  };
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

    const parsed = parsePayload(await request.text());
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);

    let r, out;
    try {
      r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify(buildSlackMessage(projectId, cfg, parsed.data)),
      });
      out = await r.json();
    } catch {
      return json({ ok: false, error: 'relay_failed' }, 502);
    }
    /* chat.postMessage отвечает 200 и ok:false при ошибке — проверяем оба слоя */
    if (!r.ok || !out || out.ok !== true)
      return json({ ok: false, error: 'slack_' + ((out && out.error) || r.status) }, 502);
    return json({ ok: true });
  },
};
