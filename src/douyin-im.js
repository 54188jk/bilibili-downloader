'use strict';

/**
 * douyin-im.js — 抖音网页版私信（原生 API 对接）
 *
 * 设计要点（重要）：
 * 1. 抖音网页版私信接口（conversation/list、message/list、message/send）属于登录态私有接口，
 *    请求必须带有效登录 Cookie + 反爬签名（X-Bogus / a_bogus）。a_bogus 由抖音前端 JS（byted_acrawler）
 *    在真实浏览器环境内生成，且带有 JSVMP 保护，无法稳定地在 Node 端复刻。
 * 2. 因此本模块不自己复刻签名，而是复用一个「已登录的隐藏 BrowserWindow」——
 *    在页面上下文（page context）里调用抖音自己的 sign 函数生成签名，再用 fetch 发请求。
 *    这样签名永远有效、且随抖音前端更新自动跟随。
 * 3. 登录态直接复用主进程已有的抖音登录（dyauth）：先确保 cookie 已注入默认 session，
 *    再让隐藏窗口加载 douyin.com（此时 acrawler 已就绪）。
 *
 * 端点地址放在顶部常量，若抖音改版只需改这里。
 */

const { BrowserWindow } = require('electron');

// ============================================================
// 接口地址（consumer web）。如抖音改版，只改这里即可。
// ============================================================
const IM_BASE = 'https://www.douyin.com/aweme/v1/web/im';
const ENDPOINT = {
  conversations: (cursor = 0) =>
    `${IM_BASE}/conversation/list/?count=20&cursor=${cursor}&aid=6383&device_platform=webapp`,
  messages: (conversationId, cursor = 0) =>
    `${IM_BASE}/message/list/?conversation_id=${encodeURIComponent(conversationId)}&count=20&cursor=${cursor}&aid=6383&device_platform=webapp`,
  send: () => `${IM_BASE}/message/send/`,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 主进程注入的认证上下文（在 init 时由 main.js 提供）
let ctx = null;
let imWin = null;
let imReady = false;
let creating = false;

function init(context) {
  ctx = context; // { loadDyAuth, isDyLoggedIn, injectDyCookieToSession, getDouyinCookieHeader }
}

function isLoggedIn() {
  if (!ctx) return false;
  try {
    const saved = ctx.loadDyAuth();
    if (saved && saved.cookie && ctx.isDyLoggedIn(ctx.getDouyinCookieHeader().map)) return true;
  } catch (_) {}
  return false;
}

// 确保隐藏窗口已创建并处于已登录状态
async function ensureImWindow() {
  if (imWin && !imWin.isDestroyed() && imReady) return imWin;
  if (creating) {
    // 等待创建完成
    for (let i = 0; i < 40; i++) {
      if (imWin && !imWin.isDestroyed() && imReady) return imWin;
      await sleep(300);
    }
  }
  creating = true;
  try {
    if (!ctx) throw new Error('douyin-im 未初始化');
    const saved = ctx.loadDyAuth();
    if (!saved || !saved.cookie || !ctx.isDyLoggedIn(ctx.getDouyinCookieHeader().map)) {
      throw new Error('NEED_LOGIN');
    }
    // 把持久化的 cookie 注入默认 session，保证隐藏窗口是登录态
    try { ctx.injectDyCookieToSession(saved.cookie); } catch (_) {}

    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    imWin = win;
    imReady = false;

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.on('did-finish-load', finish);
      win.webContents.once('did-fail-load', finish);
      win.loadURL('https://www.douyin.com/').catch(finish);
      setTimeout(finish, 12000); // 兜底，避免一直等
    });

    // 给 acrawler 一点初始化时间
    await sleep(1500);
    imReady = true;
    return win;
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') throw e;
    throw new Error('初始化私信窗口失败：' + (e && e.message));
  } finally {
    creating = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// 页面内请求助手：在已登录页面上下文里，用抖音自己的 sign 函数签名后 fetch
// ============================================================
function pageFetchFn(method, url, body) {
  return (async () => {
    try {
      const u = new URL(url);
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      let target = url;
      try {
        const ac = window.byted_acrawler || (window.acrawler);
        if (ac && typeof ac.sign === 'function') {
          let signed = null;
          try { signed = ac.sign(url, params); } catch (_) {}
          if (!signed) { try { signed = ac.sign({ url, params }); } catch (_) {} }
          if (typeof signed === 'string' && signed.indexOf('=') >= 0) {
            target = u.origin + u.pathname + '?' + signed;
          }
        }
      } catch (_) { /* 签名失败则带原参数请求，部分接口仍可走通 */ }

      const headers = {
        'User-Agent': navigator.userAgent,
        'Referer': 'https://www.douyin.com/',
        'Accept': 'application/json, text/plain, */*',
      };
      const opts = { method, headers };
      if (body) {
        headers['Content-Type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const resp = await fetch(target, opts);
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = { __raw: text }; }
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, json };
    } catch (e) {
      return { ok: false, status: 0, json: { error: String(e && e.message || e) } };
    }
  })();
}

async function pageRequest(method, url, body) {
  const win = await ensureImWindow();
  const code =
    '(' + pageFetchFn.toString() + ')(' +
    JSON.stringify(method) + ',' + JSON.stringify(url) + ',' + JSON.stringify(body || null) + ')';
  const res = await win.webContents.executeJavaScript(code);
  return res; // { ok, status, json }
}

// ============================================================
// 数据归一化（防御式：抖音返回结构可能随版本变化）
// ============================================================
function pick(val, keys) {
  if (!val || typeof val !== 'object') return '';
  for (const k of keys) { if (val[k] != null && val[k] !== '') return val[k]; }
  return '';
}
function firstUrl(obj) {
  // 抖音头像/封面常为 { url_list: [...] }
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj[0] || '';
  if (obj.url_list && obj.url_list.length) return obj.url_list[0];
  return obj.url || obj.uri || '';
}

function normalizeConversations(json) {
  const out = [];
  if (!json) return out;
  // 兼容 data 为数组，或 { data: { conversation_list / conversation_list_wrapper } }
  let list = json.data;
  if (list && !Array.isArray(list)) {
    list = list.conversation_list || list.conversation_list_wrapper || list.list || [];
  }
  if (!Array.isArray(list)) list = [];
  for (const c of list) {
    if (!c) continue;
    const user = c.user_info || c.peer_user || c.user || {};
    const last = c.last_message || c.latest_message || c.last_msg || {};
    out.push({
      id: String(c.conversation_id || c.conversation_id_str || c.cid || ''),
      name: pick(user, ['nickname', 'nick_name', 'name', 'display_name']) || '抖音用户',
      avatar: firstUrl(user.avatar_thumb || user.avatar || user.avatar_medium),
      last: pick(last, ['content', 'text', 'display_content']) || '',
      time: Number(c.last_message_create_time || last.create_time || c.create_time || 0),
      unread: Number(c.unread_count || c.unread || 0),
      type: Number(c.conversation_type || c.type || 1),
    });
  }
  return out;
}

function normalizeMessages(json, myUid) {
  const out = [];
  if (!json) return out;
  let wrap = json.data;
  let list = [];
  if (Array.isArray(wrap)) list = wrap;
  else if (wrap) list = wrap.message_list || wrap.messages || wrap.list || [];
  if (!Array.isArray(list)) list = [];
  // 倒序：接口常返回由旧到新，界面按时间升序展示
  list = list.slice().reverse();
  for (const m of list) {
    if (!m) continue;
    const content = pick(m, ['content', 'text', 'display_content']) || '';
    const sender = m.sender || m.user || m.from_user || {};
    const senderId = String(sender.user_id || sender.uid || sender.sec_uid || '');
    // myUid 为空时，用 sender_type / is_self 字段判断
    let mine = false;
    if (myUid) mine = senderId === String(myUid);
    else mine = !!(m.is_self || (sender.sender_type === 0) || (m.sender_type === 0));
    out.push({
      id: String(m.message_id || m.msg_id || m.id || Math.random().toString(36).slice(2)),
      content,
      time: Number(m.create_time || m.client_time || 0),
      mine,
      senderName: pick(sender, ['nickname', 'nick_name', 'name']) || '',
    });
  }
  return out;
}

// ============================================================
// 对外接口
// ============================================================
async function getConversations(cursor = 0) {
  try {
    const url = ENDPOINT.conversations(cursor);
    const res = await pageRequest('GET', url, null);
    if (res.status === 0) return { ok: false, error: '请求未发出：' + JSON.stringify(res.json) };
    const list = normalizeConversations(res.json);
    return { ok: true, data: list, raw: res.json };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

async function getMessages(conversationId, cursor = 0, myUid = '') {
  try {
    if (!conversationId) return { ok: false, error: '缺少会话 ID' };
    const url = ENDPOINT.messages(conversationId, cursor);
    const res = await pageRequest('GET', url, null);
    if (res.status === 0) return { ok: false, error: '请求未发出：' + JSON.stringify(res.json) };
    const list = normalizeMessages(res.json, myUid);
    return { ok: true, data: list, raw: res.json };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

async function sendMessage(conversationId, text) {
  try {
    if (!conversationId || !text) return { ok: false, error: '缺少会话或内容' };
    const url = ENDPOINT.send();
    const body = {
      conversation_id: String(conversationId),
      content: String(text),
      // 以下为常见可选字段，抖音若不需要会忽略
      scene: 'chat',
      aid: '6383',
      device_platform: 'webapp',
      msg_type: 1,
    };
    const res = await pageRequest('POST', url, body);
    if (res.status === 0) return { ok: false, error: '发送请求未发出：' + JSON.stringify(res.json) };
    const j = res.json || {};
    if (j.status_code && j.status_code !== 0) {
      return { ok: false, error: '抖音返回错误：' + (j.status_msg || ('code ' + j.status_code)) };
    }
    return { ok: true, data: j.data || j };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

async function status() {
  return { ok: true, isLogin: isLoggedIn() };
}

module.exports = {
  init,
  getConversations,
  getMessages,
  sendMessage,
  status,
};
