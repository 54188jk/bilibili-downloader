/**
 * Electron 主进程
 *  负责：创建窗口、注册 IPC、处理文件保存对话框、调用 B 站 API、执行 ffmpeg
 */
const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { URL } = require('url');

const bili = require('./bilibili');
const douyin = require('./douyin');
const douyinIm = require('./douyin-im');
const kuaishou = require('./kuaishou');
const uc = require('./uc');
const musicApi = require('./music');
const movieApi = require('./movie-api');
const capture = require('./capture/capture');

// 初始化抖音私信模块：复用主进程已有的抖音登录态与 cookie 注入能力
douyinIm.init({
  loadDyAuth,
  isDyLoggedIn,
  injectDyCookieToSession,
  getDouyinCookieHeader,
});

let mainWindow = null;
let loginWindow = null;
let loginPollTimer = null;
let dyLoginWindow = null;
let dyLoginPollTimer = null;

// B 站登录 Cookie 持久化文件（位于 userData 目录）
const AUTH_FILE = path.join(app.getPath('userData'), 'bili_auth.json');
// 抖音登录 Cookie 持久化文件（位于 userData 目录）
const DY_AUTH_FILE = path.join(app.getPath('userData'), 'douyin_auth.json');
// UC 登录 Cookie 持久化文件（位于 userData 目录）
const UC_AUTH_FILE = path.join(app.getPath('userData'), 'uc_auth.json');
// 免责声明确认标记（首次启动弹窗）
const DISCLAIMER_FILE = path.join(app.getPath('userData'), 'disclaimer_accepted.json');
// 桌面歌词窗口状态（保存上次位置）
const LYRICS_POS_FILE = path.join(app.getPath('userData'), 'lyrics_window.json');
// 下载历史记录持久化文件
const HISTORY_FILE = path.join(app.getPath('userData'), 'download_history.json');

// ===== 下载历史（持久化到 HISTORY_FILE）=====
function loadDownloadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { return []; }
}
function saveDownloadHistory(list) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list), 'utf8'); } catch (_) {}
}
function addDownloadHistory(entry) {
  const list = loadDownloadHistory();
  list.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: entry.title || entry.filename || '未知文件',
    filename: entry.filename || '',
    dir: entry.dir || '',
    size: entry.size || 0,
    kind: entry.kind || 'video',
    time: Date.now(),
  });
  // 最多保留 500 条
  if (list.length > 500) list.length = 500;
  saveDownloadHistory(list);
  return list;
}


// B站视频直链播放防盗链：为 B站媒体域名请求注入 Referer 与登录 Cookie，
// 否则 <video> 直接加载会 403 无法播放（注册在 app.whenReady 中）
function biliCookieHeader() {
  try {
    const saved = loadAuth();
    return (saved && saved.cookie) || '';
  } catch (_) { return ''; }
}

// 初始化 session：使用真实 Chrome UA，让登录页与视频播放更稳定
function setupSessionUA() {
  session.defaultSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
}

// ============================================
//  启动动画 Splash（主窗口就绪后自动淡出）
// ============================================
let splashWindow = null;

// 读取应用图标并转成 data URL，交给启动页显示真实图标
function getSplashIconDataUrl() {
  try {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'icon.png')]
      : [path.join(app.getAppPath(), 'build', 'icon.png'), path.join(app.getAppPath(), 'build', 'icon.ico')];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        const ext = c.toLowerCase().endsWith('.ico') ? 'x-icon' : 'png';
        return 'data:image/' + ext + ';base64,' + fs.readFileSync(c).toString('base64');
      }
    }
  } catch (_) {}
  return '';
}

function createSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;

  const splashFile = path.join(__dirname, 'renderer', 'splash.html');

  // transparent=true 时窗口透出桌面，玻璃质感最真实；
  // 个别环境（禁用 GPU 合成等）透明窗口会加载失败，自动降级为不透明版本。
  const build = (transparent) => {
    const w = new BrowserWindow({
      width: 460,
      height: 340,
      frame: false,
      resizable: false,
      movable: true,
      transparent,
      backgroundColor: transparent ? '#00000000' : '#0c0e14',
      alwaysOnTop: true,
      center: true,
      skipTaskbar: true,
      show: false,
      hasShadow: !transparent,
      webPreferences: {
        preload: path.join(__dirname, 'splash-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    w.loadFile(splashFile).catch(() => {
      if (!transparent) return;
      try { w.destroy(); } catch (_) {}
      try { splashWindow = build(false); } catch (_) { splashWindow = null; }
    });

    // 兜底：个别环境不触发 ready-to-show，1.2s 后强制显示
    w.once('ready-to-show', () => { try { w.show(); } catch (_) {} });
    setTimeout(() => {
      try { if (!w.isDestroyed() && !w.isVisible()) w.show(); } catch (_) {}
    }, 1200);

    // 页面加载完成后推送版本号与真实图标
    w.webContents.once('did-finish-load', () => {
      try {
        w.webContents.send('splash:init', { version: app.getVersion(), name: 'BiliGrab' });
        const icon = getSplashIconDataUrl();
        if (icon) w.webContents.send('splash:icon', icon);
      } catch (_) {}
    });
    return w;
  };

  try {
    splashWindow = build(true);
  } catch (e) {
    console.error('[splash] 透明窗口创建失败，降级不透明:', e.message);
    try { splashWindow = build(false); } catch (_) { splashWindow = null; }
  }
  return splashWindow;
}

// 推进启动进度（无 splash 时为空操作）
function splashStep(pct, text) {
  try {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash:progress', { pct, text });
    }
  } catch (_) {}
}

// 收尾：进度拉满 -> 播放离场动画 -> 销毁 -> 回调（显示主窗口）
function finishSplash(cb) {
  const done = () => {
    try { if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy(); } catch (_) {}
    splashWindow = null;
    if (typeof cb === 'function') cb();
  };
  if (!splashWindow || splashWindow.isDestroyed()) {
    if (typeof cb === 'function') cb();
    return;
  }
  try {
    splashWindow.webContents.send('splash:progress', { pct: 100, text: '准备就绪' });
    splashWindow.webContents.send('splash:done');
  } catch (_) {}
  setTimeout(done, 620); // 与 CSS 离场动画时长（460ms）留出余量
}

function createWindow() {
  // 解析软件图标（运行时用于窗口/任务栏左上角图标）
  function getAppIcon() {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'icon.png')]
      : [path.join(app.getAppPath(), 'build', 'icon.ico'), path.join(app.getAppPath(), 'build', 'icon.png')];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return undefined;
  }

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    show: false, // 先隐藏，等启动动画淡出后再显示，避免白窗闪烁
    icon: getAppIcon(),
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // 内置B站：允许 <webview> 内嵌真实网页用于在线播放
      webSecurity: false, // 允许 file:// 嵌入 http://127.0.0.1 播放器 iframe
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  // 首帧就绪后播放启动动画离场，随后显示主窗口（避免白窗闪烁）
  let mainShown = false;
  const showMain = () => {
    if (mainShown) return;
    mainShown = true;
    finishSplash(() => {
      try { mainWindow.show(); mainWindow.focus(); } catch (_) {}
    });
  };
  mainWindow.once('ready-to-show', showMain);
  setTimeout(showMain, 3000); // 兜底：极端情况（渲染卡住）也必须显示主窗口
  mainWindow.on('close', (e) => {
    // 托盘驻留：关闭主窗口时隐藏而非销毁，托盘菜单"退出"会强制 app.quit()
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    } else {
      // 真正退出时同步关闭桌面歌词窗口
      closeLyricsWindow();
    }
  });

  // 内置B站 / 内置抖音 <webview>：拦截弹窗，让 target=_blank 在同一个 webview 内打开，
  // 避免点击视频/链接时弹出独立窗口
  mainWindow.webContents.on('did-attach-webview', (_e, webContents) => {
    try {
      webContents.setWindowOpenHandler(({ url }) => {
        // 新窗口统一接管：直接让 webview 导航到目标 URL，不弹新窗
        if (url && /^https?:/i.test(url)) {
          setTimeout(() => { try { webContents.loadURL(url); } catch (_) {} }, 0);
        }
        return { action: 'deny' };
      });
    } catch (_) {}
  });
}

// ===== 窗口控制 IPC =====
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:close', () => mainWindow.close());
ipcMain.handle('window:toggleMax', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:fullscreen', (_e, flag) => {
  if (!mainWindow) return;
  if (flag) mainWindow.setFullScreen(true);
  else mainWindow.setFullScreen(false);
});

// ============================================
// 桌面歌词窗口（透明、置顶、点击穿透，可拖动）
// ============================================
let lyricsWin = null;

function loadLyricsPos() {
  try { return JSON.parse(fs.readFileSync(LYRICS_POS_FILE, 'utf8')); } catch (_) { return null; }
}

function saveLyricsPos(x, y) {
  try { fs.writeFileSync(LYRICS_POS_FILE, JSON.stringify({ x, y })); } catch (_) {}
}

function createLyricsWindow() {
  if (lyricsWin && !lyricsWin.isDestroyed()) { lyricsWin.show(); return lyricsWin; }
  const W = 1000;
  const H = 252;
  const { workArea } = screen.getPrimaryDisplay();
  const saved = loadLyricsPos();
  const x = saved && typeof saved.x === 'number' ? saved.x : Math.round(workArea.x + (workArea.width - W) / 2);
  const y = saved && typeof saved.y === 'number' ? saved.y : Math.round(workArea.y + workArea.height - H - 50);

  lyricsWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-lyrics.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  lyricsWin.setAlwaysOnTop(true, 'screen-saver');
  lyricsWin.setMenuBarVisibility(false);
  // 初始可交互，锁定后由渲染进程调用 setIgnoreMouseEvents(true) 启用穿透
  lyricsWin.setIgnoreMouseEvents(false);
  lyricsWin.loadFile(path.join(__dirname, 'renderer', 'desktop-lyrics.html'));

  // 拖动后记住位置
  let moveSaveTimer = null;
  const onMoved = () => {
    if (!lyricsWin || lyricsWin.isDestroyed()) return;
    const [px, py] = lyricsWin.getPosition();
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => saveLyricsPos(px, py), 300);
  };
  lyricsWin.on('move', onMoved);
  lyricsWin.on('moved', onMoved);

  lyricsWin.on('closed', () => {
    lyricsWin = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop-lyrics:closed');
    }
  });

  return lyricsWin;
}

function closeLyricsWindow() {
  if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.close();
}

function isLyricsOpen() {
  return !!(lyricsWin && !lyricsWin.isDestroyed());
}

ipcMain.handle('lyrics:open', () => { createLyricsWindow(); return { ok: true, open: isLyricsOpen() }; });
ipcMain.handle('lyrics:close', () => { closeLyricsWindow(); return { ok: true, open: isLyricsOpen() }; });
ipcMain.handle('lyrics:toggle', () => {
  if (isLyricsOpen()) closeLyricsWindow();
  else createLyricsWindow();
  return { ok: true, open: isLyricsOpen() };
});
ipcMain.handle('lyrics:isOpen', () => ({ ok: true, open: isLyricsOpen() }));
ipcMain.on('lyrics:close', () => closeLyricsWindow());

// 把命令转发给桌面歌词窗口（右键菜单点击等）
function sendLyricsCmd(cmd) {
  if (isLyricsOpen()) lyricsWin.webContents.send('desktop-lyrics:cmd', cmd);
}

