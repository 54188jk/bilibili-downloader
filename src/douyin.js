'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ========================
// 读取 API Key 配置
// ========================
function loadConfig() {
  try {
    const cfgPath = path.join(__dirname, '..', 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

// ========================
// 基础请求（默认移动端 UA）
// ========================
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }, opts.headers || {});

    const req = lib.get(url, { headers }, res => {
      // 3xx 重定向：立即丢弃响应体（原实现会把中间页整页 body 下载完才返回，白白拖慢解析）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ status: res.statusCode, headers: res.headers, finalUrl: url, body: '' });
      }
      let data = '';
      const maxLen = 5 * 1024 * 1024;
      res.on('data', c => {
        data += c;
        if (data.length > maxLen) return res.destroy();
        // 流式提前终止：数据够用（已能取出 play_addr）就立刻断开，不等整页下载完
        if (opts.earlyStop && res.statusCode === 200) {
          let stop = false;
          try { stop = !!opts.earlyStop(data); } catch (_) {}
          if (stop) {
            res.destroy();
            return resolve({ status: res.statusCode, headers: res.headers, finalUrl: url, body: data });
          }
        }
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        finalUrl: url,
        body: data,
      }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs || 20000, () => req.destroy(new Error('请求超时')));
  });
}

// 跟随重定向拿最终地址（每跳限时 8s，短链解析不再长时间卡顿）
async function followRedirect(url, depth = 0) {
  if (depth > 5) throw new Error('重定向次数过多');
  const r = await request(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    timeoutMs: 8000,
  });
  const loc = r.headers.location;
  if (loc && r.status >= 300 && r.status < 400) {
    const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
    // 提前退出：这一跳的目标地址里已经带 aweme_id，就没有必要再跟下一跳（省 1~2 个 RTT）
    if (extractAwemeId(next)) {
      return { status: r.status, headers: r.headers, finalUrl: next, body: '' };
    }
    return followRedirect(next, depth + 1);
  }
  return r;
}

