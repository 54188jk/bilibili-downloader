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
      let data = '';
      const maxLen = 5 * 1024 * 1024;
      res.on('data', c => { data += c; if (data.length > maxLen) res.destroy(); });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        finalUrl: url,
        body: data,
      }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
  });
}

// 跟随重定向拿最终地址
async function followRedirect(url, depth = 0) {
  if (depth > 5) throw new Error('重定向次数过多');
  const r = await request(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  }});
  const loc = r.headers.location;
  if (loc && r.status >= 300 && r.status < 400) {
    const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
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
// 备选方案：iesdouyin 分享页抓取
// ========================
async function fetchShareData(awemeId) {
  const r = await request(`https://www.iesdouyin.com/share/video/${awemeId}`);
  if (r.status !== 200) throw new Error('分享页请求失败 HTTP ' + r.status);

  const body = r.body;

  const pick = (keys) => {
    for (const k of keys) {
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
  };

  const playAddr = pick(['"play_addr"', 'play_addr']);
  const coverData = pick(['"cover"']);
  const desc = pick(['"desc"', '"Desc"']);
  const author = pick(['"author"']);
  const title = pick(['"title"']);

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
  if (status === 6 || status === 6001) {
    // 未登录 / csrf 校验失败
    return { needLogin: true, list: [] };
  }
  return { needLogin: false, list: [] };
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
    // ---- 主方案：tjit 免费接口 ----
    try {
      const data = await parseViaTjit(shareUrl);
      if (data.videoUrl) return { ok: true, data, source: 'tjit' };
    } catch (e) {
      if (e.message === 'CONFIG_MISSING_KEY') {
        return { ok: false, error: '未配置抖音解析密钥（请在 config.json 填写 douyinKey，免费申请地址 https://api.tjit.net/user/key）' };
      }
      // 其他错误（key 无效、接口异常等）继续走备选
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
};
