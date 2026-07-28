/* feedback-relay — multi-tenant Cloudflare Worker: приём фидбека со страниц проектов → Slack.
 *
 * POST /v1/f/{projectId}       { text, name?, context{}, sdk? }
 * GET  /v1/health/{projectId}  → { ok } — проба деливери-пути (#12): auth.test +
 *                              conversations.info; наружу только ok/fail, детали в лог
 * Реестр проектов — projects.json (origin-политика, канал, лимиты — на проект).
 * Доставка — Slack chat.postMessage от бота (секрет SLACK_BOT_TOKEN) c message
 * metadata `feedback_v1` — машиночитаемый маркер для триаж-свипа (см. triage/ROUTINE.md).
 *
 * Свойства (см. DESIGN.md):
 *   • Stateless: воркер ничего не хранит, «инбокс» фидбека — Slack.
 *   • GitHub-кредов здесь нет: issues создаёт триаж-Routine, не relay.
 *   • Защита унаследована от unevie/feedback-worker и обобщена per-project:
 *     origin-allowlist (wildcard + 'null' для офлайн file://), санитизация от
 *     подделки Slack-разметки, жёсткие лимиты длины, rate limit: кросс-изолятный
 *     CF ratelimit-binding по project:ip — фиксированный потолок (wrangler.toml) +
 *     best-effort in-isolate ужатие по cfg.rate.perMin (ниже потолка, не выше; #22).
 */
