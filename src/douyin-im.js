'use strict';

/**
 * douyin-im.js — 抖音网页版私信（CDP 拦截方案）
 *
 * 背景（2026-09 排查结论）：
 * - 旧方案在页面上下文调用 byted_acrawler.sign 手动签名后 fetch：
 *   实测 window.byted_acrawler.sign 已不存在（抖音前端改版）；
 * - 旧接口 /aweme/v1/web/im/conversation/list/ 已废弃（404 "Unsupported path(Janus)"），
 *   且 GET/POST 均不可用；错误响应还被静默吞掉，表现为"登录成功但消息永远为空"。
 * - 新方案：复用「已登录的隐藏 BrowserWindow」加载真实消息页（/follow/message），
 *   页面自身会发出带正确签名的 IM 请求，用 CDP Network 域拦截响应：
 *   - 会话列表：拦截任意 conversation/list 类响应
 *   - 消息列表：先在页面里点开对应会话，再拦截对应 message/list 响应
 *   - 发送消息：DOM 自动化操作页面自身的输入框（最贴近真实用户行为）
 * 所有失败路径都会给出明确的错误信息，不再静默返回空列表。
 */

const { BrowserWindow } = require('electron');

const IM_PAGE = 'https://www.douyin.com/follow/message';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 主进程注入的认证上下文（在 init 时由 main.js 提供）
let ctx = null;
let imWin = null;
let creating = false;

// CDP 拦截到的数据快照
let convSnapshot = null; // 最近一次会话列表响应 { json, at }
const msgSnapshots = new Map(); // conversation_id -> { json, at }

function init(context) {
  ctx = context; // { loadDyAuth, isDyLoggedIn, injectDyCookieToSession, getDouyinCookieHeader }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 按 URL 形态归类 IM 响应
function classifyUrl(url) {
  if (!/im/i.test(url)) return null;
  if (/conversation[/_-]?list|dialog[/_-]?list/i.test(url)) return 'conversations';
  if (/message[/_-]?list|msg[/_-]?list/i.test(url)) return 'messages';
  return null;
}

function extractConvId(url) {
  const m = /[?&]conversation[_-]?id=([^&]+)/i.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

function attachDebugger(win) {
  const dbg = win.webContents.debugger;
  try { dbg.attach('1.3'); dbg.sendCommand('Network.enable'); } catch (_) {}
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const url = (params.response && params.response.url) || '';
    const kind = classifyUrl(url);
    if (!kind) return;
    const st = (params.response && params.response.status) || 0;
    if (st < 200 || st >= 300) return;
    try {
      const { body } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const json = JSON.parse(body);
      if (kind === 'conversations') {
        convSnapshot = { json, at: Date.now() };
      } else {
        const cid = extractConvId(url);
        if (cid) msgSnapshots.set(cid, { json, at: Date.now() });
      }
    } catch (_) { /* 响应体可能已被释放，忽略 */ }
  });
}

// 确保隐藏窗口已创建并处于已登录状态
async function ensureImWindow() {
  if (imWin && !imWin.isDestroyed()) return imWin;
  if (creating) {
    for (let i = 0; i < 40; i++) {
      if (imWin && !imWin.isDestroyed()) return imWin;
      await sleep(300);
    }
    if (imWin && !imWin.isDestroyed()) return imWin;
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

    convSnapshot = null;
    msgSnapshots.clear();

    const win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 850,
      webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });
    win.webContents.setUserAgent(UA);
    imWin = win;
    attachDebugger(win);

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.on('did-finish-load', finish);
      win.webContents.once('did-fail-load', finish);
      win.loadURL(IM_PAGE).catch(finish);
      setTimeout(finish, 15000); // 兜底，避免一直等
    });
    await sleep(1200);

    // 登录墙检测：未登录时页面显示扫码/验证码登录提示
    try {
      const txt = await win.webContents.executeJavaScript(
        `(document.body ? document.body.innerText : '').slice(0, 500)`
      );
      if (/扫码登录|验证码登录|密码登录/.test(txt) && !/发送|输入/.test(txt)) {
        try { win.destroy(); } catch (_) {}
        imWin = null;
        throw new Error('NEED_LOGIN');
      }
    } catch (e) {
      if (e && e.message === 'NEED_LOGIN') throw e;
      /* DOM 检查失败不拦截，交给后续数据等待超时兜底 */
    }
    return win;
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') throw e;
    throw new Error('初始化私信窗口失败：' + (e && e.message));
  } finally {
    creating = false;
  }
}

// 从抖音响应中提取统一错误（不再静默吞掉）
function pickApiError(json) {
  if (!json || typeof json !== 'object') return '';
  const sc = Number(json.status_code);
  if (!Number.isNaN(sc) && sc !== 0) {
    return '抖音返回错误：' + (json.status_msg || json.statusMsg || ('code ' + sc));
  }
  return '';
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
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj[0] || '';
  if (obj.url_list && obj.url_list.length) return obj.url_list[0];
  return obj.url || obj.uri || '';
}

