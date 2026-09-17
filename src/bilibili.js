/**
 * B 站 API 封装
 * - parseVideo(bvid): 获取视频基础信息（aid, cid, title, duration, cover, owner, ...）
 * - getPlayUrl(bvid, cid, qn): 拉取播放地址，按画质聚合出可选列表
 * - getUserInfo(): 通过 nav API 获取当前登录用户信息（未登录返回 null）
 *
 * 支持可选登录态：调用 setCookie() 注入 B 站 Cookie 后，可解锁高画质。
 */
const https = require('https');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

// 全局 Cookie（登录后由主进程注入）
let globalCookie = '';

function setCookie(cookie) {
  globalCookie = cookie || '';
}
function getCookie() {
  return globalCookie;
}

function buildHeaders(extra = {}) {
  const headers = {
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extra,
  };
  if (globalCookie) headers['Cookie'] = globalCookie;
  return headers;
}

function fetchJson(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: buildHeaders(extraHeaders),
    }, res => {
      // 跟随一次重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location, extraHeaders).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          reject(new Error('返回数据非 JSON：' + buf.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
  });
}

/**
 * 视频基础信息
 */
async function parseVideo(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const json = await fetchJson(url);
  if (json.code !== 0) {
    throw new Error(json.message || `code=${json.code}`);
  }
  const d = json.data || {};
  return {
    aid: d.aid,
    cid: d.cid,
    bvid: d.bvid,
    title: d.title,
    pic: d.pic,
    duration: d.duration,
    durationStr: formatDuration(d.duration),
    desc: d.desc,
    owner: d.owner ? { name: d.owner.name, mid: d.owner.mid, face: d.face } : null,
    stat: d.stat ? {
      view: d.stat.view,
      danmaku: d.stat.danmaku,
      reply: d.stat.reply,
      favorite: d.stat.favorite,
      coin: d.stat.coin,
      share: d.stat.share,
      like: d.stat.like,
    } : null,
    pubDate: d.pubdate,
  };
}

/**
 * 画质 + 播放地址
 * @param {string} bvid
 * @param {number|string} cid
 * @param {number} qn 画质代码：0=默认, 64=720P, 80=1080P, 112=1080P+, 116=1080P60, 120=4K ...
 */