import PROJECTS from './projects.json' with { type: 'json' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* лимиты полезной нагрузки — дефолты, при необходимости сужаются per-project */
export const LIMITS = {
  /* байт на ВСЁ тело (UTF-8) — DoS-guard, не пофилдовой лимит. Порог с запасом
     покрывает сумму документированных пофилдовых максимумов даже в кириллице/
     эмодзи (2–4 байта/символ ≈ 34–68 КБ), иначе формально валидный payload ловил
     бы 413 из-за алфавита (#21). Бюджет собранного сообщения держит MAX_MSG. */
  MAX_BODY: 96 * 1024,
  MAX_TEXT: 4000,      // символов отзыва
  MAX_NAME: 80,        // имя
  MAX_CTX_KEYS: 20,    // ключей контекста
  MAX_CTX_KEY: 40,     // длина ключа
  MAX_CTX_VAL: 600,    // длина значения (длинные коды состояния — как фраза-сейв unevie)
  MAX_SDK: 40,         // строка версии SDK
  /* бюджет notification-fallback (top-level text): с переходом на Block Kit (#10)
     text больше не несёт контекст — только заголовок-сигнатура + превью отзыва,
     поэтому влезает с гигантским запасом; порог оставлен как sanity-ceiling */
  MAX_MSG: 38000,
};

/* Лимиты Slack Block Kit (#10) — по объектам, а не на всё сообщение:
 *  • section.text ≤ 3000 символов, section.fields[*].text ≤ 2000, ≤ 10 fields/section;
 *  • контекст бьётся на группы по FIELDS_PER_SECTION (несколько section-блоков);
 *  • TEXT_FALLBACK — сколько символов отзыва кладём в notification-превью. */
export const BLOCK_LIMITS = {
  SECTION_TEXT: 3000,
  FIELD_TEXT: 2000,
  FIELDS_PER_SECTION: 10,
  TEXT_FALLBACK: 200,
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
  /* черновик реестра (#13): запись есть, но канал ещё плейсхолдер — воркер обязан
     отвечать 404, а не слать в несуществующий канал (иначе Slack вернёт 502). */
  if (cfg._draft) return null;
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

/* Обрезка уже-экранированной строки под лимит Block Kit без порчи суррогатных
 * пар (эмодзи) и висячих HTML-сущностей (`&lt;` не режем посередине — иначе в
 * канал утечёт `&l`). Возвращает строку длиной ≤ max. */
export function clipEscaped(s, max, marker = '…') {
  if (s.length <= max) return s;
  let out = s.slice(0, Math.max(0, max - marker.length));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // не рвём суррогатную пару
  const amp = out.lastIndexOf('&');
  if (amp !== -1 && !out.slice(amp).includes(';')) out = out.slice(0, amp); // висячая сущность
  return out + marker;
}

/* Сообщение для chat.postMessage: Block Kit `blocks` + notification-fallback `text`
 * + metadata-маркер для свипа. Структура блоков (#10):
 *   1) section — заголовок (эмодзи + *title — отзыв* [· от *name*]);
 *   2) section — цитата отзыва (`>>> …`): в Block Kit `>>>` ограничен своим
 *      блоком и больше НЕ «съедает» контекст — в этом суть #10;
 *   3) section.fields — контекст парами, группами по BLOCK_LIMITS.FIELDS_PER_SECTION;
 *   4) context — подвал (проект + версия SDK).
 * Каждый text-объект обрезается под свой лимит Block Kit (section ≤ 3000, field
 * ≤ 2000). `text` несёт заголовок-сигнатуру первой строкой (фолбэк-детект свипа
 * из #9: `^. \*.+ — отзыв\*`) + ~200 символов отзыва для push-нотификации. */
export function buildSlackMessage(projectId, cfg, { text, name, sdk, context }, limits = BLOCK_LIMITS) {
  const head = `${cfg.emoji || '📝'} *${esc(cfg.title || projectId)} — отзыв*` +
    (name ? ` · от *${esc(name)}*` : '');

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: head } },
    { type: 'section', text: { type: 'mrkdwn', text: clipEscaped(`>>> ${esc(text)}`, limits.SECTION_TEXT) } },
  ];

  /* контекст → section.fields по 10 штук (лимит Block Kit); каждое поле
     `*ключ:*\nзначение` обрезается под лимит поля. */
  const entries = Object.entries(context);
  for (let i = 0; i < entries.length; i += limits.FIELDS_PER_SECTION) {
    const fields = entries.slice(i, i + limits.FIELDS_PER_SECTION).map(([k, v]) => ({
      type: 'mrkdwn',
      text: clipEscaped(`*${esc(k)}:*\n${esc(v)}`, limits.FIELD_TEXT),
    }));
    blocks.push({ type: 'section', fields });
  }

  /* подвал — context-блок (мелкий шрифт): проект + версия SDK */
  const foot = `проект: \`${esc(projectId)}\`` + (sdk ? ` · SDK ${esc(sdk)}` : '');
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clipEscaped(foot, limits.SECTION_TEXT) }] });

  /* text — notification-fallback. Первая строка = заголовок-сигнатура (#9 не
     ломаем, если metadata не видна MCP), затем превью отзыва. */
  const fallback = `${head}\n${clipEscaped(esc(text), limits.TEXT_FALLBACK)}`;

  return {
    channel: cfg.channel,
    text: fallback,
    blocks,
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

/* Health-проба деливери-пути (#12): auth.test (токен жив) + conversations.info
 * (канал существует и виден боту — ловит протухший токен, кик из канала,
 * channel_not_found ДО того, как их увидит пользователь с 502). Наружу — только
 * ok/fail: публичный эндпоинт не должен работать оракулом конфигурации; коды
 * ошибок Slack — в лог (wrangler tail / dashboard). fetchFn — шов для тестов. */
export async function checkHealth(cfg, token, { fetchFn } = {}) {
  const doFetch = fetchFn || fetch;
  const call = async (method, params) => {
    try {
      const r = await doFetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: new URLSearchParams(params).toString(),
      });
      let out = null;
      try { out = await r.json(); } catch { /* не-JSON — ошибка уровня HTTP */ }
      if (r.ok && out && out.ok === true) return null;
      return (out && out.error) || `http_${r.status}`;
    } catch {
      return 'network';
    }
  };
  const authErr = await call('auth.test', {});
  const chanErr = authErr ? 'skipped' : await call('conversations.info', { channel: cfg.channel });
  return { ok: !authErr && !chanErr, detail: { auth: authErr || 'ok', channel: chanErr || 'ok' } };
}

/* Кэш здоровья в изоляте: публичный GET не должен умножать вызовы Slack API.
 * Экспортирован только как шов для тестов (сброс между кейсами). */
export const HEALTH_CACHE = new Map(); // projectId → { ts, ok }
const HEALTH_TTL_MS = 60e3;
const HEALTH_RL_PER_MIN = 3; // жёстче POST-фолбэка: проба дороже (2 вызова Slack)

/* Analytics Engine (#12, opt-in): счётчик исходов доставки — только project +
 * outcome, БЕЗ текста отзывов (stateless для контента сохраняется). Биндинг не
 * задан — no-op; конфиг в wrangler.toml закомментирован до решения владельца. */