// ========================
// 从分享文本中找出抖音链接
// ========================
function extractLinks(text) {
  const out = [];
  const re = /(https?:\/\/[^\s"'<>，。；、]+?(?:v\.douyin\.com\/[\w-]+|douyin\.com\/[^\s"']*|iesdouyin\.com\/[^\s"']*|tiktok\.com\/[^\s"']*))/gi;
  const m = text.match(re) || [];
  for (const raw of m) {
    const clean = raw.replace(/[，。；、,.;:'")\]}]+$/g, '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

// ========================
// 从最终地址 / 分享文本提取 aweme_id
// ========================
function extractAwemeId(url) {
  const m1 = url.match(/\/video\/(\d{15,20})/);
  if (m1) return m1[1];
  const m2 = url.match(/aweme_id=(\d{15,20})/);
  if (m2) return m2[1];
  const m3 = url.match(/(?:share\/video|video)\/(\d{15,20})/);
  if (m3) return m3[1];
  return null;
}

function extractAwemeIdFromText(text) {
  const m = String(text).match(/(\d{15,20})/);
  return m ? m[1] : null;
}

// ========================
// 跳转短链拿真实地址（桌面 UA）
// ========================
async function resolveUrl(shareUrl) {
  const r = await followRedirect(shareUrl);
  const final = r.finalUrl || r.location || shareUrl;
  const id = extractAwemeId(final);
  if (id) return { finalUrl: final, awemeId: id };
  return { finalUrl: final, awemeId: null };
}

// ========================
// 主方案：tjit.net（明伟数据）免费接口
// ========================
async function parseViaTjit(shareUrl) {
  const cfg = loadConfig();
  const key = (cfg.douyinKey || '').trim();
  if (!key) throw new Error('CONFIG_MISSING_KEY');

  const apiUrl = `https://api.tjit.net/api/douyin/?key=${encodeURIComponent(key)}&url=${encodeURIComponent(shareUrl)}`;
  const body = await httpGetPlain(apiUrl);

  let data;
  try { data = JSON.parse(body); } catch (_) { throw new Error('tjit 返回异常 JSON'); }

  if (data.code !== 200) {
    throw new Error('tjit: ' + (data.msg || ('错误码 ' + data.code)));
  }

  const d = data.data || {};
  let videoUrl = d.play || d.url || d.videourl || '';
  if (!videoUrl && d.video_url) videoUrl = d.video_url;

  // tjit 的 data.play 可能是中间地址，需经服务端中转得到最终直链
  if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
    try {
      const final = await followRedirect(`https://api.tjit.net/api/douyin/get_play?play=${encodeURIComponent(videoUrl)}`);
      if (final && /^https?:\/\//i.test(final.finalUrl)) videoUrl = final.finalUrl;
    } catch (_) { /* 保留原地址 */ }
  }

  return {
    awemeId: '',
    title: d.desc || d.title || '抖音视频',
    cover: d.cover || d.img || '',
    videoUrl,
    author: d.nickname || d.author || (d.author_data && d.author_data.nickname) || '',
  };
}

// ========================
// 通用第三方解析线路：按 config.dyApiList 模板并发调用
// 模板变量：{url}=编码后的分享链接 {key}=密钥 {id}=用户ID {aweme}=aweme_id
// 只要第三方接口返回 JSON（字段名随意），pickVideoDeep 都能挖出播放地址
// ========================
function withTimeout(p, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(tag + ' 超时 ' + ms + 'ms')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// 从任意结构 JSON 深度挖：播放地址 / 封面 / 标题 / 作者
function pickVideoDeep(root) {
  const out = { videoUrl: '', cover: '', title: '', author: '' };
  const VIDEO_RE = /(\.mp4(\?|#|$))|aweme\/v1\/play|douyinvod|v\d+-dy[-.](cold|a|b)|douyin-iesdouyin/i;
  const IMG_RE = /(douyinpic|\.jpe?g(\?|$)|\.png(\?|$)|\.webp(\?|$))/i;
  const queue = [root];
  let seen = 0;
  const TITLE_KEYS = /^(desc|title|content|caption)$/i;
  const AUTHOR_KEYS = /^(nickname|author|author_name|user_name|name|uname)$/i;
  const COVER_KEYS = /^(cover|cover_url|coverUrl|image|img|poster|origin_cover|avatar)$/i;
  while (queue.length && seen < 3000) {
    const cur = queue.shift();
    seen++;
    if (typeof cur === 'string') {
      if (!out.videoUrl && VIDEO_RE.test(cur) && /^https?:/i.test(cur)) out.videoUrl = cur;
      else if (!out.cover && IMG_RE.test(cur) && /^https?:/i.test(cur)) out.cover = cur;
      continue;
    }
    if (Array.isArray(cur)) { queue.push(...cur.slice(0, 60)); continue; }
    if (cur && typeof cur === 'object') {
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === 'string') {
          if (!out.videoUrl && VIDEO_RE.test(v) && /^https?:/i.test(v)) { out.videoUrl = v; continue; }
          if (TITLE_KEYS.test(k) && !out.title && v.trim()) { out.title = v.trim().slice(0, 120); continue; }
          if (AUTHOR_KEYS.test(k) && !out.author && v.trim()) { out.author = v.trim().slice(0, 40); continue; }
          if (COVER_KEYS.test(k) && !out.cover && IMG_RE.test(v)) { out.cover = v; continue; }
        } else if (v && typeof v === 'object') queue.push(v);
      }
    }
  }
  // 去水印：playwm -> play
  if (out.videoUrl) out.videoUrl = out.videoUrl.replace('/playwm', '/play');
  return out;
}

// 识别第三方接口的业务错误（各家门口径不一，取最像的那句）
function pickApiError(json) {
  if (!json || typeof json !== 'object') return '';
  if (json.success === false || json.ok === false) {
    const e = json.error;
    return String((e && (e.message || e.msg)) || json.message || json.msg || json.code || '接口返回失败').slice(0, 120);
  }
  if (json.code !== undefined && json.code !== 200 && json.code !== 1 && json.code !== '200' && json.code !== '1') {
    return String(json.msg || json.message || json.error || ('错误码 ' + json.code)).slice(0, 120);
  }
  return '';
}

// 读取 config.dyApiList：返回模板齐全且已填 key 的线路
function listConfiguredApis() {
  const cfg = loadConfig();
  const list = Array.isArray(cfg.dyApiList) ? cfg.dyApiList : [];
  const out = [];
  for (const api of list) {
    if (!api || typeof api.url !== 'string') continue;
    const tpl = api.url.trim();
    if (!tpl || !tpl.startsWith('http')) continue;
    // 模板声明了 {key} 或 {id} 但没填值 → 跳过（避免无谓请求拿"秘钥错误"）
    if (/\{key\}/.test(tpl) && !(api.key || '').trim()) continue;
    if (/\{id\}/.test(tpl) && !(api.id || '').trim()) continue;
    out.push({ name: String(api.name || '第三方接口').slice(0, 24), url: tpl, key: String(api.key || ''), id: String(api.id || '') });
  }
  return out;
}

async function parseViaNamedApi(shareUrl, api, awemeId = '') {
  const full = api.url
    .replace('{url}', encodeURIComponent(shareUrl))
    .replace('{key}', encodeURIComponent(api.key || ''))
    .replace('{id}', encodeURIComponent(api.id || ''))
    .replace('{aweme}', encodeURIComponent(awemeId || ''));
  const body = await withTimeout(httpGetPlain(full), 8000, api.name);
  let json;
  try { json = JSON.parse(body); } catch (_) { throw new Error(api.name + ': 返回不是 JSON'); }
  const err = pickApiError(json);
  const picked = pickVideoDeep(json);
  if (!picked.videoUrl) throw new Error(api.name + ': ' + (err || '未找到播放地址'));
  return {
    awemeId: awemeId || '',
    title: picked.title || '抖音视频',
    cover: picked.cover || '',
    videoUrl: picked.videoUrl,
    author: picked.author || '',
  };
}


// ========================
// 备选方案：iesdouyin 分享页抓取
// ========================
// 从 HTML 中按键取值并解析成 JSON 片段（带括号深度与字符串状态机）
function pickJson(body, keys) {
  const keyList = Array.isArray(keys) ? keys : [keys];
  for (const k of keyList) {
    const idx = body.indexOf(k);
    if (idx >= 0) {
      let start = body.indexOf(':', idx + k.length);
      if (start < 0) continue;
      start += 1;
      while (body[start] === ' ') start++;
      let end = start, depth = 0, inStr = false;
      for (; end < body.length; end++) {
        const ch = body[end];
        if (inStr) {
          if (ch === '\\') { end++; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) { end++; break; }
        }
      }
      const frag = body.slice(start, end);
      try { return JSON.parse(frag); } catch (_) { continue; }
    }
  }
  return null;
}

// play_addr 是否已经完整到达（用于流式提前断流）
function hasPlayableAddr(buf) {
  if (buf.indexOf('play_addr') < 0) return false;
  const pa = pickJson(buf, ['"play_addr"', 'play_addr']);
  return !!(pa && Array.isArray(pa.url_list) && pa.url_list.length);
}

async function fetchShareData(awemeId) {
  // 流式请求：只要 play_addr 到手就立刻断开连接，
  // 分享页完整 HTML 动辄数 MB，提前终止可省掉大半下载时间
  const r = await request(`https://www.iesdouyin.com/share/video/${awemeId}`, {
    timeoutMs: 10000,
    earlyStop: hasPlayableAddr,
  });
  if (r.status !== 200) throw new Error('分享页请求失败 HTTP ' + r.status);

  const body = r.body;
  if (!hasPlayableAddr(body)) throw new Error('分享页未返回播放地址');

  const playAddr = pickJson(body, ['"play_addr"', 'play_addr']);
  const coverData = pickJson(body, ['"cover"']);
  const desc = pickJson(body, ['"desc"', '"Desc"']);
  const author = pickJson(body, ['"author"']);
  const title = pickJson(body, ['"title"']);
  // 统计数据（点赞/评论/收藏/转发/播放/弹幕），分享页未返回时为 null
  const st = pickJson(body, ['"statistics"']);
  const stats = (st && typeof st === 'object') ? {
    play: st.play_count || 0,
    digg: st.digg_count || 0,
    comment: st.comment_count || 0,
    collect: st.collect_count || 0,
    share: st.share_count || 0,
    danmaku: st.danmaku_count || 0,
  } : null;

  let url = '';
  if (playAddr && Array.isArray(playAddr.url_list) && playAddr.url_list.length) {
    url = playAddr.url_list.find(u => /playwm/i.test(u)) || playAddr.url_list[0];
  }
  if (url) url = url.replace(/\/playwm\//, '/play/');

  let cover = '';
  if (coverData && Array.isArray(coverData.url_list) && coverData.url_list.length) {
    cover = coverData.url_list[0].replace(/^http:/, 'https:');
  }

  let authorName = '';
  if (author && typeof author === 'object') authorName = author.nickname || '';

  return {
    awemeId,
    title: (desc && typeof desc === 'string' && desc) ? desc : (typeof title === 'string' ? title : '抖音视频'),
    cover,
    videoUrl: url,
    author: authorName,
    stats,
  };
}

// ========================
// 简易 HTTP GET
// ========================
function httpGetPlain(url) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        return httpGetPlain(next).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) res.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
  });
}

// ========================
// 抖音关键词搜索（需要登录 cookie；返回视频列表）
// @param {string} keyword 关键词
// @param {string} cookie  抖音 cookie（可选，未登录时结果可能为空/受限）
// @returns {Promise<Array<{awemeId,title,cover,author,playCount,duration}>>}
// ========================
async function searchVideoByKeyword(keyword, cookie = '') {
  const encoded = encodeURIComponent(keyword);
  // 通用商品/视频搜索接口（web/search/aweme 可获得公开视频结果）
  const apiUrl =
    `https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=${encoded}` +
    `&search_channel=aweme_general&sort_type=0&publish_time=0&search_source=normal_search` +
    `&query_correct_type=1&offset=0&count=20&device_platform=webapp&aid=6383`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.douyin.com/',
    'Accept': 'application/json, text/plain, */*',
  };
  if (cookie) headers['Cookie'] = cookie;

  const r = await request(apiUrl, { headers });
  let json;
  try { json = JSON.parse(r.body); } catch (_) { throw new Error('抖音搜索返回异常'); }

  const status = json.status_code;
  if (status === 0 && json.data && Array.isArray(json.data)) {
    const out = [];
    for (const g of json.data) {
      const it = g && (g.aweme_info || g.aweme || g);
      if (!it || !it.aweme_id) continue;
      const stat = it.statistics || {};
      let du = (it.duration || 0) / 1000;
      if (!du && it.video && it.video.duration) du = it.video.duration / 1000;
      out.push({
        awemeId: String(it.aweme_id),
        title: it.desc || it.title || '抖音视频',
        cover: (it.video && it.video.cover && it.video.cover.url_list && it.video.cover.url_list[0]) || '',
        author: (it.author && it.author.nickname) || '',
        playCount: stat.play_count || 0,
        duration: Math.round(du),
      });
    }
    return out;
  }
  if (status === 6 || status === 6001 || status === 2483) {
    // 未登录 / csrf 校验失败 / 请先登录再搜索
    return { needLogin: true, list: [], error: json.status_msg || '请先登录后再搜索' };
  }
  if (status !== 0) {
    // 其他错误（风控/签名失效等）明确透传，不再静默返回空列表
    return { needLogin: false, list: [], error: json.status_msg || ('搜索失败 code ' + status) };
  }
  // status === 0 但 data 非数组（结构异常/无结果）：给出统一结构，避免主进程 r.list 崩溃
  return { needLogin: false, list: [], error: json.status_msg || '未搜索到相关视频' };
}

// 通过 aweme_id 直接解析无水印视频（复用现有逻辑）
async function parseByAwemeId(awemeId) {
  if (!awemeId) return { ok: false, error: '缺少视频 ID' };
  try {
    const data = await fetchShareData(awemeId);
    if (data.videoUrl) return { ok: true, data, source: 'iesdouyin' };
  } catch (_) {}
  return { ok: false, error: '未能获取该视频播放地址' };
}

// ========================
// 对外主入口：解析一条分享链接
// ========================
async function parseShare(shareUrl) {
  try {
    // ---- 主方案：tjit 免费接口（仅在配置了 douyinKey 时启用）----
    // 注意：无 key 不能直接报错返回，否则备选线路永远没有机会跑（曾导致未配置密钥时全部解析失败）
    const cfg = loadConfig();
    if ((cfg.douyinKey || '').trim()) {
      try {
        const data = await parseViaTjit(shareUrl);
        if (data.videoUrl) return { ok: true, data, source: 'tjit' };
      } catch (_) { /* key 无效、接口异常等继续走备选 */ }
    }

    // ---- 备选方案：iesdouyin 分享页抓取 ----
    let awemeId = null;
    awemeId = extractAwemeId(shareUrl);
    if (!awemeId) {
      const resolved = await resolveUrl(shareUrl);
      awemeId = resolved.awemeId;
      if (!awemeId) {
        awemeId = extractAwemeIdFromText(resolved.finalUrl);
      }
    }

    if (awemeId) {
      try {
        const data = await fetchShareData(awemeId);
        if (data.videoUrl) return { ok: true, data, source: 'iesdouyin' };
      } catch (_) { /* 备选失败 */ }
    }

    // ---- 全部失败 ----
    if (!awemeId) return { ok: false, error: '无法解析该抖音链接（仅支持分享链接或视频 ID）' };
    return { ok: false, error: '未获取到视频播放地址（请检查 config.json 中的 douyinKey 是否有效）' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==========================================================
// 对外导出
// ==========================================================
module.exports = {
  extractLinks,
  parseShare,
  resolveUrl,
  extractAwemeId,
  searchVideoByKeyword,
  parseByAwemeId,
  parseViaTjit,
  parseViaNamedApi,
  listConfiguredApis,
  pickVideoDeep,
  loadConfig,
};