async function fetchPlayurl(bvid, cid, qn, fnval) {
  const url =
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=${fnval}&fnver=0&fourk=1`;
  return fetchJson(url);
}

async function getPlayUrl(bvid, cid, qn = 0) {
  // fnval=16: DASH 格式（音视频分离），支持 1080P+/4K/8K/HDR/杜比
  // fnval=1:  FLV 格式（durl 单流，最高仅 720P）
  // 注意：两位置不能合并成 fnval=17 一次请求 —— B 站对同时带两位的请求只返回 durl、
  // 丢弃 dash 字段（2026-09 实测回归，导致高画质 DASH 整体失效）。
  // 因此先请求 DASH（主路径），仅当 dash 缺失或请求失败时，再用 fnval=1 发 FLV 兜底请求。
  const qnParam = qn || 120; // 默认请求 4K，服务器会按权限降级

  let json = await fetchPlayurl(bvid, cid, qnParam, 16);
  if (json.code !== 0 || !(json.data && json.data.dash)) {
    // DASH 缺失/失败：FLV 兜底请求（单流直下，无需 ffmpeg 合并）
    let flv = null;
    try {
      flv = await fetchPlayurl(bvid, cid, qnParam, 1);
      if (flv.code !== 0) flv = null;
    } catch (_) { flv = null; }
    if (flv) json = flv;
    else if (json.code !== 0) throw new Error(json.message || `code=${json.code}`);
  }
  const d = json.data || {};
  const acceptQn = Array.isArray(d.accept_quality) ? d.accept_quality : [];
  const acceptDesc = Array.isArray(d.accept_description) ? d.accept_description : [];

  // 画质映射表
  const qnMap = {
    6: '240P 极速',
    16: '360P 流畅',
    32: '480P 清晰',
    64: '720P 高清',
    80: '1080P 高清',
    112: '1080P+ 高码率',
    116: '1080P60 高帧率',
    120: '4K 超清',
    125: 'HDR 真彩',
    126: '杜比视界',
    127: '8K 超高清',
  };

  // ---- DASH 格式处理（fnval 含 16 位时返回 dash 字段） ----
  const dash = d.dash || null;
  let dashInfo = null;
  if (dash) {
    const videos = Array.isArray(dash.video) ? dash.video : [];
    const audios = Array.isArray(dash.audio) ? dash.audio : [];
    // 按画质分组视频流（同 qn 取最高码率）
    const videoByQn = {};
    for (const v of videos) {
      const vqn = v.id;
      if (!videoByQn[vqn] || v.bandwidth > videoByQn[vqn].bandwidth) {
        videoByQn[vqn] = v;
      }
    }
    // 最高音质音频流
    const bestAudio = audios.length
      ? audios.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a))
      : null;

    dashInfo = {
      videos: videoByQn,    // { qn: {id, baseUrl, backupUrl, codecs, bandwidth, mimeType} }
      audios,               // 所有音频流
      bestAudio,            // 最高码率音频
      flac: dash.flac || null,     // 无损音频（Hi-Res）
      dolby: dash.dolby || null,   // 杜比音频
    };
  }

  // ---- FLV 格式兜底（fnval 仍可能返回 durl） ----
  const durls = Array.isArray(d.durl) ? d.durl : [];
  const primary = durls[0] || {};

  // 构建画质列表
  // DASH 模式：从 dash.video 的 id 提取可用画质
  // FLV 模式：从 accept_quality 提取
  const availableQns = dashInfo
    ? [...new Set(Object.keys(dashInfo.videos).map(Number))].sort((a, b) => b - a)
    : acceptQn;

  const qualities = availableQns.map(qn2 => ({
    qn: qn2,
    label: qnMap[qn2] || acceptDesc[acceptQn.indexOf(qn2)] || `画质 ${qn2}`,
    description: acceptDesc[acceptQn.indexOf(qn2)] || '',
    url: null,  // 下载时按 qn 动态取
    // DASH 画质：用该画质视频流带宽估算字节大小（bandwidth 单位 bps，timelength 单位 ms）
    // 无 DASH 流时回退到 FLV 单文件大小（primary.size）；彻底无数据则 0
    // 修复：原逻辑恒取 primary.size，而 fnval=16 时 durl 为空 -> 所有画质 size 永远为 0
    size: (dashInfo && dashInfo.videos[qn2])
      ? (d.timelength && dashInfo.videos[qn2].bandwidth
          ? Math.round((dashInfo.videos[qn2].bandwidth / 8) * (d.timelength / 1000))
          : 0)
      : (primary.size || 0),
    current: qn2 === d.quality,
    dash: !!(dashInfo && dashInfo.videos[qn2]), // 标记该画质是否有 DASH 流
  }));

  return {
    isLogin: !!(globalCookie),
    quality: d.quality,
    qualityLabel: qnMap[d.quality] || `画质 ${d.quality}`,
    format: dash ? 'dash' : (d.format || 'mp4'),
    duration: d.timelength,
    durationStr: formatDuration(d.timelength),
    acceptQn,
    acceptDesc,
    qualities,
    playUrl: dashInfo && dashInfo.bestAudio
      ? (dashInfo.videos[d.quality] ? dashInfo.videos[d.quality].baseUrl : null)
      : (durls[0] ? durls[0].url : null),
    segments: durls,
    dash: dashInfo,         // DASH 详细信息（视频流 + 音频流）
  };
}

// 统一解析 backupUrl：B 站正常返回数组，但上游若改为返回字符串，直接 [0] 会取到首字符（如 "h"）导致下载失败。
// 数组取首项、字符串直接返回、其它情况返回空串。
function firstBackup(bu) {
  if (!bu) return '';
  if (Array.isArray(bu)) return bu[0] || '';
  if (typeof bu === 'string') return bu;
  return '';
}

// 根据画质代码获取 DASH 下载所需的视频流 + 音频流 URL
function getDashStreamUrls(dashInfo, qn) {
  if (!dashInfo) return null;
  const video = dashInfo.videos[qn];
  if (!video) return null;
  // 优先无损 FLAC > 杜比 > 最高码率音频
  let audioUrl = '';
  let audioCodec = '';
  if (dashInfo.flac && dashInfo.flac.audio) {
    audioUrl = dashInfo.flac.audio.baseUrl || '';
    audioCodec = 'flac';
  } else if (dashInfo.dolby && dashInfo.dolby.audio && dashInfo.dolby.audio.length) {
    audioUrl = dashInfo.dolby.audio[0].baseUrl || '';
    audioCodec = 'dolby';
  } else if (dashInfo.bestAudio) {
    audioUrl = dashInfo.bestAudio.baseUrl || '';
    audioCodec = dashInfo.bestAudio.codecs || '';
  }
  return {
    videoUrl: video.baseUrl || '',
    videoBackup: firstBackup(video.backupUrl || video.backup_url),
    videoCodec: video.codecs || '',
    videoBandwidth: video.bandwidth || 0,
    audioUrl,
    audioBackup: dashInfo.bestAudio ? firstBackup(dashInfo.bestAudio.backupUrl || dashInfo.bestAudio.backup_url) : '',
    audioCodec,
  };
}

// 从 durl 分段中取播放地址：优先 url；如果该分段没有 url 则拼接分段
function playUrlOf(durls) {
  if (!durls.length) return null;
  return durls[0].url || null;
}

function check(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * B 站搜索视频（综合 + 番剧/影视 合并）
 * @param {string} keyword 搜索关键词
 * @param {number} page 页码（从 1 开始）
 * @returns {Promise<Array<{bvid, cid, title, pic, duration, durationStr, owner, play, type, seasonId}>>}
 */
async function searchVideo(keyword, page = 1) {
  const kw = encodeURIComponent(keyword);
  let videoResults = [];
  let pgcResults = [];

  // 视频综合搜索
  try {
    const url =
      `https://api.bilibili.com/x/web-interface/wbi/search/type` +
      `?search_type=video&keyword=${kw}&page=${page}` +
      `&page_size=20&order=totalrank`;
    const json = await fetchJson(url);
    if (json.code === 0) {
      videoResults = normalizeSearch(json.data);
    } else {
      const alt = await fetchJson(
        `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${kw}&page=${page}&page_size=20&order=totalrank`
      );
      if (alt.code === 0) videoResults = normalizeSearch(alt.data);
    }
  } catch (_) {}

  // 番剧 / 影视 搜索（官方剧集），合并到结果顶部
  try {
    const pgcUrl =
      `https://api.bilibili.com/x/web-interface/wbi/search/type` +
      `?search_type=pgc&keyword=${kw}&page=1` +
      `&page_size=10`;
    const pgc = await fetchJson(pgcUrl);
    if (pgc.code === 0) {
      pgcResults = normalizePgcSearch(pgc.data);
    }
  } catch (_) {}

  return [...pgcResults, ...videoResults];
}