function normalizeConversations(json) {
  const out = [];
  if (!json) return out;
  let list = json.data;
  if (list && !Array.isArray(list)) {
    list = list.conversation_list || list.conversation_list_wrapper || list.list || [];
    if (list && !Array.isArray(list) && list.conversation_list) list = list.conversation_list;
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
  list = list.slice().reverse();
  for (const m of list) {
    if (!m) continue;
    const content = pick(m, ['content', 'text', 'display_content']) || '';
    const sender = m.sender || m.user || m.from_user || {};
    const senderId = String(sender.user_id || sender.uid || sender.sec_uid || '');
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
    const win = await ensureImWindow();
    // 页面加载后会自动发出会话列表请求，等它出现
    const deadline = Date.now() + 15000;
    while (!convSnapshot && Date.now() < deadline) {
      if (!win || win.isDestroyed()) throw new Error('NEED_LOGIN');
      await sleep(400);
    }
    if (!convSnapshot) {
      return { ok: false, error: '未捕获到抖音会话数据（页面未发出会话请求，抖音可能又改版了）' };
    }
    const apiErr = pickApiError(convSnapshot.json);
    if (apiErr) return { ok: false, error: apiErr };
    const list = normalizeConversations(convSnapshot.json);
    return { ok: true, data: list };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

// 在页面会话列表里点开指定会话（防御式：多选择器 + id 后缀匹配）
async function clickConversation(win, conversationId) {
  try {
    return await win.webContents.executeJavaScript(`(() => {
      const want = ${JSON.stringify(String(conversationId))};
      const suffix = want.slice(-12);
      const nodes = document.querySelectorAll(
        '[data-conversation-id], [data-id], [class*="conversation"], [class*="chatItem"], [class*="conv-item"], [data-e2e*="conversation"], li[role], a[href*="conversation"]'
      );
      for (const n of nodes) {
        const ds = n.dataset || {};
        const attr = ds.conversationId || ds['conversation-id'] || ds.id || '';
        if (attr && attr.indexOf(suffix) >= 0) { n.click(); return 'attr'; }
      }
      return '';
    })()`);
  } catch (_) { return ''; }
}

async function getMessages(conversationId, cursor = 0, myUid = '') {
  try {
    if (!conversationId) return { ok: false, error: '缺少会话 ID' };
    const win = await ensureImWindow();
    let snap = msgSnapshots.get(conversationId);
    if (!snap) {
      const clicked = await clickConversation(win, conversationId);
      if (!clicked) {
        return { ok: false, error: '未能在消息页定位该会话（抖音页面结构变更，暂无法读取消息详情）' };
      }
      const deadline = Date.now() + 10000;
      while (!msgSnapshots.get(conversationId) && Date.now() < deadline) {
        if (!win || win.isDestroyed()) throw new Error('NEED_LOGIN');
        await sleep(400);
      }
      snap = msgSnapshots.get(conversationId);
    }
    if (!snap) return { ok: false, error: '未捕获到该会话的消息数据' };
    const apiErr = pickApiError(snap.json);
    if (apiErr) return { ok: false, error: apiErr };
    const list = normalizeMessages(snap.json, myUid);
    return { ok: true, data: list };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

async function sendMessage(conversationId, text) {
  try {
    if (!conversationId || !text) return { ok: false, error: '缺少会话或内容' };
    const win = await ensureImWindow();
    // 先确保目标会话已打开
    if (!msgSnapshots.get(conversationId)) {
      await clickConversation(win, conversationId);
      await sleep(1200);
    }
    const r = await win.webContents.executeJavaScript(`(async () => {
      const text = ${JSON.stringify(String(text))};
      const input = document.querySelector(
        'textarea[placeholder], [contenteditable="true"], [class*="input"] [contenteditable="true"], [data-e2e*="input"]'
      );
      if (!input) return { ok: false, error: '未找到聊天输入框（抖音页面结构变更）' };
      input.focus();
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
        input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
      await new Promise((r2) => setTimeout(r2, 250));
      const btn = Array.from(document.querySelectorAll('button'))
        .find((b) => /发送|^send$/i.test((b.textContent || '').trim()) || /send/i.test(b.className || ''));
      if (btn) { btn.click(); return { ok: true, via: 'btn' }; }
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true });
      input.dispatchEvent(ev);
      return { ok: true, via: 'enter' };
    })()`);
    if (r && r.ok) return { ok: true, data: { via: r.via } };
    return { ok: false, error: (r && r.error) || '发送失败' };
  } catch (e) {
    if (e && e.message === 'NEED_LOGIN') return { ok: false, needLogin: true, error: '请先登录抖音' };
    return { ok: false, error: e.message };
  }
}

async function status() {
  if (!ctx) return { ok: true, isLogin: false };
  let ok = false;
  try {
    const saved = ctx.loadDyAuth();
    if (saved && saved.cookie && ctx.isDyLoggedIn(ctx.getDouyinCookieHeader().map)) ok = true;
  } catch (_) {}
  return { ok: true, isLogin: ok };
}

module.exports = {
  init,
  getConversations,
  getMessages,
  sendMessage,
  status,
};
