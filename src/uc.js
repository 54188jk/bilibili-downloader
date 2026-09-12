/**
 * UC 网盘 / UC 浏览器分享链接解析
 * - extractLinks: 从文本提取 drive.uc.cn 分享链接
 * - parseShare: 加载分享页（隐藏窗口）并通过 pc-api.uc.cn 拉取文件清单
 * - parseShareDetail: 调内部 API 拿 stoken + 文件列表（无需登录，可拿到文件元数据）
 *
 * 注：UC 网盘网页版"下载"按钮实际是引导安装客户端，下载直链需登录账号；
 * 这里提供文件清单 + 元数据 + "在浏览器打开"+"调用 sharepage/save 转存" 两种落地方式。
 */
'use strict';

const { URL } = require('url');
const https = require('https');
const http = require('http');

// ============================================================
// 链接提取
// ============================================================
function extractLinks(text) {
  const out = [];
  const urlRe = /https?:\/\/[^\s"'<>，。；、()]+/gi;
  const m = text.match(urlRe) || [];
  for (const raw of m) {
    const clean = raw.replace(/[，。；、,.;:'")\]}]+$/g, '').trim();
    if (/drive\.uc\.cn|m\.uc\.cn|uc\.cn\/s\//i.test(clean)) {
      if (!out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

// 从分享 URL 提取 pwd_id（分享码）
function getPwdId(input) {
  const url = String(input || '');
  // 形如 https://drive.uc.cn/s/027c05569a674?public=1
  const m1 = url.match(/\/s\/([0-9a-z]{8,})/i);
  if (m1) return m1[1];
  // 备用：链接末尾一段
  const m2 = url.match(/\/([0-9a-z]{12,})/i);
  if (m2) return m2[1];
  return null;
}

// 从分享 URL 中识别是否有提取码 / 公开分享
function inspectShareMeta(input) {
  const url = String(input || '');
  let u;
  try { u = new URL(url); } catch (_) { return { pwdId: null, isPublic: false, passcode: '' }; }
  const pwdId = getPwdId(u.pathname);
  const isPublic = u.searchParams.get('public') === '1' || !u.searchParams.has('pwd');
  // 提取码：通常 ?pwd=xxxx
  const passcode = u.searchParams.get('pwd') || u.searchParams.get('code') || '';
  return { pwdId, isPublic, passcode };
}

// ============================================================
// HTTP 工具
// ============================================================
function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://drive.uc.cn',
        'Referer': 'https://drive.uc.cn/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      }, headers || {}),
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; if (chunks.length > 4 * 1024 * 1024) res.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

// ============================================================
// 隐藏窗口加载分享页（建立 cookie / 获取 base info）
// ============================================================
function loadSharePage(shareUrl) {
  return new Promise((resolve, reject) => {
    const { app, BrowserWindow } = require('electron');
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 750,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { win.destroy(); } catch (_) {} reject(new Error('UC 分享页加载超时')); }
    }, 25000);

    win.webContents.once('did-finish-load', async () => {
      // 等渲染稳定后再抓
      await new Promise(r => setTimeout(r, 1500));
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch (_) {}
      resolve();
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (!settled) { settled = true; clearTimeout(timer); try { win.destroy(); } catch (_) {} reject(new Error('UC 分享页加载失败：' + desc)); }
    });

    win.loadURL(shareUrl).catch(err => {
      if (!settled) { settled = true; clearTimeout(timer); try { win.destroy(); } catch (_) {} reject(err); }
    });
  });
}

// 调分享详情 API（需要在已加载分享页的窗口中执行以共享 cookie）
async function fetchShareDetailInWindow(win, pwdId, passcode) {
  return win.webContents.executeJavaScript(`
    (async () => {
      try {
        const url = 'https://pc-api.uc.cn/1/clouddrive/share/sharepage/v2/detail?pr=UCBrowser&fr=pc';
        const body = JSON.stringify({ pwd_id: ${JSON.stringify(pwdId)}, passcode: ${JSON.stringify(passcode || '')}, is_pwd: ${JSON.stringify(passcode ? '1' : '')}, page: 1, size: 100 });
        const r = await fetch(url, { method:'POST', credentials:'include',
          headers:{'Content-Type':'application/json','Origin':'https://drive.uc.cn','Referer':'https://drive.uc.cn/'},
          body });
        const j = await r.json();
        return { status: r.status, ok: r.ok, data: j.data, code: j.code, message: j.message };
      } catch (e) { return { error: e.message }; }
    })()
  `);
}

// ============================================================
// 解析入口（由主进程以窗口方式调用）
// ============================================================
async function parseShare(shareUrl) {
  const meta = inspectShareMeta(shareUrl);
  if (!meta.pwdId) {
    return { ok: false, error: '未识别到分享码，请使用形如 https://drive.uc.cn/s/xxxxxxxx 的链接' };
  }

  const { app, BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 750,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  try {
    // 1. 加载分享页（建立 cookie 上下文）
    await win.loadURL(shareUrl);
    await new Promise(r => setTimeout(r, 2500));

    // 2. 抓详情
    const detail = await fetchShareDetailInWindow(win, meta.pwdId, meta.passcode);
    if (detail.error) return { ok: false, error: '请求详情失败：' + detail.error };
    if (detail.code && detail.code !== 0) {
      return { ok: false, error: 'UC 返回错误：' + (detail.message || `code=${detail.code}`), code: detail.code };
    }
    if (!detail.data) return { ok: false, error: '未获取到分享数据' };

    const tokenInfo = detail.data.token_info || {};
    const detailInfo = detail.data.detail_info || {};
    const list = detailInfo.list || [];

    const files = list.map(f => ({
      fid: f.fid,
      name: f.file_name || '未命名',
      size: f.size || 0,
      format: f.format_type || '',
      fileType: f.file_type || 0,
      category: f.category || 0,
      dir: !!f.dir,
      shareFidToken: f.share_fid_token || '',
      duration: f.duration || 0,
      createdAt: f.l_created_at || 0,
      updatedAt: f.l_updated_at || 0,
      thumbnail: f.thumbnail || '',
    }));

    return {
      ok: true,
      data: {
        shareTitle: (tokenInfo.title || 'UC 分享').slice(0, 80),
        author: (tokenInfo.author && tokenInfo.author.nick_name) || '',
        avatar: (tokenInfo.author && tokenInfo.author.avatar_url) || '',
        fileNum: tokenInfo.file_num || files.length,
        expiredAt: tokenInfo.expired_at || 0,
        expiredType: tokenInfo.expired_type || 0,
        stoken: tokenInfo.stoken || '',
        pwdId: meta.pwdId,
        passcode: meta.passcode || '',
        isPublic: meta.isPublic,
        shareUrl,
        files,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

module.exports = {
  extractLinks,
  getPwdId,
  inspectShareMeta,
  parseShare,
};