function normalizePgcSearch(data) {
  const list = (data && data.result) || [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const seasonId = it.season_id || it.seasonId;
    // 取第一个可播放分集作为默认
    const ep = (it.episodes && it.episodes[0]) || null;
    const title = (it.title || '').replace(/<[^>]+>/g, '');
    out.push({
      type: 'pgc',
      seasonId,
      bvid: (ep && ep.bvid) || '',
      cid: (ep && ep.id) || 0,
      aid: (ep && ep.aid) || 0,
      title,
      pic: it.cover || it.pic || '',
      play: it.stat && (it.stat.play || it.stat.view || 0) || 0,
      duration: it.duration || 0,
      durationStr: '影视/番剧',
      owner: (it.areas && it.areas.length ? it.areas[0].name : '') || 'B站剧集',
      desc: (it.styles || []).map(s => s).join(' / '),
      epTitle: (ep && ep.title) || '',
    });
  }
  return out;
}

function normalizeSearch(data) {
  let list = (data && data.result) || [];
  list = (list || []).filter(it => it && it.bvid);
  // 过滤掉明显过短的用户剪辑（< 45 秒），提升结果质量
  list = list.filter(it => {
    if (!it.duration) return true;
    if (typeof it.duration === 'string') {
      const sec = parseDurStr(it.duration);
      return sec === null || sec >= 45;
    }
    return true;
  });
  // 按播放量降序，尽量把官方/完整视频排前面
  list = list.slice().sort((a, b) => (Number(b.play) || 0) - (Number(a.play) || 0));

  const out = [];
  for (const it of list) {
    if (!it.bvid) continue;
    let durationStr = '--:--';
    if (it.duration && typeof it.duration === 'string') {
      const [m = '0', s = '0'] = it.duration.split(':');
      durationStr = `${m}:${s}`;
    }
    out.push({
      type: 'video',
      bvid: it.bvid,
      cid: it.cid || 0,
      title: it.title || '',
      pic: it.pic || '',
      play: it.play || 0,
      duration: durationStr,
      durationStr,
      owner: (it.author && typeof it.author === 'string') ? it.author : '',
      desc: it.description || '',
    });
  }
  return out;
}

