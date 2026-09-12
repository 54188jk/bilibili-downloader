/**
 * 本地影视 API 服务
 * - 应用启动时自动启动（端口 3928，仅绑定本机，占用时自动向上重试）
 * - 多源聚合搜索：并发并发请求所有配置的苹果CMS 源，去重 + 按速度排序
 * - 提供：搜索 / 详情 / 数据源列表 / 状态 / 健康指标
 * - 磁盘缓存：搜索结果与详情持久化到 userData，跨会话秒回
 * - CORS 全开，方便脚本 / 浏览器 / 局域网内其它工具复用
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3928;
const MAX_PORT_RETRY = 20;
const CONCURRENCY = 16;         // 聚合搜索并发数（≥源数量，一次波次内全部发起）
const SRC_TIMEOUT = 1500;       // 单源超时 1.5s（CMS 源要么快要么挂，2.5s 浪费在慢源上）
const EARLY_EXIT_HITS = 5;      // 收到 5 个源结果后不再等待剩余慢源
const SERVER_TIMEOUT = 120000;  // 服务端请求超时

// 与 renderer 的 MOVIE_BASE_PRESETS 保持一致（一线稳定源优先）
const DEFAULT_SOURCES = [
  'https://bfzyapi.com/api.php/provide/vod',              // 暴风资源（~2.6s，量大）
  'https://api.guangsuapi.com/api.php/provide/vod',       // 光速资源（~2.0s）
  'https://jszyapi.com/api.php/provide/vod',              // 极速资源（~2.2s）
  'https://jyzyapi.com/provide/vod/',                     // 金鹰资源（特例路径，~1s）
  'https://cj.ffzyapi.com/api.php/provide/vod',           // 非凡资源（~1.9s）
  'https://api.apibdzy.com/api.php/provide/vod',          // 百度资源（~3.3s）
  'https://vip.mtime.cn/api.php/provide/vod',             // MTime 资源（~0.2s，最快）
  'https://www.iqiyizy.com/api.php/provide/vod/',         // 爱奇艺资源（~2.2s）
  'https://cj.lziapi.com/api.php/provide/vod',            // 量子资源（~2.2s）
];

// 直链播放器页面（CMS 源直出的 m3u8/mp4 直接在此播放，绕过解析器）
// 支持原生 HLS + hls.js 兜底（解决多级 m3u8 / 跨域 / Chromium 原生支持差的问题）
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>影视播放器</title>
<style>
  html, body { margin:0; height:100%; background:#000; overflow:hidden; }
  #player { width:100%; height:100%; display:block; background:#000; }
  #err { display:none; position:absolute; inset:0; color:#f66; font-family:sans-serif;
         align-items:center; justify-content:center; text-align:center; font-size:14px;
         line-height:1.8; padding:20px; box-sizing:border-box; }
</style>
</head>
<body>
<video id="player" controls autoplay playsinline></video>
<div id="err"></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
  const q = new URLSearchParams(location.search);
  let src = q.get('url') || '';
  const v = document.getElementById('player');
  const errEl = document.getElementById('err');
  function fail(m){ errEl.style.display='flex'; errEl.textContent=m; v.style.display='none'; }
  if (!src) { fail('未提供播放地址'); }
  else if (Hls && Hls.isSupported() && /\\.m3u8(\\?|$)/i.test(src)) {
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(src);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(_=>{}));
    hls.on(Hls.Events.ERROR, (e, d) => {
      if (d.fatal) { fail('HLS 致命错误：' + d.type + ' ' + d.details); }
    });
  } else {
    v.src = src;
    v.onerror = () => fail('播放出错：' + (v.error ? (v.error.message||v.error.code) : '未知') + '<br>源：' + src.slice(0,120));
  }
</script>
</body>
</html>`;

// ── 磁盘缓存（userData/movie-api-cache.json） ──
const CACHE_FILE = 'movie-api-cache.json';
const CACHE_MAX = 600;          // 最多保留条目
const CACHE_SEARCH_TTL = 30 * 60 * 1000;   // 搜索 30 分钟
const CACHE_DETAIL_TTL = 6 * 60 * 60 * 1000; // 详情 6 小时
let cacheDir = null;
let cache = null;               // { key: { ts, data } }
let cacheDirty = false;

function initCache(dir) {
  if (cache) return;
  cacheDir = dir;
  cache = {};
  try {
    const raw = fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') cache = parsed;
  } catch (_) {}
  // 启动即清理过期条目
  pruneCache(Date.now());
}

function pruneCache(now) {
  if (!cache) return;
  for (const k of Object.keys(cache)) {
    const ttl = k.startsWith('d:') ? CACHE_DETAIL_TTL : CACHE_SEARCH_TTL;
    if (now - (cache[k].ts || 0) > ttl) delete cache[k];
  }
  if (Object.keys(cache).length > CACHE_MAX) {
    const keys = Object.keys(cache).sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
    const drop = keys.length - CACHE_MAX;
    keys.slice(0, drop).forEach(k => delete cache[k]);
  }
}

function cacheGet(key, now) {
  if (!cache) return null;
  const it = cache[key];
  if (!it) return null;
  const ttl = key.startsWith('d:') ? CACHE_DETAIL_TTL : CACHE_SEARCH_TTL;
  if (now - (it.ts || 0) > ttl) {
    delete cache[key];
    cacheDirty = true;
    return null;
  }
  return it.data;
}

function cacheSet(key, data) {
  if (!cache) return;
  cache[key] = { ts: Date.now(), data };
  cacheDirty = true;
  scheduleSave();
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer || !cacheDir) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!cacheDirty || !cache || !cacheDir) return;
    try {
      pruneCache(Date.now());
      fs.writeFileSync(path.join(cacheDir, CACHE_FILE), JSON.stringify(cache));
      cacheDirty = false;
    } catch (_) {}
  }, 1500);
}

// ── HTTP 请求辅助（跟随重定向 / UA / Referer / 超时） ──
function httpGet(url, headers = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const agentOpts = { keepAlive: true, maxSockets: 6, timeout: timeoutMs || 5000 };
    const agent = parsed.protocol === 'https:'
      ? new https.Agent(agentOpts)
      : new http.Agent(agentOpts);
    const req = lib.get(url, { headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, headers), agent }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        return httpGet(next, headers, timeoutMs).then(resolve, reject);
      }
      let d = '';
      res.on('data', c => { d += c; if (d.length > 6 * 1024 * 1024) res.destroy(); });
      res.on('end', () => {
        agent.destroy();
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(d);
      });
    });
    req.on('error', (e) => { agent.destroy(); reject(e); });
    req.setTimeout(timeoutMs || 5000, () => { agent.destroy(); req.destroy(new Error('请求超时')); });
  });
}

function normalizeBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

// 构造 CMS 搜索/详情请求 URL：src 可能是纯域名、含 /provide/vod 的接口路径，需智能判断避免重复拼接
function cmsApiUrl(base, path) {
  let b = normalizeBase(base);
  // 已经是 CMS 接口路径（/api.php/provide/vod 或 /provide/vod 等）：直接在尾部追加参数
  if (/\/provide\/vod\/?$/i.test(b) || /\/api\.php\/provide\/vod\/?$/i.test(b)) {
    return b + path;
  }
  return b + '/api.php/provide/vod' + path;
}

async function fetchSourceSearch(src, wd, pg) {
  const url = cmsApiUrl(src, `/?ac=detail&wd=${encodeURIComponent(wd)}&pg=${pg || 1}`);
  const body = await httpGet(url, { 'Referer': src }, SRC_TIMEOUT);
  const data = JSON.parse(body);
  if (!data || !Array.isArray(data.list)) return { list: [], ok: false };
  return { list: data.list, ok: true };
}

async function fetchSourceDetail(src, ids) {
  const url = cmsApiUrl(src, `/?ac=detail&ids=${encodeURIComponent(ids)}`);
  const body = await httpGet(url, { 'Referer': src }, SRC_TIMEOUT);
  const data = JSON.parse(body);
  if (!data || !Array.isArray(data.list) || !data.list.length) return null;
  return Object.assign({}, data.list[0], { _src: src });
}

function normMovieName(name) {
  return String(name || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}

// 解析植入视频直链的分享/短链页面：抓 HTML，正则提取真实 m3u8/mp4 地址并拼接绝对 URL
async function resolveShareLink(url) {
  const body = await httpGet(url, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': url,
  }, 15000);
  const origin = new URL(url).origin;
  const rel = (u) => u.startsWith('http') ? u : new URL(u, origin + '/').toString();

  const patterns = [
    /var\s+main\s*=\s*["']([^"']+\.m3u8[^"']*)["']/,
    /var\s+(?:url|m3u8|video_url|playurl|videoUrl)\s*=\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /["'](?:url|src|m3u8|playurl)["']\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    /var\s+main\s*=\s*["']([^"']+\.mp4[^"']*)["']/,
    /["']([^"']+\.(?:m3u8|mp4)(?:\?[^"']*)?)["']/,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m && m[1]) {
      const candidate = rel(m[1]);
      if (/\.(m3u8|mp4)(\?|$)/i.test(candidate)) return candidate;
    }
  }
  return null;
}

// ── 多源聚合搜索 ──
async function aggregateSearch(wd, pg, srcList) {
  const sources = (srcList && srcList.length ? srcList : DEFAULT_SOURCES)
    .filter(s => /^https?:\/\//i.test(s));
  const now = Date.now();
  const speed = new Map();   // src -> 响应耗时（快者优先）

  // 并发池抓取 + 提前终止：收到足够结果后不再等慢源
  const list = [];
  const seenExact = new Set();
  const seenNorm = new Set();
  let cursor = 0;
  let hitCount = 0;           // 已有多少源返回了结果
  let earlyExit = false;      // 提前退出标记
  async function worker() {
    while (cursor < sources.length && !earlyExit) {
      const src = sources[cursor++];
      const t0 = Date.now();
      try {
        const r = await fetchSourceSearch(src, wd, pg);
        const elapsed = Date.now() - t0;
        if (r.ok && r.list.length) {
          speed.set(src, elapsed);
          hitCount++;
          const srcHost = src.replace(/^https?:\/\//, '').split('/')[0];
          for (const it of r.list) {
            const exactKey = ((it.vod_name || '') + '|' + (it.vod_year || '')).trim();
            const normKey = normMovieName(it.vod_name) + '|' + srcHost;
            if (seenExact.has(exactKey) || seenNorm.has(normKey)) continue;
            seenExact.add(exactKey);
            seenNorm.add(normKey);
            list.push(Object.assign({}, it, { _src: src }));
          }
          // 收到足够源结果后提前退出（慢源不再等待）
          if (hitCount >= EARLY_EXIT_HITS) earlyExit = true;
        }
      } catch (_) {
        speed.set(src, SRC_TIMEOUT + 1000);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, worker));

  const order = sources.slice().sort((a, b) => (speed.get(a) || 5000) - (speed.get(b) || 5000));
  list.sort((x, y) => order.indexOf(x._src) - order.indexOf(y._src));
  return { list, order, elapsed: Date.now() - now };
}

// ── 服务状态 ──
let startedAt = 0;
function status() {
  return {
    app: 'movie-api',
    port: currentPort,
    startedAt,
    uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    sources: DEFAULT_SOURCES.length,
    cacheEntries: cache ? Object.keys(cache).length : 0,
  };
}

// ── HTTP 服务器 ──
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body) }, corsHeaders()));
  res.end(body);
}

function parseQ(url) {
  const u = new URL(url, 'http://127.0.0.1');
  const q = {};
  u.searchParams.forEach((v, k) => { q[k] = v; });
  return { path: u.pathname, q };
}

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  const { path: p, q } = parseQ(req.url || '/');
  const now = Date.now();

  try {
    if (p === '/api/search') {
      const wd = (q.wd || q.keyword || '').trim();
      if (!wd) return send(res, 400, { code: 400, error: '缺少关键词 wd' });
      const pg = parseInt(q.pg || '1', 10) || 1;
      const cacheKey = `s:${wd}:${pg}`;
      const hit = cacheGet(cacheKey, now);
      if (hit) return send(res, 200, Object.assign({ code: 0, cached: true }, hit));
      aggregateSearch(wd, pg, q.sources ? q.sources.split('|').filter(Boolean) : null)
        .then(result => {
          const payload = {
            code: 0,
            wd, pg,
            count: result.list.length,
            elapsed: result.elapsed,
            order: result.order,
            list: result.list,
          };
          cacheSet(cacheKey, payload);
          send(res, 200, payload);
        })
        .catch(e => send(res, 500, { code: 500, error: e.message }));
      return;
    }

    if (p === '/api/browse') {
      return send(res, 404, { code: 404, error: '接口已下线' });
    }

    if (p === '/api/detail') {
      const ids = (q.ids || q.id || '').trim();
      const src = (q.src || q.source || '').trim();
      if (!ids) return send(res, 400, { code: 400, error: '缺少 ids' });
      if (!/^https?:\/\//i.test(src)) return send(res, 400, { code: 400, error: '缺少有效的 src' });
      const cacheKey = `d:${src}:${ids}`;
      const hit = cacheGet(cacheKey, now);
      if (hit) return send(res, 200, Object.assign({ code: 0, cached: true }, hit));
      fetchSourceDetail(src, ids)
        .then(d => d
          ? (cacheSet(cacheKey, { code: 0, data: d }), send(res, 200, { code: 0, data: d }))
          : send(res, 404, { code: 404, error: '未找到该影视详情' }))
        .catch(e => send(res, 500, { code: 500, error: e.message }));
      return;
    }

    if (p === '/api/sources') {
      return send(res, 200, { code: 0, sources: DEFAULT_SOURCES });
    }

    if (p === '/api/resolve') {
      const u = (q.url || '').trim();
      if (!/^https?:\/\//i.test(u)) return send(res, 400, { code: 400, error: '缺少有效的 url' });
      const cacheKey = `v:${u}`;
      const hit = cacheGet(cacheKey, now);
      if (hit) return send(res, 200, Object.assign({ code: 0, cached: true }, hit));
      resolveShareLink(u)
        .then(m3u8 => {
          if (m3u8) { cacheSet(cacheKey, { code: 0, url: m3u8 }); return send(res, 200, { code: 0, url: m3u8 }); }
          return send(res, 404, { code: 404, error: '未能解析出直链' });
        })
        .catch(e => send(res, 500, { code: 500, error: e.message }));
      return;
    }

    if (p === '/api/status' || p === '/') {
      return send(res, 200, Object.assign({ code: 0 }, status()));
    }

    if (p === '/player.html' || p === '/player') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, corsHeaders()));
      return res.end(PLAYER_HTML);
    }

    return send(res, 404, { code: 404, error: '未知接口' });
  } catch (e) {
    return send(res, 500, { code: 500, error: e.message });
  }
}

let server = null;
let started = false;
let currentPort = PORT;

async function ensureServer(opts) {
  opts = opts || {};
  if (started && server && server.listening) return { ok: true, port: currentPort };
  if (opts.cacheDir) initCache(opts.cacheDir);
  for (let attempt = 0; attempt <= MAX_PORT_RETRY; attempt++) {
    const tryPort = PORT + attempt;
    try {
      await new Promise((resolve, reject) => {
        const s = http.createServer(handleRequest);
        s.on('error', reject);
        s.timeout = SERVER_TIMEOUT;
        s.listen(tryPort, '127.0.0.1', () => {
          server = s;
          started = true;
          currentPort = tryPort;
          startedAt = Date.now();
          console.log('[movie-api] 本地影视API已启动 http://127.0.0.1:' + tryPort);
          resolve();
        });
      });
      return { ok: true, port: currentPort };
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRY) continue;
      started = false;
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: '所有备选端口均被占用' };
}

function apiGet(path, query) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = `http://127.0.0.1:${currentPort}${path}${qs ? '?' + qs : ''}`;
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 30000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data: { code: -1, raw: data.slice(0, 200) } }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('影视API响应超时')); });
    req.on('error', err => reject(new Error('影视API请求失败：' + err.message)));
  });
}

function stopServer() {
  try { if (server) server.close(); } catch (_) {}
  started = false;
  server = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (cacheDirty && cacheDir) {
    try { fs.writeFileSync(path.join(cacheDir, CACHE_FILE), JSON.stringify(cache)); } catch (_) {}
    cacheDirty = false;
  }
}

function getCurrentPort() { return currentPort; }
module.exports = { ensureServer, apiGet, stopServer, PORT, getCurrentPort, DEFAULT_SOURCES };