// 桌面歌词右键菜单（原生）
ipcMain.on('lyrics:menu', (_evt, state) => {
  if (!isLyricsOpen()) return;
  const s = state || {};
  const locked = !!s.locked;
  const fontSize = s.fontSize || 30;
  const bg = s.bg || 'transparent';
  const mode = s.mode || 'triple';
  const theme = s.theme || 'teal';
  const opacity = String(s.opacity !== undefined ? s.opacity : 1);
  const label = (icon, text) => `${icon}  ${text}`;

  const themeOptions = [
    { key: 'teal', label: '青碧' },
    { key: 'pink', label: '樱粉' },
    { key: 'gold', label: '暖金' },
    { key: 'blue', label: '湖蓝' },
    { key: 'green', label: '黛绿' },
    { key: 'white', label: '月白' },
  ];

  const menu = Menu.buildFromTemplate([
    { label: label(locked ? '🔓' : '🔒', locked ? '解锁（可拖动）' : '锁定（点击穿透）'), click: () => sendLyricsCmd({ type: 'lock' }) },
    { type: 'separator' },
    { label: label('A−', '字号减小'), click: () => sendLyricsCmd({ type: 'font', value: -1 }) },
    { label: label('A+', '字号增大'), click: () => sendLyricsCmd({ type: 'font', value: 1 }) },
    { type: 'separator' },
    { label: '背景样式', submenu: [
      { label: '完全透明', type: 'radio', checked: bg === 'transparent', click: () => sendLyricsCmd({ type: 'bg', value: 'transparent' }) },
      { label: '毛玻璃卡片', type: 'radio', checked: bg === 'glass', click: () => sendLyricsCmd({ type: 'bg', value: 'glass' }) },
    ]},
    { label: '显示模式', submenu: [
      { label: '单行（仅当前句）', type: 'radio', checked: mode === 'single', click: () => sendLyricsCmd({ type: 'mode', value: 'single' }) },
      { label: '双行（当前 + 下一句）', type: 'radio', checked: mode === 'double', click: () => sendLyricsCmd({ type: 'mode', value: 'double' }) },
      { label: '三行（上 / 当前 / 下）', type: 'radio', checked: mode === 'triple', click: () => sendLyricsCmd({ type: 'mode', value: 'triple' }) },
    ]},
    { label: '主题色', submenu: themeOptions.map(t => ({
      label: t.label, type: 'radio', checked: theme === t.key, click: () => sendLyricsCmd({ type: 'theme', value: t.key }),
    }))},
    { label: '不透明度', submenu: [1, 0.85, 0.7].map(v => ({
      label: `${Math.round(v * 100)}%`, type: 'radio', checked: opacity === String(v), click: () => sendLyricsCmd({ type: 'opacity', value: String(v) }),
    }))},
    { type: 'separator' },
    { label: '回到屏幕底部中央', click: () => sendLyricsCmd({ type: 'resetPos' }) },
    { type: 'separator' },
    { label: label('×', '关闭桌面歌词'), click: () => sendLyricsCmd({ type: 'close' }) },
  ]);
  menu.popup({ window: lyricsWin });
});

// 桌面歌词窗口请求：回到屏幕底部中央
ipcMain.on('lyrics:resetPos', () => {
  if (!isLyricsOpen()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const [cw] = lyricsWin.getSize();
  lyricsWin.setPosition(
    Math.round(workArea.x + (workArea.width - cw) / 2),
    Math.round(workArea.y + workArea.height - 252 - 50)
  );
});

// 桌面歌词窗口请求：设置鼠标事件穿透（锁定时点击穿透）
ipcMain.on('lyrics:setIgnoreMouseEvents', (_evt, ignore) => {
  if (!isLyricsOpen()) return;
  try {
    lyricsWin.setIgnoreMouseEvents(!!ignore, { forward: true });
  } catch (_) {}
});

// 桌面歌词音乐控制 → 转发给主窗口渲染进程
ipcMain.on('lyrics:musicControl', (_evt, action) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('desktop-lyrics:musicCmd', action);
  }
});

// 主窗口渲染进程 → 桌面歌词窗口：整首歌歌词
ipcMain.on('desktop-lyrics:load', (_evt, payload) => {
  if (isLyricsOpen()) lyricsWin.webContents.send('desktop-lyrics:data', payload);
});

// 主窗口渲染进程 → 桌面歌词窗口：当前播放进度
ipcMain.on('desktop-lyrics:tick', (_evt, payload) => {
  if (isLyricsOpen()) lyricsWin.webContents.send('desktop-lyrics:tick', payload);
});

// =====  应用版本号 =====
ipcMain.handle('app:version', () => app.getVersion());

/* ============================================================
 * 智能助手对话后端
 * 安全原则：内置模型的 API 密钥 / 地址 / 模型名 只存在于主进程
 * （本文件内存 + 密钥文件 ai-secrets.json / 环境变量），
 * 渲染层只发送对话内容，通过事件 ai:chunk / ai:done 接收回复，
 * 开发者工具里既看不到密钥，也抓不到带密钥的请求。
 * 自定义模型：用户自己的密钥，仅存于 userData/ai_models.json（主进程可见）。
 * ============================================================ */
const AI_MODEL_FILE = path.join(app.getPath('userData'), 'ai_models.json');

function loadCustomAiModels() {
  try { return JSON.parse(fs.readFileSync(AI_MODEL_FILE, 'utf8')); } catch (_) { return []; }
}
function saveCustomAiModels(list) {
  try { fs.writeFileSync(AI_MODEL_FILE, JSON.stringify(list, null, 2), 'utf8'); } catch (_) {}
}
// 内置模型凭据：环境变量优先，其次 __dirname/ai-secrets.json（构建期注入，不进 asar 的渲染层）
function getBuiltinAiSecrets() {
  if (process.env.BILIGRAB_AI_BASE_URL && process.env.BILIGRAB_AI_API_KEY && process.env.BILIGRAB_AI_MODEL) {
    return {
      baseUrl: process.env.BILIGRAB_AI_BASE_URL,
      apiKey: process.env.BILIGRAB_AI_API_KEY,
      model: process.env.BILIGRAB_AI_MODEL,
    };
  }
  try {
    const p = path.join(__dirname, 'ai-secrets.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.baseUrl && j.apiKey && j.model) return j;
  } catch (_) {}
  return null;
}

async function streamAiChat(event, modelId, messages, reqId) {
  let cfg = null;
  if (modelId === 'builtin' || modelId === 'auto') {
    cfg = getBuiltinAiSecrets();
    if (!cfg) {
      event.sender.send('ai:done', { reqId, ok: false, error: '内置模型未配置（开发者尚未填写密钥）' });
      return;
    }
  } else {
    cfg = loadCustomAiModels().find((m) => m.id === modelId);
    if (!cfg) {
      event.sender.send('ai:done', { reqId, ok: false, error: '未找到该自定义模型，请先在「模型管理」中添加' });
      return;
    }
  }
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.7 }),
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 240); } catch (_) {}
      event.sender.send('ai:done', { reqId, ok: false, error: 'HTTP ' + resp.status + (detail ? ' · ' + detail : '') });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) event.sender.send('ai:chunk', { reqId, delta });
        } catch (_) { /* 跳过非 JSON 行（如注释） */ }
      }
    }
    event.sender.send('ai:done', { reqId, ok: true });
  } catch (e) {
    event.sender.send('ai:done', { reqId, ok: false, error: String((e && e.message) || e) });
  }
}

ipcMain.on('ai:chat', (event, payload) => {
  const { modelId, messages, reqId } = payload || {};
  streamAiChat(event, modelId || 'builtin', Array.isArray(messages) ? messages : [], reqId)
    .catch((e) => { try { event.sender.send('ai:done', { reqId, ok: false, error: String(e && e.message || e) }); } catch (_) {} });
});

// 自定义模型：返回给渲染层的列表不含 apiKey
function publicModelList(list) { return list.map((m) => ({ id: m.id, name: m.name, base: m.base, model: m.model })); }

ipcMain.handle('ai:modelsGet', async () => publicModelList(loadCustomAiModels()));

ipcMain.handle('ai:modelSave', async (_e, model) => {
  if (!model || !model.name || !model.base || !model.apiKey || !model.model) {
    return { ok: false, error: '请填写完整的名称 / 地址 / 密钥 / 模型 ID' };
  }
  const list = loadCustomAiModels();
  const id = 'cm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  list.push({ id, name: model.name, base: model.base, apiKey: model.apiKey, model: model.model });
  saveCustomAiModels(list);
  return { ok: true, list: publicModelList(list) };
});

ipcMain.handle('ai:modelDelete', async (_e, id) => {
  const list = loadCustomAiModels().filter((m) => m.id !== id);
  saveCustomAiModels(list);
  return { ok: true, list: publicModelList(list) };
});


