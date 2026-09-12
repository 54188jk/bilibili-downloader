/**
 * 快手视频分享链接解析（纯函数模块）
 * - extractLinks: 从文本提取快手链接
 * - getPhotoId: 从 URL/文本提取作品 ID
 * - resolvePhotoId: 跟随短链跳转后提取作品 ID（异步）
 * 视频播放地址需在主进程以隐藏窗口加载页面后抓取（快手 PC 页数据为异步渲染）
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// 从文本提取快手链接
function extractLinks(text) {
  const out = [];
  // 第一步：粗匹配所有 http(s) URL
  const urlRe = /https?:\/\/[^\s"'<>，。；、()]+/gi;
  const m = text.match(urlRe) || [];
  for (const raw of m) {
    const clean = raw.replace(/[，。；、,.;:'")\]}]+$/g, '').trim();
    // 第二步：只保留快手相关域名
    if (/v\.kuaishou\.com|kuaishou\.com|gifshow\.com/i.test(clean)) {
      if (!out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

// 从 URL/文本提取 photoId
function getPhotoId(input) {
  const url = typeof input === 'string' ? input : '';
  const m1 = url.match(/(?:short-video|fw\/photo|photo)\/([A-Za-z0-9_-]{8,})/);
  if (m1) return m1[1];
  const m2 = url.match(/photoId=([A-Za-z0-9_-]+)/);
  if (m2) return m2[1];
  const m3 = url.match(/(\d{12,25})/);
  if (m3) return m3[1];
  return null;
}

// 基础 GET，跟随重定向（短链 -> PC 页）
function request(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('重定向次数过多'));
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    } }, res => {
      const loc = res.headers.location;
      if (loc && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        const next = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        return request(next, depth + 1).then(resolve, reject);
      }
      res.resume();
      resolve({ status: res.statusCode, finalUrl: url });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
  });
}

// 解析分享链接（含短链）得到 photoId
async function resolvePhotoId(shareUrl) {
  let pid = getPhotoId(shareUrl);
  if (pid) return pid;
  // 短链 / 未知结构：跟随重定向拿最终地址
  if (/^https?:\/\//i.test(shareUrl)) {
    try {
      const r = await request(shareUrl);
      pid = getPhotoId(r.finalUrl || shareUrl);
    } catch (e) { /* 忽略，用原始 URL 再试一次 */ }
  }
  if (!pid) pid = getPhotoId('' + shareUrl);
  return pid;
}

// 分享短链大概率会 302 到 PC 页，这里不再发请求（由主进程处理）
async function parseShare() {
  return { ok: false, error: '需要以浏览器方式抓取，请在主进程调用窗口解析' };
}

module.exports = {
  extractLinks,
  getPhotoId,
  resolvePhotoId,
  parseShare,
};