function recordOutcome(env, projectId, outcome) {
  try {
    if (env.FEEDBACK_AE) env.FEEDBACK_AE.writeDataPoint({
      blobs: [projectId || 'unknown', outcome],
      doubles: [1],
      indexes: [projectId || 'unknown'],
    });
  } catch { /* наблюдаемость не должна ронять доставку */ }
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

/* /v1/health/{projectId} → projectId | null */
export function routeHealthId(pathname) {
  const m = /^\/v1\/health\/([A-Za-z0-9_-]{1,40})$/.exec(pathname);
  return m ? m[1] : null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    /* GET — только health-проба (#12); остальные GET-пути ведут себя как раньше (405) */
    if (request.method === 'GET') {
      const healthId = routeHealthId(new URL(request.url).pathname);
      if (!healthId) return json({ ok: false, error: 'method' }, 405);
      if (!env.SLACK_BOT_TOKEN) return json({ ok: false, error: 'not_configured' }, 500);
      const cfg = resolveProject(healthId);
      /* 404 на неизвестный проект — реестр не раскрываем, как в POST-пути */
      if (!cfg) return json({ ok: false, error: 'unknown_project' }, 404);

      /* та же двухслойная защита, что у POST, но жёстче: проба = 2 вызова Slack */
      const hip = request.headers.get('CF-Connecting-IP') || '';
      const hKey = `health:${healthId}:${hip}`;
      if (env.FEEDBACK_RL && hip) {
        try {
          const { success } = await env.FEEDBACK_RL.limit({ key: hKey });
          if (!success) return json({ ok: false, error: 'rate' }, 429);
        } catch { /* биндинг недоступен (локальный dev) — работает фолбэк ниже */ }
      }
      if (hip && rateLimitedFallback(hKey, Date.now(), HEALTH_RL_PER_MIN))
        return json({ ok: false, error: 'rate' }, 429);

      const hit = HEALTH_CACHE.get(healthId);
      if (hit && Date.now() - hit.ts < HEALTH_TTL_MS)
        return json({ ok: hit.ok }, hit.ok ? 200 : 503);

      const health = await checkHealth(cfg, env.SLACK_BOT_TOKEN);
      HEALTH_CACHE.set(healthId, { ts: Date.now(), ok: health.ok });
      if (!health.ok)
        console.log(`health ${healthId}: auth=${health.detail.auth} channel=${health.detail.channel}`);
      return json({ ok: health.ok }, health.ok ? 200 : 503);
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (!env.SLACK_BOT_TOKEN) return json({ ok: false, error: 'not_configured' }, 500);

    const projectId = routeProjectId(new URL(request.url).pathname);
    const cfg = resolveProject(projectId);
    /* reply = json + AE-точка исхода (#12): outcome = 'ok' | код ошибки */
    const reply = (obj, status) => {
      recordOutcome(env, cfg ? projectId : null, obj.ok ? 'ok' : obj.error);
      return json(obj, status);
    };
    /* 404 и на кривой путь, и на неизвестный проект — реестр не раскрываем */
    if (!cfg) return reply({ ok: false, error: 'unknown_project' }, 404);

    if (!originAllowed(request.headers.get('Origin'), cfg.origins || []))
      return reply({ ok: false, error: 'origin' }, 403);

    const ip = request.headers.get('CF-Connecting-IP') || '';
    const rlKey = `${projectId}:${ip}`;
    if (env.FEEDBACK_RL && ip) {
      try {
        const { success } = await env.FEEDBACK_RL.limit({ key: rlKey });
        if (!success) return reply({ ok: false, error: 'rate' }, 429);
      } catch { /* биндинг недоступен (локальный dev) — работает фолбэк ниже */ }
    }
    /* cfg.rate.perMin — best-effort ужатие ВНУТРИ изолята: опускает эффективный
       лимит ниже кросс-изолятного binding-потолка (wrangler.toml, сейчас 6/мин),
       но поднять выше него не может. CI (#22) отклоняет perMin больше потолка. */
    const perMin = (cfg.rate && cfg.rate.perMin) || undefined;
    if (ip && rateLimitedFallback(rlKey, Date.now(), perMin))
      return reply({ ok: false, error: 'rate' }, 429);

    /* дешёвый отсев до чтения тела; истина в байтах — внутри parsePayload (#6) */
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > LIMITS.MAX_BODY) return reply({ ok: false, error: 'too_long' }, 413);

    const parsed = parsePayload(await request.text());
    if (!parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);

    const sent = await postToSlack(
      buildSlackMessage(projectId, cfg, parsed.data), env.SLACK_BOT_TOKEN);
    if (!sent.ok) return reply({ ok: false, error: sent.error }, 502);
    return reply({ ok: true });
  },
};
