/**
 * PixPin 风格截图工具（主进程模块）
 *  - 区域截图（区域 + 标注 + 复制/保存/贴图）
 *  - 标注工具（矩形/椭圆/箭头/文字/马赛克/画笔/取色/撤销重做）
 *  - 贴图（置顶悬浮小窗，可缩放）
 *  - 录屏（GIF / WebP / MP4，使用 ffmpeg 转码）
 *  - OCR 文字识别（tesseract.js 本地免费）
 *  - 系统托盘 / 全局快捷键 / 开机自启动 / --hidden 启动驻留
 */
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, desktopCapturer, clipboard, dialog, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const DATA_DIR = path.join(app.getPath('userData'), 'capture');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PIN_DIR = path.join(DATA_DIR, 'pins');
let tray = null;
let overlayWin = null;   // 区域截图遮罩窗
let editorWin = null;    // 标注编辑窗
let pinWins = [];        // 贴图窗
let recorderWin = null;  // 录屏控制窗
let mediaWin = null;      // 录屏用的隐藏采集窗（持有一块屏幕的 capture stream）

function ensureDirs() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(PIN_DIR, { recursive: true }); } catch (_) {}
}

function loadSettings() {
  try { return Object.assign({ captureKey: 'CommandOrControl+1', scrollKey: 'CommandOrControl+2', recordKey: 'CommandOrControl+3', ocrKey: 'CommandOrControl+4', pinKey: 'CommandOrControl+5', openAtLogin: false }, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch (_) { return { captureKey: 'CommandOrControl+1', scrollKey: 'CommandOrControl+2', recordKey: 'CommandOrControl+3', ocrKey: 'CommandOrControl+4', pinKey: 'CommandOrControl+5', openAtLogin: false }; }
}
function saveSettings(s) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); return fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s), 'utf8'); } catch (_) {}
}
let settings = loadSettings();

function getFfmpeg() {
  const dev = path.join(__dirname, '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  if (fs.existsSync(dev)) return dev;
  const prod = path.join(process.resourcesPath, 'ffmpeg.exe');
  if (fs.existsSync(prod)) return prod;
  return null;
}

// 托盘图标：用打包资源里的 icon.png（开发/生产两套路径），缩至 16px
function trayIcon() {
  try {
    const candidates = [
      path.join(__dirname, '..', '..', 'build', 'icon.png'),            // 开发模式
      path.join(process.resourcesPath, 'icon.png'),                      // 打包模式（extraResources）
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
      }
    }
    return nativeImage.createEmpty();
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

// 需要与主窗口交互
let getMainWindow = () => null;
function setMainWindowGetter(fn) { getMainWindow = fn; }

/* ============================================================
 *  区域截图
 * ============================================================ */
async function captureScreen() {
  // 当前主显示器
  const primary = screen.getPrimaryDisplay();
  const { width, height, scaleFactor } = primary;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
  });
  const source = sources.find(s => s.display_id === String(primary.id)) || sources[0];
  if (!source) throw new Error('未找到屏幕来源');
  // 返回整屏截图 dataURL（已按物理像素拍摄）
  return {
    dataURL: source.thumbnail.toDataURL(),
    imageWidth: source.thumbnail.getSize().width,
    imageHeight: source.thumbnail.getSize().height,
    displayWidth: width,
    displayHeight: height,
    scaleFactor,
    displayId: primary.id,
  };
}

async function startCapture(triggerSource) {
  try {
    const snap = await captureScreen();
    if (!snap.dataURL || snap.dataURL === 'data:image/png;base64,') {
      const win = triggerSource === 'main' ? getMainWindow() : null;
      if (win) win.webContents.send('capture:error', '截图失败：屏幕图像为空');
      return;
    }
    openOverlay(snap);
  } catch (e) {
    const win = getMainWindow();
    if (win) win.webContents.send('capture:error', '截图失败：' + e.message);
  }
}