// ===== 打开外部链接（如 B 站官网） =====
ipcMain.handle('shell:openExternal', (_evt, url) => {
  try {
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'URL 不合法：仅支持 http(s)://' };
    }
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 在文件管理器中打开路径 =====
ipcMain.handle('shell:openPath', async (_evt, p) => {
  return shell.openPath(p);
});

// ===== 获取教程页面路径（从 asar 提取到 userData 以便系统浏览器/文件管理器打开） =====
ipcMain.handle('app:tutorialPath', () => {
  try {
    const srcPath = path.join(__dirname, 'src', 'renderer', 'tutorial.html');
    const destDir = path.join(app.getPath('userData'), 'tutorial');
    const destPath = path.join(destDir, 'tutorial.html');
    if (!fs.existsSync(destPath)) {
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
    return destPath;
  } catch (_) {
    return path.join(__dirname, 'src', 'renderer', 'tutorial.html');
  }
});

// ===== 应用内教程窗口（直接加载打包资源里的 tutorial.html，永不失效） =====
let tutorialWin = null;
ipcMain.handle('app:openTutorial', () => {
  try {
    if (tutorialWin && !tutorialWin.isDestroyed()) {
      tutorialWin.show();
      tutorialWin.focus();
      return { ok: true };
    }
    tutorialWin = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 640,
      minHeight: 480,
      title: 'BiliGrab 使用教程',
      backgroundColor: '#0f1220',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    tutorialWin.loadFile(path.join(__dirname, 'src', 'renderer', 'tutorial.html'));
    tutorialWin.on('closed', () => { tutorialWin = null; });
    tutorialWin.show();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 在文件管理器中定位并选中文件 =====
ipcMain.handle('shell:showInFolder', (_evt, p) => {
  try {
    shell.showItemInFolder(p);
  } catch (_) {
    try { shell.openPath(path.dirname(p)); } catch (__) {}
  }
});

// ===== 解析视频信息 =====
ipcMain.handle('video:parse', async (_evt, input) => {
  try {
    const text = String(input || '').trim();
    if (!text) return { ok: false, error: '输入为空' };
    const bvMatch = text.match(/BV[1-9A-HJ-NP-Za-km-z]{10}/i);
    if (!bvMatch) return { ok: false, error: '未找到 BV 号' };
    const bvid = bvMatch[0];
    const info = await bili.parseVideo(bvid);
    return { ok: true, data: info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 批量解析输入（多行，B站 + 抖音 + 快手混合） =====
// 并发池：限制同时进行的任务数，显著加快批量解析
async function runConcurrent(items, worker, limit = 4) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const cur = idx++;
      try { results[cur] = await worker(items[cur], cur); } catch (e) { results[cur] = { ok: false, error: e.message }; }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
  await Promise.all(runners);
  return results;
}

ipcMain.handle('video:parseInput', async (_evt, text) => {
  try {
    const biliLinks = bili.extractLinks(text);
    const douyinLinks = douyin.extractLinks(text);
    const kuaishouLinks = kuaishou.extractLinks(text);
    if (!biliLinks.length && !douyinLinks.length && !kuaishouLinks.length) {
      return { ok: false, error: '未识别到任何链接（支持 B站 BV号/图片动态、抖音、快手分享链接）' };
    }

    const results = [];

    // 解析 B站 链接
    for (const link of biliLinks) {
      try {
        if (link.kind === 'video') {
          const info = await bili.parseVideo(link.id);
          results.push({
            ok: true,
            kind: 'video',
            id: info.bvid,
            bvid: info.bvid,
            cid: info.cid,
            title: info.title,
            pic: info.pic,
            durationStr: info.durationStr,
            owner: info.owner && info.owner.name,
            duration: info.duration,
          });
        } else if (link.kind === 'image') {
          const op = await bili.parseImage(link.id);
          results.push({
            ok: true,
            kind: 'image',
            id: link.id,
            title: op.title,
            images: op.images,
            count: op.count,
          });
        }
      } catch (e) {
        results.push({ ok: false, id: link.id, kind: link.kind, error: e.message });
      }
    }

    // 解析抖音链接
    for (const url of douyinLinks) {
      try {
        const r = await resolveDouyinShare(url);
        if (r.ok) {
          results.push({
            ok: true,
            kind: 'douyin',
            id: r.data.awemeId,
            douyinId: r.data.awemeId,
            title: r.data.title,
            cover: r.data.cover,
            videoUrl: r.data.videoUrl,
            author: r.data.author,
            source: r.source || 'local',
            url,
          });
        } else {
          results.push({ ok: false, kind: 'douyin', id: url, error: r.error });
        }
      } catch (e) {
        results.push({ ok: false, kind: 'douyin', id: url, error: e.message });
      }
    }

    // 解析快手链接（并发 4 路，显著提速；按原顺序返回）
    const ksResults = await runConcurrent(kuaishouLinks, async (url) => {
      try {
        let photoId = kuaishou.getPhotoId(url);
        if (!photoId) {
          try { photoId = await kuaishou.resolvePhotoId(url); } catch (_) {}
        }
        if (!photoId) {
          return { ok: false, kind: 'kuaishou', id: url, error: '无法识别作品 ID' };
        }
        const r = await grabKuaishouVideo(photoId);
        if (r.ok) {
          return {
            ok: true,
            kind: 'kuaishou',
            id: photoId,
            ksId: photoId,
            title: r.data.title,
            cover: r.data.cover,
            videoUrl: r.data.videoUrl,
            author: r.data.author,
            url,
          };
        }
        return { ok: false, kind: 'kuaishou', id: photoId, error: r.error };
      } catch (e) {
        return { ok: false, kind: 'kuaishou', id: url, error: e.message };
      }
    }, 4);
    for (const r of ksResults) results.push(r);

    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== B站 关键词搜索 =====
ipcMain.handle('video:search', async (_evt, payload) => {
  try {
    const keyword = (payload && payload.keyword) ? String(payload.keyword).trim() : '';
    if (!keyword) return { ok: false, error: '请输入搜索关键词' };
    const page = (payload && payload.page) || 1;
    const results = await bili.searchVideo(keyword, page);
    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 单独解析抖音分享链接 =====
ipcMain.handle('douyin:parse', async (_evt, text) => {
  try {
    const links = douyin.extractLinks(text);
    if (!links.length) return { ok: false, error: '未识别到抖音链接' };
    const results = [];
    for (const url of links) {
      try {
        const r = await resolveDouyinShare(url);
        if (r.ok) {
          results.push({
            ok: true,
            kind: 'douyin',
            id: r.data.awemeId,
            douyinId: r.data.awemeId,
            title: r.data.title,
            cover: r.data.cover,
            videoUrl: r.data.videoUrl,
            author: r.data.author,
            source: r.source || 'local',
            url,
          });
        } else {
          results.push({ ok: false, kind: 'douyin', id: url, error: r.error });
        }
      } catch (e) {
        results.push({ ok: false, kind: 'douyin', id: url, error: e.message });
      }
    }
    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 抖音关键词搜索（返回视频列表） =====
ipcMain.handle('douyin:search', async (_evt, payload) => {
  try {
    const keyword = (payload && payload.keyword) ? String(payload.keyword).trim() : '';
    if (!keyword) return { ok: false, error: '请输入搜索关键词' };
    const { header } = await getDouyinCookieHeader();
    const r = await douyin.searchVideoByKeyword(keyword, header);
    if (r.needLogin) {
      return { ok: false, error: '搜索受限：请先在抖音 Tab 登录后再搜索（或用视频链接解析）' };
    }
    const list = Array.isArray(r) ? r : (r.list || []);
    if (!list.length) return { ok: false, error: '未找到相关抖音视频' };
    return { ok: true, data: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 抖音解析单个 aweme_id =====
ipcMain.handle('douyin:parseAweme', async (_evt, awemeId) => {
  try {
    const r = await douyin.parseByAwemeId(String(awemeId));
    if (r.ok) {
      return {
        ok: true,
        data: {
          ok: true,
          kind: 'douyin',
          id: r.data.awemeId,
          douyinId: r.data.awemeId,
          title: r.data.title,
          cover: r.data.cover,
          videoUrl: r.data.videoUrl,
          author: r.data.author,
          source: r.source,
        },
      };
    }
    return { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
// 快手解析（隐藏窗口加载 PC 页异步渲染后抓取）
// ============================================
function grabKuaishouVideo(photoId) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 750,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { win.destroy(); } catch (_) {} resolve({ ok: false, error: '快手页面加载超时' }); }
    }, 20000);

    function finish(obj) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch (_) {}
      resolve(obj);
    }

    let poll = null;
    // dom-ready 后立即开始轮询，不必等所有资源加载完
    win.webContents.once('dom-ready', () => {
      let tries = 0;
      poll = setInterval(async () => {
        tries++;
        try {
          const r = await win.webContents.executeJavaScript(`
            (() => {
              // 快手 PC 渲染完成后 video 元素带播放地址
              const v = document.querySelector('video');
              const out = { url: '', cover: '', title: '', author: '', dead: false };
              if (v) out.url = (v.currentSrc || v.src || '').replace('http://', 'https://');
              if (!out.url) {
                const srcEl = document.querySelector('video source');
                if (srcEl) out.url = (srcEl.src || '').replace('http://', 'https://');
              }
              const img = document.querySelector('img[src*="cover"]') || document.querySelector('.video-player img') || document.querySelector('img[src*="gifshow"]');
              if (img) out.cover = img.src || '';
              const title = document.querySelector('h1, .title, .video-title, .photo-desc');
              if (title) out.title = title.textContent.trim().slice(0, 100);
              const author = document.querySelector('.author-name, .user-name, .name');
              if (author) out.author = author.textContent.trim().slice(0, 40);
              const bodyTxt = (document.body ? document.body.innerText : '').slice(0, 600);
              if (/作品.{0,6}(不存在|已删除|删除)|页面不存在|内容不存在|内容已被作者删除|视频不见了/.test(bodyTxt)) out.dead = true;
              return out;
            })()
          `);
          if (r && r.url) {
            clearInterval(poll);
            finish({ ok: true, data: { photoId, title: r.title || '快手视频', cover: r.cover || '', videoUrl: r.url, author: r.author || '' } });
          } else if (r && r.dead) {
            clearInterval(poll);
            finish({ ok: false, error: '视频不存在或已被删除' });
          } else if (tries > 12) {
            clearInterval(poll);
            finish({ ok: false, error: '未在页面中找到播放地址（视频可能已删除或需登录）' });
          }
        } catch (e) {
          if (tries > 12) {
            clearInterval(poll);
            finish({ ok: false, error: '抓取失败：' + e.message });
          }
        }
      }, 500);
    });

    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (!settled) finish({ ok: false, error: '快手页面加载失败：' + desc });
    });

    // 尝试直接用 PC 页；短链需要先跳转
    win.loadURL('https://www.kuaishou.com/short-video/' + photoId).catch(() => {});
  });
}

// ============================================
// 抖音视频解析（隐藏窗口加载 PC 页面，经 CDP 拦截官方 aweme/detail 接口
// 拿到无水印 play_addr + 标题/作者/封面，完全本地、不依赖第三方接口）
// ============================================
function grabDouyinVideo(awemeId) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 750,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { win.destroy(); } catch (_) {} resolve({ ok: false, error: '抖音页面加载超时' }); }
    }, 30000);

    function finish(obj) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch (_) {}
      resolve(obj);
    }

    const dbg = win.webContents.debugger;
    try { dbg.attach('1.3'); dbg.sendCommand('Network.enable'); } catch (_) {}

    // 收集 detail 接口返回
    let detail = null;
    const onMsg = async (_e, method, params) => {
      if (settled || detail) return;
      if (method === 'Network.responseReceived') {
        const url = (params.response && params.response.url) || '';
        if (/\/aweme\/v1\/web\/aweme\/detail\//.test(url)) {
          try {
            const { body } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
            const data = JSON.parse(body);
            const detailObj = data.aweme_detail || data.data || {};
            if (detailObj && detailObj.video && detailObj.video.play_addr) {
              detail = detailObj;
              // 取无水印地址（play_addr 而非 playwm）
              const list = (detailObj.video.play_addr.url_list || []).map(u =>
                u.replace(/\/playwm\//, '/play/').replace(/^http:/, 'https:'));
              const videoUrl = list.find(u => /douyinvod|douyinstatic|\.mp4|v\d+\-web/.test(u)) || list[0];
              if (!videoUrl) return;
              const coverList = detailObj.video.cover && detailObj.video.cover.url_list || [];
              finish({ ok: true, data: {
                awemeId: detailObj.aweme_id || awemeId,
                title: detailObj.desc || '抖音视频',
                cover: (coverList[0] || '').replace(/^http:/, 'https:'),
                videoUrl,
                author: (detailObj.author && detailObj.author.nickname) || '',
              } });
            }
          } catch (e) { /* 忽略，交由其它信号源 */ }
        }
      }
    };
    dbg.on('message', onMsg);

    // 后备信号源：若 detail 拦截不到，轮询 video src 是否为 http 直链
    let poll = null;
    win.webContents.once('dom-ready', () => {
      let tries = 0;
      poll = setInterval(async () => {
        tries++;
        try {
          const r = await win.webContents.executeJavaScript(`(() => {
            const out = { url:'', title:'', cover:'', author:'', dead:false };
            const v = document.querySelector('video');
            if (v) out.url = v.currentSrc || v.src || '';
            if (out.url && !/^https?:/i.test(out.url)) out.url = '';
            if (out.url) out.url = out.url.replace(/^http:/,'https:');
            const h1 = document.querySelector('h1');
            if (h1 && h1.textContent.trim()) out.title = h1.textContent.trim().slice(0,120);
            const nick = document.querySelector('[data-e2e="video-author-name"], [class*="nickname"], .author-info .name');
            if (nick) out.author = nick.textContent.trim().slice(0,40);
            const cis = document.querySelectorAll('img[src*="pcweb_cover"]');
            for (const im of cis) { if (im.src) { out.cover = im.src.replace(/^http:/,'https:'); break; } }
            const bodyTxt = (document.body ? document.body.innerText : '').slice(0,600);
            if (/作品.{0,6}(不存在|已删除|删除)|页面不存在|内容不存在|内容已被作者删除|视频不见了|该作品/.test(bodyTxt)) out.dead = true;
            return out;
          })()`);
          if (r && r.url) {
            clearInterval(poll);
            finish({ ok: true, data: { awemeId, title: r.title || '抖音视频', cover: r.cover || '', videoUrl: r.url, author: r.author || '' } });
          } else if (r && r.dead) {
            clearInterval(poll);
            finish({ ok: false, error: '视频不存在或已被删除' });
          } else if (tries > 18) {
            clearInterval(poll);
            finish({ ok: false, error: '未获取到视频信息' });
          }
        } catch (e) {
          if (tries > 18) {
            clearInterval(poll);
            finish({ ok: false, error: '抓取失败：' + e.message });
          }
        }
      }, 600);
    });

    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (!settled) finish({ ok: false, error: '抖音页面加载失败：' + desc });
    });

    win.loadURL('https://www.douyin.com/video/' + awemeId).catch(() => {});
  });
}

// 解析抖音分享链接：本地窗口抓取优先（稳定、无水印），失败回落 tjit 接口
async function resolveDouyinShare(url) {
  // 先尝试从链接/短链提取 aweme_id
  let awemeId = douyin.extractAwemeId(url) || null;
  try {
    const resolved = await douyin.resolveUrl(url);
    if (!awemeId) awemeId = resolved.awemeId;
  } catch (_) {}

  // 没有 id：无法本地方案，直接走 tjit 接口
  if (!awemeId) {
    const r = await douyin.parseShare(url);
    return r.ok ? { ok: true, data: r.data, source: r.source } : { ok: false, error: r.error };
  }

  // 本地窗口抓取
  try {
    const r = await grabDouyinVideo(awemeId);
    if (r.ok) return { ok: true, data: r.data, source: 'local' };
    // 本地失败，记录原因再做 tjit 兜底
    const fb = await douyin.parseShare(url);
    return fb.ok ? { ok: true, data: fb.data, source: fb.source } : { ok: false, error: fb.error + ' （本地抓取失败：' + r.error + '）' };
  } catch (e) {
    const fb = await douyin.parseShare(url);
    return fb.ok ? { ok: true, data: fb.data, source: fb.source } : { ok: false, error: fb.error };
  }
}

// ===== 单独解析快手分享链接（窗口抓取） =====
ipcMain.handle('kuaishou:parse', async (_evt, text) => {
  try {
    const links = kuaishou.extractLinks(text);
    if (!links.length) return { ok: false, error: '未识别到快手链接' };
    const results = [];
    for (const url of links) {
      try {
        let photoId = kuaishou.getPhotoId(url);
        if (!photoId) {
          // 短链：跟随跳转提取最终 ID
          try { photoId = await kuaishou.resolvePhotoId(url); } catch (_) {}
        }
        if (!photoId) { results.push({ ok: false, kind: 'kuaishou', id: url, error: '无法识别作品 ID' }); continue; }
        const r = await grabKuaishouVideo(photoId);
        if (r.ok) {
          results.push({
            ok: true,
            kind: 'kuaishou',
            id: photoId,
            ksId: photoId,
            title: r.data.title,
            cover: r.data.cover,
            videoUrl: r.data.videoUrl,
            author: r.data.author,
            url,
          });
        } else {
          results.push({ ok: false, kind: 'kuaishou', id: photoId, error: r.error });
        }
      } catch (e) {
        results.push({ ok: false, kind: 'kuaishou', id: url, error: e.message });
      }
    }
    return { ok: true, data: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// =====  获取画质列表 =====
ipcMain.handle('video:qualities', async (_evt, payload) => {
  try {
    const { bvid, cid, qn } = payload || {};
    const play = await bili.getPlayUrl(bvid, cid, qn || 120);
    return { ok: true, data: play };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 获取 DASH 流 URL =====
ipcMain.handle('video:getDashUrls', async (_evt, { bvid, cid, qn }) => {
  try {
    const play = await bili.getPlayUrl(bvid, cid, qn || 120);
    if (!play.dash) return null;
    return bili.getDashStreamUrls(play.dash, qn || play.quality);
  } catch (_) { return null; }
});

// ===== DASH 下载：下载视频流 + 音频流，合并为 mp4 =====
ipcMain.handle('video:downloadDash', async (evt, { videoUrl, audioUrl, videoBackup, audioBackup, filename, saveDir, bvid, taskId }) => {
  try {
    if (!fs.existsSync(saveDir)) {
      try { fs.mkdirSync(saveDir, { recursive: true }); } catch (e) { return { ok: false, error: '无法创建目录: ' + e.message }; }
    }
    const tmpVideo = path.join(saveDir, `_tmp_v_${Date.now()}.m4s`);
    const tmpAudio = path.join(saveDir, `_tmp_a_${Date.now()}.m4s`);
    const outPath = path.join(saveDir, filename);
    const referer = `https://www.bilibili.com/video/${bvid}`;
    const rec = () => { try { const s = fs.statSync(outPath).size; addDownloadHistory({ title: filename, filename, dir: saveDir, size: s, kind: 'video' }); } catch (_) {} };
    try {
      // 下载视频流
      const vUrl = videoBackup || videoUrl;
      await downloadWithProgress(vUrl, path.basename(tmpVideo), saveDir, referer, (p) => {
        try { evt.sender.send('download:progress', { taskId, filename, progress: Math.round(p * 0.6) }); } catch (_) {}
      });
      // 下载音频流
      const aUrl = audioBackup || audioUrl;
      await downloadWithProgress(aUrl, path.basename(tmpAudio), saveDir, referer, (p) => {
        try { evt.sender.send('download:progress', { taskId, filename, progress: 60 + Math.round(p * 0.35) }); } catch (_) {}
      });
      // 合并音视频
      const ffmpeg = getFfmpegPath();
      if (ffmpeg) {
        const args = ['-y', '-i', tmpVideo, '-i', tmpAudio, '-c', 'copy', outPath];
        const r = await runFfmpeg(ffmpeg, args, null, filename);
        if (r.ok) {
          try { evt.sender.send('download:progress', { taskId, filename, progress: 100 }); } catch (_) {}
          rec();
          return { ok: true, path: outPath };
        }
        // ffmpeg 失败：直接返回视频流（无音频但能用）
        try { fs.renameSync(tmpVideo, outPath); } catch (_) {}
        try { evt.sender.send('download:progress', { taskId, filename, progress: 100 }); } catch (_) {}
        rec();
        return { ok: true, path: outPath };
      } else {
        // 无 ffmpeg：直接返回视频流
        try { fs.renameSync(tmpVideo, outPath); } catch (_) {}
        try { evt.sender.send('download:progress', { taskId, filename, progress: 100 }); } catch (_) {}
        rec();
        return { ok: true, path: outPath };
      }
    } finally {
      // 清理临时文件
      try { if (fs.existsSync(tmpVideo)) fs.unlinkSync(tmpVideo); } catch (_) {}
      try { if (fs.existsSync(tmpAudio)) fs.unlinkSync(tmpAudio); } catch (_) {}
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 影视剧集下载：用 ffmpeg 拉取 m3u8 流并封装为 mp4 =====
ipcMain.handle('movie:downloadEpisode', async (evt, { url, filename, saveDir, referer, taskId }) => {
  try {
    if (!fs.existsSync(saveDir)) {
      try { fs.mkdirSync(saveDir, { recursive: true }); } catch (e) { return { ok: false, error: '无法创建目录: ' + e.message }; }
    }
    const outPath = path.join(saveDir, filename);
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return { ok: false, error: '未检测到 ffmpeg，无法下载视频流' };
    // 构造 ffmpeg 参数：下载 m3u8 封装为 mp4
    const args = [
      '-y',
      '-headers', `Referer: ${referer || '*'}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36\r\n`,
      '-i', url,
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ];
    const r = await runFfmpeg(ffmpeg, args, evt, filename);
    if (r.ok) {
      try { evt.sender.send('download:progress', { taskId, filename, progress: 100 }); } catch (_) {}
      try { const s = fs.statSync(outPath).size; addDownloadHistory({ title: filename, filename, dir: saveDir, size: s, kind: 'movie' }); } catch (_) {}
      return { ok: true, path: outPath };
    }
    return { ok: false, error: r.error || 'ffmpeg 下载失败' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 选择保存目录 =====
ipcMain.handle('dialog:saveDir', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择保存目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// ===== 选择头像图片 =====
ipcMain.handle('dialog:pickAvatar', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择头像图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const filePath = r.filePaths[0];
  try {
    const data = fs.readFileSync(filePath);
    const ext = (filePath.split('.').pop() || 'png').toLowerCase();
    const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext] || 'image/png';
    return { dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  } catch (e) {
    return { error: e.message };
  }
});

// =====  默认保存目录：桌面 =====
ipcMain.handle('save:getDefaultDir', () => {
  return app.getPath('desktop');
});

// ===== 文件操作 =====
ipcMain.handle('fs:rename', (_evt, { oldPath, newPath }) => {
  try {
    if (!fs.existsSync(oldPath)) return { ok: false, error: '源文件不存在' };
    fs.renameSync(oldPath, newPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:delete', (_evt, p) => {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('fs:stat', (_evt, p) => {
  try {
    if (!fs.existsSync(p)) return { ok: true, exists: false, size: 0 };
    const st = fs.statSync(p);
    return { ok: true, exists: true, size: st.size, isFile: st.isFile() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 下载文件（带进度） =====
ipcMain.handle('download:start', async (evt, { url, filename, saveDir, referer, taskId, title, kind }) => {
  let size = 0;
  try {
    await downloadWithProgress(url, filename, saveDir, referer, (progress) => {
      try {
        evt.sender.send('download:progress', { taskId, filename, progress });
      } catch (_) {}
    });
    try { size = fs.statSync(path.join(saveDir, filename)).size; } catch (_) {}
    addDownloadHistory({ title: title || filename, filename, dir: saveDir, size, kind: kind || 'video' });
    return { ok: true, path: path.join(saveDir, filename) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ===== 下载历史 IPC =====
ipcMain.handle('history:add', (_e, entry) => addDownloadHistory(entry || {}));
ipcMain.handle('history:list', () => loadDownloadHistory());
ipcMain.handle('history:clear', () => { saveDownloadHistory([]); return []; });
ipcMain.handle('history:remove', (_e, id) => {
  const list = loadDownloadHistory().filter(h => h.id !== id);
  saveDownloadHistory(list);
  return list;
});

// 通用下载：跟随重定向（限深）+  接收 200/206 + 解析 Content-Range/Content-Length + 进度回调
function downloadWithProgress(rawUrl, filename, saveDir, referer, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch (e) { return reject(new Error('URL 非法：' + rawUrl)); }

    if (!fs.existsSync(saveDir)) {
      try { fs.mkdirSync(saveDir, { recursive: true }); } catch (e) { return reject(new Error('无法创建保存目录：' + e.message)); }
    }

    const savePath = path.join(saveDir, filename);
    const lib = parsed.protocol === 'http:' ? http : https;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*',
    };
    if (referer) headers['Referer'] = referer;

    const req = lib.get(rawUrl, { headers }, res => {
      // 重定向跟随（深度上限 5）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('重定向次数过多'));
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, rawUrl).toString();
        return downloadWithProgress(next, filename, saveDir, referer, onProgress, redirects + 1).then(resolve, reject);
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // 解析总大小（206 时取 Content-Range）
      let total = 0;
      if (res.headers['content-range']) {
        const m = /\/(\d+)/.exec(res.headers['content-range']);
        if (m) total = parseInt(m[1], 10);
      } else if (res.headers['content-length']) {
        total = parseInt(res.headers['content-length'], 10);
      }

      const ws = fs.createWriteStream(savePath);
      let downloaded = 0;
      let lastEmit = 0;

      res.on('data', chunk => {
        downloaded += chunk.length;
        const now = Date.now();
        if (onProgress && now - lastEmit > 200) {
          lastEmit = now;
          if (total > 0) {
            onProgress(Math.round((downloaded / total) * 100));
          } else {
            onProgress(-1); // 未知大小
          }
        }
      });

      res.pipe(ws);

      ws.on('error', err => {
        try { fs.unlinkSync(savePath); } catch (_) {}
        reject(new Error('写入失败：' + err.message));
      });

      ws.on('finish', () => {
        if (onProgress) onProgress(total > 0 ? 100 : 100);
        resolve();
      });
    });

    req.on('error', err => reject(new Error('请求失败：' + err.message)));
    req.setTimeout(30000, () => {
      req.destroy(new Error('下载超时（30 秒无响应）'));
    });
  });
}

// ===== ffmpeg  路径检测 =====
function getFfmpegPath() {
  // 1.  开发模式：node_modules/ffmpeg-static
  const devPath = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  if (fs.existsSync(devPath)) return devPath;
  // 2. 打包模式：extraResources/ffmpeg.exe（在 resources/ 目录里）
  const prodPath = path.join(process.resourcesPath, 'ffmpeg.exe');
  if (fs.existsSync(prodPath)) return prodPath;
  return null;
}

ipcMain.handle('ffmpeg:check', () => {
  const p = getFfmpegPath();
  return { ok: !!p, path: p };
});

ipcMain.handle('ffmpeg:extractAudio', async (evt, { inputPath, outputName, saveDir }) => {
  try {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return { ok: false, error: '未找到 ffmpeg.exe' };
    const out = path.join(saveDir, outputName);
    // 优先用 libmp3lame，失败则回落到 ffmpeg  内置 mp3
    const args1 = ['-y', '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '192k', out];
    const r1 = await runFfmpeg(ffmpeg, args1, evt, outputName);
    if (r1.ok) return { ok: true, path: out };
    const args2 = ['-y', '-i', inputPath, '-vn', '-acodec', 'mp3', '-b:a', '192k', out];
    const r2 = await runFfmpeg(ffmpeg, args2, evt, outputName);
    if (r2.ok) return { ok: true, path: out };
    return { ok: false, error: r2.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('ffmpeg:extractVideo', async (evt, { inputPath, outputName, saveDir }) => {
  try {
    const ffmpeg = getFfmpegPath();
    if (!ffmpeg) return { ok: false, error: '未找到 ffmpeg.exe' };
    const out = path.join(saveDir, outputName);
    const args = ['-y', '-i', inputPath, '-an', '-c:v', 'copy', out];
    const r = await runFfmpeg(ffmpeg, args, evt, outputName);
    if (r.ok) return { ok: true, path: out };
    return { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function runFfmpeg(ffmpeg, args, evt, outputName) {
  return new Promise(resolve => {
    let stderr = '';
    let proc;
    try {
      proc = spawn(ffmpeg, args);
    } catch (e) {
      return resolve({ ok: false, error: '启动 ffmpeg 失败：' + e.message });
    }
    proc.stderr.on('data', d => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      if (evt && evt.sender && !evt.sender.isDestroyed()) {
        try {
          evt.sender.send('ffmpeg:log', { name: outputName, line: s.split(/\r?\n/).filter(Boolean).pop() || '' });
        } catch (_) {}
      }
    });
    proc.on('error', err => resolve({ ok: false, error: err.message }));
    proc.on('close', code => {
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: `ffmpeg 退出码 ${code}：` + (stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || '未知错误') });
    });
  });
}

// ============================================
// 登录功能
// ============================================

function loadAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return null;
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!safeStorage.isEncryptionAvailable() || !obj.encrypted) return null;
    const buf = Buffer.from(obj.encrypted, 'base64');
    const plain = safeStorage.decryptString(buf);
    return JSON.parse(plain);
  } catch (e) {
    console.error('[auth] loadAuth failed:', e.message);
    return null;
  }
}

function saveAuth(data) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ encrypted: enc.toString('base64') }));
    return true;
  } catch (e) {
    console.error('[auth] saveAuth failed:', e.message);
    return false;
  }
}

function clearAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch (_) {}
}

function applyCookieToSession(cookieHeader) {
  try {
    const sessionObj = session.defaultSession;
    const items = cookieHeader.split(/;\s*/).filter(Boolean);
    for (const item of items) {
      const eq = item.indexOf('=');
      if (eq < 0) continue;
      const name = item.slice(0, eq).trim();
      const value = item.slice(eq + 1).trim();
      if (!name) continue;
      sessionObj.cookies.set({
        url: 'https://www.bilibili.com',
        name,
        value,
        domain: '.bilibili.com',
        path: '/',
      }).catch(() => {});
    }
  } catch (e) {
    console.error('[auth] applyCookieToSession failed:', e.message);
  }
}

ipcMain.handle('auth:status', async () => {
  try {
    const auth = loadAuth();
    if (!auth || !auth.cookie) return { ok: true, data: { isLogin: false } };
    bili.setCookie(auth.cookie);
    applyCookieToSession(auth.cookie);
    const user = await bili.getUserInfo();
    if (!user || !user.isLogin) {
      clearAuth();
      bili.setCookie('');
      return { ok: true, data: { isLogin: false } };
    }
    return { ok: true, data: user };
  } catch (e) {
    return { ok: true, data: { isLogin: false, error: e.message } };
  }
});

ipcMain.handle('auth:login', async () => {
  try {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      return { ok: false, error: '登录窗口已打开' };
    }
    const win = new BrowserWindow({
      width: 980,
      height: 720,
      title: '登录 B 站',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    loginWindow = win;
    win.setMenuBarVisibility(false);
    await win.loadURL('https://passport.bilibili.com/login');
    startLoginPoll();
    return new Promise(resolve => {
      win.on('closed', () => {
        stopLoginPoll();
        loginWindow = null;
        // 用户主动关闭登录窗口
        resolve({ ok: false, canceled: true });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

let lastLoginResolve = null;

function startLoginPoll() {
  stopLoginPoll();
  let elapsed = 0;
  const interval = 1500;
  const maxWait = 5 * 60 * 1000; // 最多等待 5 分钟

  loginPollTimer = setInterval(async () => {
    elapsed += interval;
    try {
      // 通过 session  获取登录后的 Cookie
      const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' });
      const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      if (cookieHeader && cookieHeader.includes('DedeUserID')) {
        bili.setCookie(cookieHeader);
        const user = await bili.getUserInfo();
        if (user && user.isLogin) {
          saveAuth({ cookie: cookieHeader, loginAt: Date.now() });
          if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
          stopLoginPoll();
          // 触发渲染端成功提示
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('auth:loginSuccess', user);
          }
        }
      }
    } catch (e) {
      // 静默失败，继续轮询
    }
    if (elapsed >= maxWait) {
      stopLoginPoll();
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    }
  }, interval);
}

function stopLoginPoll() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

// ===== 退出登录 =====
ipcMain.handle('auth:logout', async () => {
  try {
    clearAuth();
    bili.setCookie('');
    //  清除 session 中 bilibili 的 Cookie
    try {
      const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' });
      for (const c of cookies) {
        await session.defaultSession.cookies.remove('https://www.bilibili.com', c.name);
      }
    } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
// 抖音登录（Cookie 持久化 + session 注入）
// ============================================
function loadDyAuth() {
  try {
    if (!fs.existsSync(DY_AUTH_FILE)) return null;
    const raw = fs.readFileSync(DY_AUTH_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!safeStorage.isEncryptionAvailable() || !obj.encrypted) return null;
    const plain = safeStorage.decryptString(Buffer.from(obj.encrypted, 'base64'));
    return JSON.parse(plain);
  } catch (e) {
    console.error('[dyauth] load failed:', e.message);
    return null;
  }
}

function saveDyAuth(data) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(DY_AUTH_FILE, JSON.stringify({ encrypted: enc.toString('base64') }));
    return true;
  } catch (e) {
    console.error('[dyauth] save failed:', e.message);
    return false;
  }
}

function clearDyAuth() {
  try { if (fs.existsSync(DY_AUTH_FILE)) fs.unlinkSync(DY_AUTH_FILE); } catch (_) {}
}

async function getDouyinCookieHeader() {
  // 优先用 session 实时 cookie；若 session 读不到（如重启后未注入完整），
  // 回退到登录时持久化的 douyin_auth.json 并重新注入 session，保证登录态可用
  let cookies = [];
  try {
    cookies = await session.defaultSession.cookies.get({ domain: '.douyin.com' });
  } catch (_) { cookies = []; }
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  if (!Object.keys(map).length || !isDyLoggedIn(map)) {
    const saved = loadDyAuth();
    const savedCookie = (saved && saved.cookie) || '';
    if (savedCookie && !isDyLoggedIn(map)) {
      try { injectDyCookieToSession(savedCookie); } catch (_) {}
      try {
        cookies = await session.defaultSession.cookies.get({ domain: '.douyin.com' });
        for (const c of cookies) map[c.name] = c.value;
      } catch (_) {}
      if (!Object.keys(map).length) {
        // session cookies.set 可能失败（部分 cookie 被拒），直接用持久化的完整 header
        return { header: savedCookie, map: cookieToMap(savedCookie) };
      }
    }
  }
  const header = Object.keys(map).map(k => `${k}=${map[k]}`).join('; ');
  return { header, map };
}

function cookieToMap(header) {
  const map = {};
  for (const item of String(header || '').split(/;\s*/).filter(Boolean)) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    map[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return map;
}

// 判断抖音登录态：cookie 含 sessionid 或 sid_guard / uid_tt
function isDyLoggedIn(map) {
  return !!(map['sessionid'] || map['sessionid_ss'] || map['sid_guard'] || map['uid_tt']);
}

// 隐藏窗口抓取用户主页的头像与昵称
function grabDyProfile() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { win.destroy(); } catch (_) {} resolve({}); }
    }, 20000);
    win.webContents.on('did-finish-load', () => {
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const r = await win.webContents.executeJavaScript(`
            (() => {
              const out = { avatar: '', nickname: '' };
              const isAvatarish = (u) => {
                u = (u || '').toLowerCase();
                if (!u || !/^https?:/.test(u)) return false;
                if (/(logo|favicon|icon-|sprite|emoji|\.mp4|\.webp)/.test(u)) return false;
                return u.includes('avatar') || u.includes('aweme-avt') ||
                       u.includes('aweme') || u.includes('douyinpic.com') ||
                       u.includes('byteimg.com') || u.includes('~');
              };
              const seen = new Set();
              const pick = [];
              const add = (u) => { u = (u || '').trim(); if (u && isAvatarish(u) && !seen.has(u)) { seen.add(u); pick.push(u); } };
              const imgs = Array.from(document.querySelectorAll('img'));
              for (const img of imgs) {
                const s = img.currentSrc || img.src || '';
                if (!s) continue;
                const p = img.closest('a, div, figure, span');
                const inAvatarCtn = p && p.className && /avatar|user-info|user-card|author/i.test(String(p.className));
                if (inAvatarCtn || isAvatarish(s)) add(s);
              }
              const og = document.querySelector('meta[property="og:image"]');
              if (og && og.content && /^https?:/.test(og.content)) {
                out.avatar = og.content;
              } else if (pick.length) {
                out.avatar = pick[0];
              }
              const ogName = document.querySelector('meta[property="og:title"]');
              if (ogName) out.nickname = ogName.content || '';
              const h1 = document.querySelector('h1, .ZSKRRaxw, [data-e2e="user-title"]');
              if (h1 && !out.nickname) out.nickname = (h1.textContent || '').trim();
              if (out.avatar && !/^https?:/.test(out.avatar)) out.avatar = new URL(out.avatar, location.href).href;
              return out;
            })()
          `);
          if (r && (r.avatar || r.nickname)) {
            clearInterval(poll);
            settled = true;
            clearTimeout(timer);
            try { win.destroy(); } catch (_) {}
            resolve(r);
          } else if (tries > 12) {
            clearInterval(poll);
            settled = true;
            clearTimeout(timer);
            try { win.destroy(); } catch (_) {}
            resolve({});
          }
        } catch (_) {
          if (tries > 12) {
            clearInterval(poll);
            if (!settled) { settled = true; clearTimeout(timer); try { win.destroy(); } catch (e) {} resolve({}); }
          }
        }
      }, 1000);
    });
    win.webContents.once('did-fail-load', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({}); }
    });
    win.loadURL('https://www.douyin.com/user/self').catch(() => {});
  });
}

function injectDyCookieToSession(cookieHeader) {
  try {
    const s = session.defaultSession;
    for (const item of cookieHeader.split(/;\s*/).filter(Boolean)) {
      const eq = item.indexOf('=');
      if (eq < 0) continue;
      const name = item.slice(0, eq).trim();
      const value = item.slice(eq + 1).trim();
      if (!name) continue;
      s.cookies.set({ url: 'https://www.douyin.com', name, value, domain: '.douyin.com', path: '/' }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
}

function getDyNickname(map) {
  // session 内昵称不易直接取得，尝试从 cookie 中的 nickname / 或返回空
  return map['nickname'] || '';
}

ipcMain.handle('dyauth:status', async () => {
  try {
    const saved = loadDyAuth();
    if (saved && saved.cookie) injectDyCookieToSession(saved.cookie);
    const { header, map } = await getDouyinCookieHeader();
    const isLogin = isDyLoggedIn(map);
    if (isLogin) {
      let avatar = saved && saved.avatar ? saved.avatar : '';
      let name = saved && saved.name ? saved.name : (getDyNickname(map) || '已登录抖音');
      // 若已登录但没抓到头像/昵称，异步补抓一次（不阻塞返回）
      if (!avatar || !name || name === '已登录抖音') {
        grabDyProfile().then(profile => {
          try {
            const na = profile.nickname || name || '';
            const av = profile.avatar || avatar || '';
            if ((na !== name || av !== avatar) && (na || av)) {
              saveDyAuth({ cookie: header, name: na, avatar: av, loginAt: Date.now() });
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('dyauth:loginSuccess', { nickname: na, avatar: av });
              }
            }
          } catch (_) {}
        }).catch(() => {});
      }
      return {
        ok: true,
        data: { isLogin: true, name, avatar },
      };
    }
    return { ok: true, data: { isLogin } };
  } catch (e) {
    return { ok: true, data: { isLogin: false, error: e.message } };
  }
});

ipcMain.handle('dyauth:login', async () => {
  try {
    if (dyLoginWindow && !dyLoginWindow.isDestroyed()) {
      dyLoginWindow.focus();
      return { ok: false, error: '登录窗口已打开' };
    }
    const win = new BrowserWindow({
      width: 900,
      height: 700,
      title: '登录抖音',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    dyLoginWindow = win;
    win.setMenuBarVisibility(false);
    await win.loadURL('https://www.douyin.com/');
    startDyLoginPoll();
    return new Promise(resolve => {
      win.on('closed', () => {
        stopDyLoginPoll();
        dyLoginWindow = null;
        resolve({ ok: false, canceled: true });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function startDyLoginPoll() {
  stopDyLoginPoll();
  let elapsed = 0;
  const interval = 1200;
  const maxWait = 5 * 60 * 1000;

  dyLoginPollTimer = setInterval(async () => {
    elapsed += interval;
    try {
      const { header, map } = await getDouyinCookieHeader();
      if (isDyLoggedIn(map)) {
        const nickname = map['nickname'] || '';
        // 立即保存 cookie 并回执，不等待头像抓取
        saveDyAuth({ cookie: header, name: nickname, avatar: '', loginAt: Date.now() });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('dyauth:loginSuccess', { nickname });
        }
        if (dyLoginWindow && !dyLoginWindow.isDestroyed()) dyLoginWindow.close();
        stopDyLoginPoll();
        // 异步抓取主页头像/昵称，抓取完成后补发（不阻塞登录回执）
        grabDyProfile().then(profile => {
          try {
            const name = profile.nickname || nickname || '';
            saveDyAuth({ cookie: header, name, avatar: profile.avatar || '', loginAt: Date.now() });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('dyauth:loginSuccess', { nickname: name, avatar: profile.avatar || '' });
            }
          } catch (_) {}
        }).catch(() => {});
      }
    } catch (_) {}
    if (elapsed >= maxWait) {
      stopDyLoginPoll();
      if (dyLoginWindow && !dyLoginWindow.isDestroyed()) dyLoginWindow.close();
    }
  }, interval);
}

function stopDyLoginPoll() {
  if (dyLoginPollTimer) { clearInterval(dyLoginPollTimer); dyLoginPollTimer = null; }
}

ipcMain.handle('dyauth:logout', async () => {
  try {
    clearDyAuth();
    const cookies = await session.defaultSession.cookies.get({ domain: '.douyin.com' });
    for (const c of cookies) {
      await session.defaultSession.cookies.remove('https://www.douyin.com', c.name);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
// 抖音收藏 / 点赞列表（隐藏窗口 + DOM 抓取）
// ============================================
ipcMain.handle('douyin:list', async (_evt, { type }) => {
  try {
    const saved = loadDyAuth();
    if (saved && saved.cookie) injectDyCookieToSession(saved.cookie);

    const { map } = await getDouyinCookieHeader();
    if (!isDyLoggedIn(map)) return { ok: false, error: '请先登录抖音' };

    // 收藏页 / 点赞页
    const url = type === 'favorite'
      ? 'https://www.douyin.com/user/self?showTab=favorite_collection'
      : 'https://www.douyin.com/user/self?showTab=like_video';

    const list = await grabDouyinList(url);
    return { ok: true, data: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 打开（不可见）窗口加载抖音页面，等待视频卡片渲染后抓取列表
function grabDouyinList(url) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    let settled = false;
    const timeoutId = setTimeout(() => {
      if (!settled) { settled = true; try { win.destroy(); } catch (_) {} reject(new Error('页面加载超时（可能未登录或风控）')); }
    }, 30000);

    function finish(err, data) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { win.destroy(); } catch (_) {}
      if (err) reject(err); else resolve(data);
    }

    win.webContents.on('did-finish-load', () => {
      // 等待 DOM 中出现视频卡片
      let tries = 0;
      const poll = setInterval(async () => {
        tries++;
        try {
          const r = await win.webContents.executeJavaScript(`
            (() => {
              // 页面内视频卡片：a[href^="/video/"] 
              const cards = [...document.querySelectorAll('a[href*="/video/"]')];
              const seen = new Set();
              const out = [];
              for (const a of cards) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/(\\d{15,20})/);
                if (!m || seen.has(m[1])) continue;
                seen.add(m[1]);
                const img = a.querySelector('img') || a.querySelector('picture img');
                const title = (a.getAttribute('title') || a.textContent || '').trim().slice(0, 60);
                out.push({
                  id: m[1],
                  url: 'https://www.douyin.com/video/' + m[1],
                  cover: img ? (img.src || img.dataset.src || '') : '',
                  title: title || '抖音视频 ' + m[1].slice(-6),
                });
              }
              return out.slice(0, 60);
            })()
          `);
          if (r && r.length > 0) {
            clearInterval(poll);
            finish(null, r);
          } else if (tries > 15) {
            clearInterval(poll);
            finish(new Error('页面未发现视频列表（请确认已登录并切换到收藏/点赞 tab）'));
          }
        } catch (e) {
          if (tries > 15) {
            clearInterval(poll);
            finish(new Error('抓取失败：' + e.message));
          }
        }
      }, 1200);
    });

    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (!settled) finish(new Error('页面加载失败：' + desc));
    });

    win.loadURL(url).catch(() => {});
  });
}

// ============================================
// 抖音私信（原生 API 对接：复用已登录隐藏窗口 + 页面内签名）
// ============================================
ipcMain.handle('douyin:im:conversations', async (_evt, { cursor } = {}) => {
  try { return await douyinIm.getConversations(Number(cursor) || 0); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('douyin:im:messages', async (_evt, { conversationId, cursor, myUid } = {}) => {
  try { return await douyinIm.getMessages(String(conversationId || ''), Number(cursor) || 0, myUid || ''); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('douyin:im:send', async (_evt, { conversationId, text } = {}) => {
  try { return await douyinIm.sendMessage(String(conversationId || ''), String(text || '')); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('douyin:im:status', async () => {
  try { return await douyinIm.status(); }
  catch (e) { return { ok: true, isLogin: false, error: e.message }; }
});

// ============================================
// 本地音乐 API（启动时自动启动 + IPC 代理）
// ============================================
ipcMain.handle('music:start', async () => {
  return musicApi.ensureServer();
});

ipcMain.handle('music:status', async () => {
  return musicApi.ensureServer();
});

ipcMain.handle('music:api', async (_evt, { path, query }) => {
  try {
    // 确保服务在运行
    const st = await musicApi.ensureServer();
    if (!st.ok) return { ok: false, error: st.error };
    const r = await musicApi.apiGet(path, query || {});
    // NeteaseCloudMusicApi 返回 {code:200,...}
    if (r.status >= 200 && r.status < 300 && r.data && r.data.code !== undefined) {
      return { ok: true, data: r.data };
    }
    return { ok: false, error: 'API 返回异常', data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 音乐下载：直接把播放地址交给通用下载器
ipcMain.handle('music:download', async (evt, { url, filename, saveDir }) => {
  try {
    if (!url) return { ok: false, error: '无播放地址' };
    const taskId = `music_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await downloadWithProgress(url, filename, saveDir, 'https://music.163.com/', (progress) => {
      try { evt.sender.send('download:progress', { taskId, filename, progress }); } catch (_) {}
    });
    const out = path.join(saveDir, filename);
    const st = fs.statSync(out);
    if (!st || st.size < 1024) return { ok: false, error: '文件校验失败' };
    addDownloadHistory({ title: filename, filename, dir: saveDir, size: st.size, kind: 'music' });
    return { ok: true, path: out, size: st.size };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 音乐收藏/取消收藏
ipcMain.handle('music:like', async (_evt, id) => {
  try {
    await musicApi.ensureServer();
    const r = await musicApi.apiGet('/like', { like: true, id });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 获取收藏列表
ipcMain.handle('music:likelist', async () => {
  try {
    await musicApi.ensureServer();
    // 获取当前用户 UID（匿名时可能为空）
    const status = await musicApi.apiGet('/login/status');
    const uid = status?.data?.data?.profile?.userId;
    if (!uid) return { ok: true, ids: [] };
    const r = await musicApi.apiGet('/likelist', { uid });
    return { ok: true, ids: (r.data && r.data.ids) || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 通用 GET（跟随重定向）
function httpGet(url, headers = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    }, headers) }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).toString();
        return httpGet(next, headers, timeoutMs).then(resolve, reject);
      }
      let d = '';
      res.on('data', c => { d += c; if (d.length > 4 * 1024 * 1024) res.destroy(); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(d);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 20000, () => req.destroy(new Error('请求超时')));
  });
}
// ============================================
// UC 网盘分享链接解析
// ============================================
ipcMain.handle('uc:parse', async (_evt, shareUrl) => {
  try {
    const links = uc.extractLinks(shareUrl);
    if (!links.length) {
      return { ok: false, error: '未识别到 UC 网盘链接（需形如 https://drive.uc.cn/s/xxxxxxxx 的格式）' };
    }
    const target = links[0];
    const meta = uc.inspectShareMeta(target);
    if (!meta.pwdId) return { ok: false, error: '未识别到分享码' };

    const r = await uc.parseShare(target);
    if (!r.ok) return r;

    // 在文件对象中嵌入 shareUrl 便于下载复用
    r.data.shareUrl = target;
    r.data.files.forEach(f => { f.shareUrl = target; });
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// UC 文件下载：
// UC 网盘网页版"下载"会引导安装客户端、无法直接拿到直链。
// 这里我们提供两种方式：
//  1) "打开分享页"：让用户在自己浏览器里下载（最稳）
//  2) 用 stoken 调 /1/clouddrive/share/sharepage/save 转存到自己网盘（需登录态，跳过）
// 因此这里仅返回 ok + 提示用户到浏览器下载。
ipcMain.handle('uc:open', async (_evt, shareUrl) => {
  try {
    if (!/^https?:\/\//i.test(shareUrl)) return { ok: false, error: '无效链接' };
    const { shell } = require('electron');
    await shell.openExternal(shareUrl);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
// UC 登录（Cookie 持久化 + session 注入）
// ============================================
let ucAuthWindow = null;
let ucAuthPollTimer = null;

function loadUcAuth() {
  try {
    if (!fs.existsSync(UC_AUTH_FILE)) return null;
    const raw = fs.readFileSync(UC_AUTH_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (!safeStorage.isEncryptionAvailable() || !obj.encrypted) return null;
    const plain = safeStorage.decryptString(Buffer.from(obj.encrypted, 'base64'));
    return JSON.parse(plain);
  } catch (e) {
    console.error('[ucauth] load failed:', e.message);
    return null;
  }
}

function saveUcAuth(data) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(data));
    fs.writeFileSync(UC_AUTH_FILE, JSON.stringify({ encrypted: enc.toString('base64') }));
    return true;
  } catch (e) {
    console.error('[ucauth] save failed:', e.message);
    return false;
  }
}

function clearUcAuth() {
  try { if (fs.existsSync(UC_AUTH_FILE)) fs.unlinkSync(UC_AUTH_FILE); } catch (_) {}
}

function isUcLoggedIn(map) {
  return !!(map['aysnc_uc_security'] || map['uc_login_token'] || map['sid_uc'] || map['p_uc_dwa'] || map['token_uc']);
}

async function getUcCookieHeader() {
  const cookies = await session.defaultSession.cookies.get({ domain: '.uc.cn' });
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  const header = Object.keys(map).map(k => `${k}=${map[k]}`).join('; ');
  return { header, map };
}

function injectUcCookieToSession(cookieHeader) {
  try {
    const s = session.defaultSession;
    for (const item of cookieHeader.split(/;\s*/).filter(Boolean)) {
      const eq = item.indexOf('=');
      if (eq < 0) continue;
      const name = item.slice(0, eq).trim();
      const value = item.slice(eq + 1).trim();
      if (!name || !value) continue;
      s.cookies.set({
        url: 'https://drive.uc.cn',
        name, value,
        domain: '.uc.cn', path: '/',
        secure: true, httpOnly: false,
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
      }).catch(() => {});
    }
  } catch (_) {}
}

// 在已登录窗口中查询 UC 用户信息（昵称 / 头像）
function ucFetchUserInWindow(win) {
  return win.webContents.executeJavaScript(`
    (async () => {
      try {
        const r = await fetch('https://pc-api.uc.cn/1/clouddrive/user/info', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Origin': 'https://drive.uc.cn', 'Referer': 'https://drive.uc.cn/' },
          body: '{}'
        });
        const j = await r.json();
        return { ok: !!(j && j.data && (j.code === 0 || j.code === undefined || j.code === null)), data: j.data || null };
      } catch (e) { return { ok: false, error: e.message }; }
    })()
  `);
}

function stopUcAuthPoll() {
  if (ucAuthPollTimer) { clearInterval(ucAuthPollTimer); ucAuthPollTimer = null; }
}

function startUcAuthPoll() {
  stopUcAuthPoll();
  let elapsed = 0;
  const interval = 1500;
  const maxWait = 5 * 60 * 1000;
  ucAuthPollTimer = setInterval(async () => {
    elapsed += interval;
    try {
      const { header, map } = await getUcCookieHeader();
      let name = '';
      let avatar = '';
      let loggedIn = isUcLoggedIn(map);
      // 兜底：若未命中已知 cookie 名，则直接尝试拉取用户信息（最可靠的登录信号）
      if (!loggedIn && ucAuthWindow && !ucAuthWindow.isDestroyed()) {
        try {
          const info = await ucFetchUserInWindow(ucAuthWindow);
          if (info && info.ok && info.data) {
            loggedIn = true;
            name = info.data.nick_name || info.data.nickname || '';
            avatar = info.data.avatar_url || info.data.avatar || '';
          }
        } catch (_) {}
      }
      if (loggedIn) {
        // 若前面兜底未取到昵称，再补一次用户信息
        if (!name && ucAuthWindow && !ucAuthWindow.isDestroyed()) {
          try {
            const info = await ucFetchUserInWindow(ucAuthWindow);
            if (info && info.data) {
              name = info.data.nick_name || info.data.nickname || '';
              avatar = info.data.avatar_url || info.data.avatar || '';
            }
          } catch (_) {}
        }
        saveUcAuth({ cookie: header, name, avatar, loginAt: Date.now() });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('uc:loginSuccess', { name, avatar });
        }
        stopUcAuthPoll();
        if (ucAuthWindow && !ucAuthWindow.isDestroyed()) ucAuthWindow.close();
      }
    } catch (_) {}
    if (elapsed >= maxWait) {
      stopUcAuthPoll();
      if (ucAuthWindow && !ucAuthWindow.isDestroyed()) ucAuthWindow.close();
    }
  }, interval);
}

ipcMain.handle('uc:status', async () => {
  try {
    const saved = loadUcAuth();
    if (saved && saved.cookie) injectUcCookieToSession(saved.cookie);
    const { map } = await getUcCookieHeader();
    const isLogin = isUcLoggedIn(map) || !!(saved && saved.cookie);
    if (isLogin) {
      return {
        ok: true,
        data: {
          isLogin: true,
          name: (saved && saved.name) || '已登录 UC',
          avatar: (saved && saved.avatar) || '',
        },
      };
    }
    return { ok: true, data: { isLogin } };
  } catch (e) {
    return { ok: true, data: { isLogin: false, error: e.message } };
  }
});

ipcMain.handle('uc:login', async () => {
  try {
    if (ucAuthWindow && !ucAuthWindow.isDestroyed()) {
      ucAuthWindow.focus();
      return { ok: false, error: '登录窗口已打开' };
    }
    const win = new BrowserWindow({
      width: 480,
      height: 720,
      title: '登录 UC 网盘',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    ucAuthWindow = win;
    win.setMenuBarVisibility(false);
    await win.loadURL('https://drive.uc.cn/');
    startUcAuthPoll();
    return new Promise(resolve => {
      win.on('closed', () => {
        stopUcAuthPoll();
        ucAuthWindow = null;
        resolve({ ok: false, canceled: true });
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('uc:logout', async () => {
  clearUcAuth();
  return { ok: true };
});

// ============================================
// 免责声明（首次启动必看，同意后写入标记）
// ============================================
function hasAcceptedDisclaimer() {
  try { return fs.existsSync(DISCLAIMER_FILE); } catch (_) { return false; }
}

function markDisclaimerAccepted() {
  try {
    fs.writeFileSync(DISCLAIMER_FILE, JSON.stringify({ accepted: true, at: Date.now() }));
  } catch (_) {}
}

async function showDisclaimer() {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'warning',
    title: '使用前请阅读 - 免责声明',
    message: '免责声明',
    detail:
      '本软件（BiliGrab）仅用于个人学习、研究和技术交流，严禁用于任何商业用途。\n\n' +
      '1. 下载内容仅供个人观看与学习，请勿二次传播、分发或用于商业牟利；\n' +
      '2. 请尊重原作者版权，下载的内容请及时删除，支持正版平台与原创作者；\n' +
      '3. 任何因违反平台规则、法律法规或侵犯他人权益的行为，均由使用者本人承担全部责任，本软件作者不承担任何连带责任；\n' +
      '4. 抖音解析接口由公开分享页提供，仅供个人学习研究，请勿滥用。\n' +
      '5. 抖音无水印下载可能受平台风控影响，如遇失败请以官方 App 为准。',
    buttons: ['我已阅读并同意', '不同意，退出'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: '下次启动不再提示',
    noLink: true,
  });

  if (checkboxChecked || response === 0) markDisclaimerAccepted();
  return response === 0;
}

// ============================================
// 影视：搜索 + 在线观看（苹果CMS 资源站 + 解析接口）
// ============================================
function normalizeBase(base) {
  try {
    const u = new URL(base);
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch (_) {
    return String(base).replace(/\/+$/, '');
  }
}

// 构造 CMS 请求 URL：src 可能是纯域名、含 /provide/vod 的接口路径，需智能判断避免重复拼接
function cmsApiUrl(base, path) {
  let b = normalizeBase(base);
  // 已经是 CMS 接口路径（/api.php/provide/vod 或 /provide/vod 等）：直接在尾部追加参数
  if (/\/provide\/vod\/?$/i.test(b) || /\/api\.php\/provide\/vod\/?$/i.test(b)) {
    return b + path;
  }
  return b + '/api.php/provide/vod' + path;
}

// 影视搜索/详情缓存（内存级，减少重复请求）
const _movieCache = new Map();
const MOVIE_CACHE_TTL = 3 * 60 * 1000; // 3 分钟
function getCached(key) {
  const e = _movieCache.get(key);
  if (e && Date.now() - e.ts < MOVIE_CACHE_TTL) return e.data;
  if (e) _movieCache.delete(key);
  return null;
}
function setCache(key, data) {
  // 限制缓存大小
  if (_movieCache.size > 100) {
    const oldest = _movieCache.keys().next().value;
    _movieCache.delete(oldest);
  }
  _movieCache.set(key, { data, ts: Date.now() });
}

ipcMain.handle('movie:search', async (_evt, { base, keyword, pg = 1, timeout = 5000 }) => {
  try {
    if (!base || !/^https?:\/\//i.test(base)) return { ok: false, error: '搜索源地址无效' };
    if (!keyword) return { ok: false, error: '关键词为空' };
    // 缓存命中直接返回
    const cacheKey = `search:${base}:${keyword}:${pg}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const url = cmsApiUrl(base, `/?ac=detail&wd=${encodeURIComponent(keyword)}&pg=${pg}`);
    const body = await httpGet(url, { 'Referer': base }, timeout);
    let data;
    try { data = JSON.parse(body); }
    catch (e) { return { ok: false, error: '搜索源返回的不是标准 JSON（请确认是苹果CMS 资源站）' }; }
    const list = Array.isArray(data.list) ? data.list : [];
    const result = { ok: true, data: { list, page: data.page || pg, pagecount: data.pagecount || 1, total: data.total || list.length } };
    if (result.ok) setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('movie:detail', async (_evt, { base, id }) => {
  try {
    if (!base || !/^https?:\/\//i.test(base)) return { ok: false, error: '搜索源地址无效' };
    // 缓存命中直接返回
    const cacheKey = `detail:${base}:${id}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const url = cmsApiUrl(base, `/?ac=detail&ids=${encodeURIComponent(id)}`);
    const body = await httpGet(url, { 'Referer': base }, 3500);
    let data;
    try { data = JSON.parse(body); }
    catch (e) { return { ok: false, error: '详情源返回异常，无法解析' }; }
    const list = Array.isArray(data.list) ? data.list : [];
    if (!list.length) return { ok: false, error: '未找到该影视详情' };
    const result = { ok: true, data: list[0] };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ============================================
// 影视播放状态探测 / 进度控制（在播放器 iframe 内执行 JS）
// ============================================
// 播放器是一个跨域 iframe（解析页），渲染进程无法直接读取其中的 <video>，
// 这里借助 Electron 主进程对所有子 frame 执行脚本，探测/控制播放状态。
function getPlayerFrames() {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc) return [];
  const out = [];
  const walk = (f) => {
    out.push(f);
    (f.frames || []).forEach(walk);
  };
  walk(wc.mainFrame);
  return out;
}

async function execInFrames(code, onlyVideoFrame = false) {
  const frames = getPlayerFrames();
  for (const f of frames) {
    try {
      const r = await f.executeJavaScript(code, true);
      if (onlyVideoFrame) {
        if (r && r.found) return r;
      } else if (r !== undefined) {
        return r;
      }
    } catch (e) {
      // 某些 frame 可能尚未加载完成，跳过
    }
  }
  return onlyVideoFrame ? { found: false } : null;
}

ipcMain.handle('movie:probe', async () => {
  const code = `(() => {
    const v = document.querySelector('video');
    if (!v) return { found: false };
    const readyState = v.readyState;
    return {
      found: true,
      paused: v.paused,
      ended: v.ended,
      currentTime: v.currentTime || 0,
      duration: v.duration && isFinite(v.duration) ? v.duration : 0,
      readyState,
      networkState: v.networkState,
      error: v.error ? String(v.error.code) : null,
      src: (v.currentSrc || v.src || '').slice(0, 160),
    };
  })()`;
  return execInFrames(code, true);
});

ipcMain.handle('movie:checkText', async () => {
  const frames = getPlayerFrames();
  for (const f of frames) {
    try {
      const url = f.url || '';
      // 只检查解析器 iframe（含 player/parser 关键词）或可能是播放页的 frame
      if (!url || url === 'about:blank') continue;
      if (/index\.html|app\.asar/.test(url)) continue; // 跳过主页面
      const r = await f.executeJavaScript(`(() => {
        const t = (document.body ? document.body.innerText : '').slice(0, 2000);
        const err = /不支持|无法解析|解析失败|视频不存在|无效链接|未找到|播放地址获取失败|请求异常|分钟后重试|请\d+分钟后|IP.*限制|频率过高|访问被拒绝|禁止访问|ban|block/i.test(t);
        return { text: t.slice(0, 300), hasError: err, url: location.href.slice(0, 100) };
      })()`, true);
      if (r && r.text && r.text.length > 5) return r;
    } catch (e) {}
  }
  return { text: '', hasError: false };
});

// 自动点击解析器页面上的"立即播放"类按钮，减少人工操作
ipcMain.handle('movie:autoPlayBtn', async () => {
  const frames = getPlayerFrames();
  for (const f of frames) {
    try {
      const url = f.url || '';
      if (!url || url === 'about:blank') continue;
      if (/index\.html|app\.asar/.test(url)) continue;
      const clicked = await f.executeJavaScript(`(() => {
        // 优先匹配按钮文本（常见解析站文案）
        const btnTexts = ['立即播放','立即观看','开始播放','点击播放','播放视频','开始观看','点击观看','直接播放','本集播放','播放本集','点击此处播放','点击开始'];
        const allEls = [...document.querySelectorAll('a,button,input[type=button],input[type=submit],div[onclick],span[onclick],li[onclick],p[onclick]')];
        for (const el of allEls) {
          const txt = (el.textContent || el.value || '').trim();
          for (const t of btnTexts) {
            if (txt === t || txt.includes(t)) {
              el.click();
              return { clicked: true, text: txt, tag: el.tagName };
            }
          }
        }
        // CSS 选择器兜底（常见播放按钮 class/id）
        const sels = ['.play-btn','#play','.play_btn','.btn-play','#player-play','.play-btn-wrap','.start-play','.jx-btn','a.play','.player-btn','#playerBtn','.video-play','.playBtn'];
        for (const sel of sels) {
          try {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) { el.click(); return { clicked: true, selector: sel, tag: el.tagName }; }
          } catch (_) {}
        }
        // 兜底：找带 play/playBtn/player 相关 class 或 id 的可点击元素
        const playEls = document.querySelectorAll('[class*=play],[id*=play],[class*=player],[id*=player]');
        for (const el of playEls) {
          const tag = el.tagName.toLowerCase();
          if ((tag==='a'||tag==='button'||tag==='div'||tag==='span') && el.offsetParent!==null && typeof el.click==='function') {
            el.click();
            return { clicked: true, selector: tag+'.'+el.className.split(' ')[0], tag: tag };
          }
        }
        return { clicked: false };
      })()`, true);
      if (clicked && clicked.clicked) return clicked;
    } catch (e) {}
  }
  return { clicked: false };
});

ipcMain.handle('movie:seek', async (_e, { time }) => {
  const t = Number(time) || 0;
  const code = `(() => {
    const v = document.querySelector('video');
    if (!v || !isFinite(v.duration) || !v.duration) return { ok: false };
    try {
      v.currentTime = Math.min(${t}, Math.max(0, v.duration - 0.5));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })()`;
  return execInFrames(code, true);
});

ipcMain.handle('movie:next', async (_e, { dir }) => {
  const jump = dir > 0 ? 1 : 0;
  const code = `(() => {
    const v = document.querySelector('video');
    if (!v) return { ok: false };
    try {
      if (${jump} > 0) { v.currentTime = (v.duration > 0 ? v.duration : v.currentTime); }
      else { v.currentTime = 0; }
      return { ok: true };
    } catch (e) { return { ok: false }; }
  })()`;
  return execInFrames(code, true);
});

// 影视播放器 CDN 防盗链：记录当前解析线路的 Origin，主进程据此为媒体请求重写 Referer，
// 减少部分解析站对 m3u8/ts/mp4 的 403 导致的播放卡顿
let movieParserReferer = null;
ipcMain.handle('movie:setReferer', (_evt, referer) => {
  if (typeof referer === 'string') {
    try {
      const u = new URL(referer);
      movieParserReferer = u.origin;
    } catch (_) { movieParserReferer = referer; }
  } else {
    movieParserReferer = null;
  }
  return { ok: true };
});

// 本地影视 API 服务：状态 / 通用代理（供渲染进程与外部脚本复用）
ipcMain.handle('movie:serverStatus', async () => {
  try {
    const r = await movieApi.apiGet('/api/status', {});
    return { ok: true, port: movieApi.getCurrentPort(), data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('movie:serverApi', async (_evt, { path, query }) => {
  try {
    const r = await movieApi.apiGet(path, query || {});
    return { ok: r.status === 200, status: r.status, data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// ============================================
//  应用启动
// ============================================

app.whenReady().then(async () => {
  // 首次启动：先展示免责声明
  if (!hasAcceptedDisclaimer()) {
    const agreed = await showDisclaimer();
    if (!agreed) {
      app.quit();
      return;
    }
  }

  // 使用真实 Chrome UA，让登录页与视频播放更稳定
  setupSessionUA();

  // B站视频直链播放防盗链 + 影视封面图防盗链：为媒体域名请求注入 Referer 与 UA（需在 ready 后注册）
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = details.url || '';
    // 平台 CDN 防盗链：优先按平台注入正确 Referer，避免被下方通用图片规则改写致 403
    // —— B站 hdslb 头像/封面；抖音 douyinpic/byteimg 头像需各自站点的 Referer
    if (/bilivideo\.com|hdslb\.com|akamaized\.net|mcdn\.bilivideo\.cn|upos-|\.mgesc\.com/i.test(url)) {
      details.requestHeaders['Referer'] = 'https://www.bilibili.com/';
      details.requestHeaders['Origin'] = 'https://www.bilibili.com';
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const ck = biliCookieHeader();
      if (ck) details.requestHeaders['Cookie'] = ck;
      else if (details.requestHeaders['Cookie']) delete details.requestHeaders['Cookie'];
    } else if (/douyinpic\.com|byteimg\.com|douyinstatic\.com|douyin\.com/i.test(url)) {
      details.requestHeaders['Referer'] = 'https://www.douyin.com/';
      details.requestHeaders['Origin'] = 'https://www.douyin.com';
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    } else if (/\.(jpg|jpeg|png|webp|gif)(\?|#|$)/i.test(url)) {
      // 其余图片（如影视 CMS 封面 CDN）统一注入 Referer + UA 绕过防盗链
      details.requestHeaders['Referer'] = 'https://www.google.com/';
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    }
    // 影视解析器 CDN 防盗链：解析站页面内发起的媒体请求（m3u8 / ts / mp4 / flv），重写 Referer 为当前解析线路 Origin。
    // 仅当该请求确实来自解析页（referrer 与记录解析线路同源）时生效，避免影响其它平台。
    if (movieParserReferer && /\.(m3u8|ts|mp4|flv)(\?|$)/i.test(url)) {
      const ref = details.requestHeaders['Referer'] || details.referrer || '';
      if (!ref || ref.startsWith(movieParserReferer)) {
        details.requestHeaders['Referer'] = movieParserReferer;
        details.requestHeaders['Origin'] = movieParserReferer;
        details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // 初始化截图工具（托盘/全局热键/开机自启/--hidden）——提前执行以获得 hiddenStart 判定
  const captureInit = capture.init({ mainWindowGetter: () => mainWindow });
  const hiddenStart = captureInit?.hiddenStart;

  // 启动动画：后台静默启动（--hidden）时不显示
  if (!hiddenStart) {
    createSplash();
    // 给启动页一点渲染时间，避免一闪而过
    await new Promise((r) => setTimeout(r, 180));
  }
  splashStep(14, '正在恢复登录状态');

  // 启动时尝试加载已保存登录态（B站 + 抖音）
  try {
    const auth = loadAuth();
    if (auth && auth.cookie) {
      bili.setCookie(auth.cookie);
      applyCookieToSession(auth.cookie);
    }
  } catch (_) {}

  try {
    const dyAuth = loadDyAuth();
    if (dyAuth && dyAuth.cookie) {
      injectDyCookieToSession(dyAuth.cookie);
    }
  } catch (_) {}

  splashStep(38, '正在启动音乐服务');

  // 自动启动本地音乐 API（用户可随时在音乐面板使用）
  try {
    const ms = await musicApi.ensureServer();
    if (!ms.ok) console.error('[music] 启动失败:', ms.error);
  } catch (e) {
    console.error('[music] 启动异常:', e.message);
  }

  splashStep(62, '正在启动影视服务');

  // 自动启动本地影视 API（多源聚合搜索 + 磁盘缓存，随应用启停）
  try {
    const ma = await movieApi.ensureServer({ cacheDir: app.getPath('userData') });
    if (!ma.ok) console.error('[movie-api] 启动失败:', ma.error);
  } catch (e) {
    console.error('[movie-api] 启动异常:', e.message);
  }

  splashStep(82, '正在加载主界面');

  if (!hiddenStart) {
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !hiddenStart) createWindow();
  });
});

app.on('will-quit', () => {
  try { closeLyricsWindow(); } catch (_) {}
  try { musicApi.stopServer(); } catch (_) {}
  try { movieApi.stopServer(); } catch (_) {}
});

app.on('window-all-closed', () => {
  stopLoginPoll();
  stopDyLoginPoll();
  // 托盘驻留模式：关闭主窗口不退出，由托盘菜单"退出"真正退出
  // 如果是 macOS 且没有托盘，则按默认行为
  if (process.platform === 'darwin') return;
});