function parseDurStr(str) {
  const parts = String(str).split(':').map(Number);
  if (parts.some(isNaN) || !parts.length) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * 获取登录用户信息（nav API）
 * @returns {object|null} { mid, name, face, level, vip, isLogin }
 */
async function getUserInfo() {
  const json = await fetchJson('https://api.bilibili.com/x/web-interface/nav');
  if (json.code !== 0 || !json.data || !json.data.isLogin) {
    return { isLogin: false };
  }
  const d = json.data;
  return {
    isLogin: true,
    mid: d.mid,
    name: d.uname,
    face: d.face,
    level: d.level_info ? d.level_info.current_level : 0,
    coin: d.money,
    vip: d.vipStatus === 1 || d.vipType > 0,
  };
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 从一段文本中提取所有 B 站链接（视频 BV 号 + 图片动态 opus id）
 * @param {string} text
 * @returns {Array<{kind:'video', id:string}|{kind:'image', id:string}>}
 */
function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const push = (kind, id) => {
    const key = kind + ':' + id;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ kind, id });
    }
  };
  const s = String(text || '');
  // opus 图片动态：bilibili.com/opus/<id> 或 /opus/<id>?story=... 分享
  const opusRe = /(?:bilibili\.com|b23\.tv)\/opus\/(\d+)/gi;
  let m;
  while ((m = opusRe.exec(s)) !== null) push('image', m[1]);
  // 短链 b23.tv 指向 opus 时无法直接取 id，尝试 /opus/ 短链 id 格式（数字）
  const opusShort = /opus\/(\d{5,})/gi;
  while ((m = opusShort.exec(s)) !== null) push('image', m[1]);
  // read 图文(cv/art) 老链接：read/cv123 或 read/mobile?id=123
  const cvRe = /bilibili\.com\/read\/cv(\d+)/gi;
  while ((m = cvRe.exec(s)) !== null) push('image', m[1]);
  const mobileRe = /bilibili\.com\/read\/mobile\?id=(\d+)/gi;
  while ((m = mobileRe.exec(s)) !== null) push('image', m[1]);
  // 视频 BV 号（12 位标准或完整链接）
  const bvRe = /BV[1-9A-HJ-NP-Za-km-z]{10}/g;
  while ((m = bvRe.exec(s)) !== null) push('video', m[0]);
  return out;
}

/**
 * 解析 B 站图文动态（图片作品）
 * @param {string|number} opusId
 * @returns {Promise<{opusId:number, title:string, images:string[], count:number}>}
 * 图片大小：images 为原图 urls（可加 @1920w 后缀或直接用）
 */
async function parseImage(opusId) {
  const json = await fetchJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${encodeURIComponent(opusId)}`);
  if (json.code !== 0) {
    // 老接口兜底：相册/图文
    const alt = await fetchJson(`https://api.bilibili.com/x/dynamic/opus/going?id=${encodeURIComponent(opusId)}`);
    if (alt.code !== 0) throw new Error(json.message || `code=${json.code}`);
    return normalizeOpus(alt.data && alt.data.item);
  }
  const item = json.data && json.data.item;
  return normalizeOpus(item);
}

function normalizeOpus(item) {
  if (!item) throw new Error('未找到该图文内容');
  const major = item.modules && item.modules.module_dynamic && item.modules.module_dynamic.major;
  const draw = major && major.draw;
  const desc = item.modules && item.modules.module_dynamic && item.modules.module_dynamic.desc;
  const text = (desc && desc.text) || 'B 站图文';
  const images = [];
  if (draw && Array.isArray(draw.items)) {
    draw.items.forEach(it => {
      if (it && it.src) images.push(it.src);
    });
  }
  // 兜底：item 顶层直接带 images
  if (!images.length && Array.isArray(item.images)) {
    item.images.forEach(u => images.push(u));
  }
  if (!images.length) throw new Error('该图文没有图片');
  return {
    title: text.replace(/\s+/g, ' ').slice(0, 60) || `B站图文_${item.id || ''}`,
    images,
    count: images.length,
  };
}

module.exports = {
  parseVideo,
  getPlayUrl,
  getUserInfo,
  parseImage,
  extractLinks,
  setCookie,
  getCookie,
  buildHeaders,
  fetchJson,
  getDashStreamUrls,
  searchVideo,
};