function openOverlay(snap) {
  if (overlayWin) { try { overlayWin.close(); } catch (_) {} overlayWin = null; }
  overlayWin = new BrowserWindow({
    width: snap.displayWidth,
    height: snap.displayHeight,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    fullscreenable: false, enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  const sendSnap = () => {
    try { overlayWin.webContents.send('capture:snapshot', snap); } catch (_) {}
  };
  overlayWin.webContents.on('did-finish-load', sendSnap);
  overlayWin.on('closed', () => { overlayWin = null; });
  overlayWin.show();
}

function closeOverlay() {
  if (overlayWin) { try { overlayWin.close(); } catch (_) {} overlayWin = null; }
}

// overlay 选择完成 → 打开标注编辑器
function onOverlaySelected(payload) {
  closeOverlay();
  openEditor(payload.dataURL);
}
function onOverlayCancel() {
  closeOverlay();
}

/* ============================================================
 *  长截图（针对内置 webview 的页面滚动拼接）
 * ============================================================ */
let scrollWin = null; // 长截图进度窗口
async function startScrollCapture(source) {
  const w = getMainWindow();
  if (!w) return;
  
  // 先检查当前是否有内置 webview 处于活动状态
  const activeView = await getActiveEmbedView(w);
  if (!activeView) {
    w.webContents.send('capture:error', '请先打开内置 B站 或 内置抖音 页面');
    return;
  }
  
  // 显示进度窗口
  openScrollProgress();
  
  try {
    const dataURL = await captureLongScreenshot(w, activeView);
    closeScrollProgress();
    if (dataURL) openEditor(dataURL);
  } catch (e) {
    closeScrollProgress();
    w.webContents.send('capture:error', '长截图失败：' + e.message);
  }
}

function openScrollProgress() {
  if (scrollWin) { try { scrollWin.close(); } catch (_) {} scrollWin = null; }
  scrollWin = new BrowserWindow({
    width: 320, height: 160,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'scroll-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  scrollWin.setAlwaysOnTop(true, 'screen-saver');
  scrollWin.loadFile(path.join(__dirname, 'scroll.html'));
  scrollWin.show();
  scrollWin.on('closed', () => { scrollWin = null; });
}

function closeScrollProgress() {
  if (scrollWin) { try { scrollWin.close(); } catch (_) {} scrollWin = null; }
}

function updateScrollProgress(percent, text) {
  if (scrollWin) {
    try { scrollWin.webContents.send('scroll:progress', { percent, text }); } catch (_) {}
  }
}

/**
 * 在主窗口中查找当前活动的内置 webview
 * 返回 { webviewId, webContents, name }
 */
async function getActiveEmbedView(mainWin) {
  const views = mainWin.webContents.getAllWebContents().filter(wc => wc.getType() === 'webview');
  for (const wc of views) {
    const url = wc.getURL();
    if (url.includes('bilibili.com') || url.includes('douyin.com')) {
      return { webContents: wc, url };
    }
  }
  return null;
}

/**
 * 执行长截图：在 webview 中滚动并拼接
 */
async function captureLongScreenshot(mainWin, view) {
  const wc = view.webContents;
  if (!wc) return null;
  
  updateScrollProgress(5, '获取页面尺寸…');
  
  const dims = await wc.executeJavaScript(`
    (() => {
      const doc = document.documentElement;
      const body = document.body;
      const scrollHeight = Math.max(doc.scrollHeight, body.scrollHeight, doc.clientHeight);
      const clientHeight = doc.clientHeight || window.innerHeight;
      const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth, doc.clientWidth);
      const clientWidth = doc.clientWidth || window.innerWidth;
      return { scrollHeight, clientHeight, scrollWidth, clientWidth };
    })()
  `).catch(() => null);
  
  if (!dims || dims.scrollHeight <= dims.clientHeight) {
    updateScrollProgress(50, '页面无需拼接，直接截图…');
    const img = await wc.capturePage();
    return img.toDataURL();
  }
  
  const { scrollHeight, clientHeight, scrollWidth, clientWidth } = dims;
  const steps = Math.ceil(scrollHeight / clientHeight);
  updateScrollProgress(10, `开始拼接 (${steps} 段)…`);
  
  const originalScroll = await wc.executeJavaScript('window.scrollY || document.documentElement.scrollTop || 0').catch(() => 0);
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = scrollWidth;
  canvas.height = scrollHeight;
  
  for (let i = 0; i < steps; i++) {
    const y = i * clientHeight;
    updateScrollProgress(10 + Math.round((i / steps) * 80), `捕获第 ${i+1}/${steps} 段…`);
    
    await wc.executeJavaScript(`window.scrollTo(0, ${y});`);
    await new Promise(r => setTimeout(r, 300));
    
    const img = await wc.capturePage({ x: 0, y: 0, width: scrollWidth, height: clientHeight });
    const bitmap = img.toPNG();
    
    const partImg = new Image();
    await new Promise((resolve, reject) => {
      partImg.onload = resolve;
      partImg.onerror = reject;
      partImg.src = 'data:image/png;base64,' + bitmap.toString('base64');
    });
    ctx.drawImage(partImg, 0, y);
  }
  
  await wc.executeJavaScript(`window.scrollTo(0, ${originalScroll});`);
  
  updateScrollProgress(95, '生成最终图片…');
  return canvas.toDataURL('image/png');
}

/* ============================================================
 *  标注编辑器
 * ============================================================ */
function openEditor(dataURL) {
  if (editorWin) { try { editorWin.close(); } catch (_) {} editorWin = null; }
  editorWin = new BrowserWindow({
    width: 900, height: 680,
    minWidth: 600, minHeight: 420,
    frame: false, backgroundColor: '#14161f',
    webPreferences: {
      preload: path.join(__dirname, 'editor-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  editorWin.loadFile(path.join(__dirname, 'editor.html'));
  editorWin.webContents.on('did-finish-load', () => {
    try { editorWin.webContents.send('editor:image', dataURL); } catch (_) {}
  });
  editorWin.on('closed', () => { editorWin = null; });
  editorWin.show();
}

async function onEditorAction(payload) {
  const dataURL = payload.dataURL || '';
  const action = payload.action || 'copy';
  try {
    if (action === 'copy') { clipboard.writeImage(nativeImage.createFromDataURL(dataURL)); }
    else if (action === 'save') {
      const exts = [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg'] }];
      const dlg = await dialog.showSaveDialog({ title: '保存截图', defaultPath: '截图.png', filters: exts });
      if (!dlg.canceled && dlg.filePath) {
        const buf = dataURLToBuffer(dataURL);
        fs.writeFileSync(dlg.filePath, buf);
        require('electron').shell.showItemInFolder(dlg.filePath);
      }
    }
    else if (action === 'pin') { addPin(dataURL); }
    else if (action === 'ocr') { openOcr(dataURL); return; } // 不关闭编辑器
  } catch (e) { console.error('[capture] editor action error', e); }
  if (action !== 'ocr' && editorWin) { try { editorWin.close(); } catch (_) {} editorWin = null; }
}

function dataURLToBuffer(dataURL) {
  const m = /^data:image\/(png|jpe?g);base64,(.*)$/s.exec(dataURL || '');
  if (!m) return null;
  return Buffer.from(m[2], 'base64');
}

/* ============================================================
 *  贴图（置顶悬浮小窗）
 * ============================================================ */
function addPin(dataURL) {
  const w = new BrowserWindow({
    width: 320, height: 240, minWidth: 120, minHeight: 90,
    frame: false, transparent: false, backgroundColor: '#0d0f16',
    alwaysOnTop: true, skipTaskbar: false, resizable: true, hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'pin-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  w.setAlwaysOnTop(true, 'floating');
  w.loadFile(path.join(__dirname, 'pin.html'));
  w.webContents.on('did-finish-load', () => {
    try { w.webContents.send('pin:image', dataURL); } catch (_) {}
  });
  const idx = pinWins.length;
  pinWins.push(w);
  w.on('closed', () => { pinWins = pinWins.filter(x => x !== w); });
  w.show();
}

/* ============================================================
 *  录屏（GIF / WebP / MP4）
 * ============================================================ */
function openRecorder() {
  if (recorderWin) { try { recorderWin.focus(); } catch (_) {} return; }
  recorderWin = new BrowserWindow({
    width: 340, height: 300, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  recorderWin.loadFile(path.join(__dirname, 'recorder.html'));
  recorderWin.show();
  recorderWin.on('closed', () => { recorderWin = null; });
}

/* ============================================================
 *  OCR 文字识别（tesseract.js 本地免费）
 * ============================================================ */
let tesseract = null;
let ocrWorker = null;
let ocrLang = 'chi_sim+eng';
async function getOcrWorker(lang) {
  if (!tesseract) tesseract = require('tesseract.js');
  lang = lang || ocrLang;
  if (ocrWorker && ocrWorker._lang === lang) return ocrWorker;
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch (_) {} ocrWorker = null; }
  try {
    const cachePath = path.join(DATA_DIR, 'tessdata');
    try { fs.mkdirSync(cachePath, { recursive: true }); } catch (_) {}
    ocrWorker = await tesseract.createWorker(lang, 1, { cachePath });
    ocrWorker._lang = lang;
    return ocrWorker;
  } catch (e) { throw new Error('OCR 引擎加载失败：' + e.message); }
}

let ocrWin = null;
function openOcr(dataURL) {
  if (ocrWin) { try { ocrWin.focus(); } catch (_) {} return; }
  ocrWin = new BrowserWindow({
    width: 580, height: 560,
    frame: false, backgroundColor: '#14161f',
    webPreferences: {
      preload: path.join(__dirname, 'ocr-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  ocrWin.loadFile(path.join(__dirname, 'ocr.html'));
  if (dataURL) ocrWin.webContents.on('did-finish-load', () => {
    try { ocrWin.webContents.send('ocr:image', dataURL); } catch (_) {}
  });
  ocrWin.on('closed', () => { ocrWin = null; });
  ocrWin.show();
}

async function runOcr(dataURL, lang) {
  const worker = await getOcrWorker(lang);
  const r = await worker.recognize(dataURL);
  return { ok: true, text: r && r.data ? r.data.text : '', confidence: r && r.data ? Math.round((r.data.confidence||0)) : 0, lang };
}

/* ============================================================
 *  托盘 / 全局快捷键 / 开机自启
 * ============================================================ */
function applyOpenAtLogin(on) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      openAsHidden: !!on,
      args: on ? ['--hidden'] : [],
    });
    settings.openAtLogin = !!on;
    saveSettings(settings);
  } catch (_) {}
}

function buildTrayMenu() {
  const focused = app.isPackaged ? '' : path.join(__dirname, '..', '..', 'resources');
  const m = Menu.buildFromTemplate([
    { label: '区域截图', accelerator: settings.captureKey, click: () => startCapture('tray') },
    { label: '长截图', accelerator: settings.scrollKey || 'CommandOrControl+Shift+S', click: () => startScrollCapture('tray') },
    { label: '录屏 GIF / MP4', accelerator: settings.recordKey, click: () => openRecorder() },
    { label: '贴图库', click: () => { pinWins.forEach(w => { try { w.show(); } catch (_) {} }); } },
    { type: 'separator' },
    { label: '显示主界面', click: () => { const w = getMainWindow(); if (w) { w.show(); w.focus(); } } },
    { label: '开机自启动', type: 'checkbox', checked: !!settings.openAtLogin, click: (mi) => applyOpenAtLogin(mi.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; try { app.quit(); } catch (_) {} process.exit(0); } },
  ]);
  return m;
}

function setupTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('截图工具');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => { const w = getMainWindow(); if (w) { w.show(); w.focus(); } });
  } catch (_) {}
}

function refreshTray() {
  if (tray) { try { tray.setContextMenu(buildTrayMenu()); } catch (_) {} }
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const bind = (acc, fn) => {
    try {
      const ok = globalShortcut.register(acc, fn);
      if (!ok) console.warn('[capture] 快捷键注册失败:', acc);
    } catch (e) { console.warn('[capture] 快捷键异常:', acc, e.message); }
  };
  bind(settings.captureKey, () => startCapture('shortcut'));
  bind(settings.pinKey, () => startCapture('pin')); // pin 复用区域截图，进入编辑器后默认贴图
  bind(settings.recordKey, () => openRecorder());
  bind(settings.ocrKey, () => openOcr());
  bind(settings.scrollKey || 'CommandOrControl+Shift+S', () => startScrollCapture('shortcut'));
}

/* ============================================================
 *  IPC 注册（在 app ready 后由 main.js 调用）
 * ============================================================ */
function registerIpc() {
  ipcMain.handle('capture:start', () => startCapture('main'));
  ipcMain.handle('capture:startFromRenderer', (e, source) => startCapture(source || 'main'));
  ipcMain.handle('capture:scroll', () => startScrollCapture('main'));
  ipcMain.on('capture:overlay-selected', (_e, payload) => onOverlaySelected(payload));
  ipcMain.on('capture:overlay-cancel', () => onOverlayCancel());
  ipcMain.on('capture:editor-action', (_e, payload) => onEditorAction(payload || {}));
  ipcMain.on('capture:editor-cancel', () => { if (editorWin) try { editorWin.close(); } catch (_) {} editorWin = null; });
  ipcMain.handle('capture:pin-close', (_e) => {});
  ipcMain.handle('capture:record-open', () => { openRecorder(); });
  ipcMain.handle('capture:settings', () => settings);
  ipcMain.handle('capture:set-setting', (_e, key, val) => {
    settings[key] = val;
    saveSettings(settings);
    refreshTray();
    return settings;
  });
  ipcMain.handle('capture:ocr', async (_e, dataURL, lang) => {
    try { return await runOcr(dataURL, lang); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('capture:record-save', async (_e, format, dataURL) => {
    try {
      const ffmpeg = getFfmpeg();
      if (!ffmpeg) throw new Error('未找到 ffmpeg');
      const tmpDir = path.join(DATA_DIR, 'tmp');
      try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
      const stamp = Date.now();
      const webmPath = path.join(tmpDir, `rec_${stamp}.webm`);
      const outPath = path.join(tmpDir, `rec_${stamp}.${format}`);
      // 解码 dataURL 写入 webm
      const m = /^data:video\/webm;base64,(.*)$/.exec(dataURL || '');
      if (!m) throw new Error('非 webm dataURL');
      fs.writeFileSync(webmPath, Buffer.from(m[1], 'base64'));
      // ffmpeg 转码
      const args = ['-y', '-i', webmPath];
      if (format === 'gif') args.push('-vf', 'fps=12,scale=-1:720:flags=lanczos', '-gifflags', '+transdiff', outPath);
      else if (format === 'webp') args.push('-c:v', 'libwebp', '-lossless', '0', '-q:v', '80', outPath);
      else args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outPath);
      await new Promise((res, rej) => {
        const p = spawn(ffmpeg, args, { windowsHide: true });
        let err = '';
        p.stderr.on('data', d => err += d);
        p.on('close', c => c === 0 ? res() : rej(new Error(err || `ffmpeg exit ${c}`)));
      });
      // 打开保存对话框
      const { dialog } = require('electron');
      const exts = { gif: [{ name: 'GIF', extensions: ['gif'] }], mp4: [{ name: 'MP4', extensions: ['mp4'] }], webp: [{ name: 'WebP', extensions: ['webp'] }] };
      const dlg = await dialog.showSaveDialog({ title: '保存录屏', defaultPath: `录屏_${stamp}.${format}`, filters: exts[format] || [] });
      if (!dlg.canceled && dlg.filePath) {
        fs.copyFileSync(outPath, dlg.filePath);
        try { require('electron').shell.showItemInFolder(dlg.filePath); } catch (_) {}
        return { ok: true, path: dlg.filePath };
      }
      return { ok: false, error: '用户取消' };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.on('capture:recorder-close', () => { if (recorderWin) { try { recorderWin.close(); } catch (_) {} recorderWin = null; } });
}

function init({ mainWindowGetter }) {
  if (mainWindowGetter) setMainWindowGetter(mainWindowGetter);
  ensureDirs();
  settings = loadSettings();
  registerIpc();
  setupTray();
  registerShortcuts();
  // --hidden：不显示主窗口，仅驻留托盘
  const hiddenStart = process.argv.includes('--hidden') || process.argv.includes('--capture-hidden');
  return { hiddenStart };
}

module.exports = { init, startCapture, openRecorder, openOcr, applyOpenAtLogin };
