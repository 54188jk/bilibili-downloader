/* ============================================================
 * BiliGrab · 渲染层
 * 视觉：macOS 侧边栏设计稿（1:1）
 * 功能：全部对接 window.api 真实能力（解析 / 下载 / 登录 / 音乐 / 影视 / UC）
 * ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);
const App = window.api;

/* ---------------- 全局状态 ---------------- */
const state = {
  saveDir: '',
  videoInfo: null,       // 当前 B 站视频（bvid/cid/title/pic/stat）
  cid: 0,
  qualities: [],
  selectedQn: 0,
  playUrl: '',
  dashInfo: null,
  tasks: new Map(),      // taskId -> { id, name, progress, status }
  biliItems: [],         // 批量解析结果
  biliCurrent: null,     // 当前选中的解析项
  dyItems: [],
  ksItems: [],
  ucData: null,
  movieEps: [],
  movieEpIndex: -1,
  movieTitle: '',
  loggedIn: false,
};

/* ---------------- 通用工具 ---------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function sanitizeFilename(name) {
  return String(name || 'video').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function formatNum(n) {
  n = Number(n) || 0;
  if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿';
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

let toastTimer = null;
function toast(text, type) {
  const t = $('toast');
  const dot = $('toastDot');
  $('toastText').textContent = text;
  dot.className = 'dot ' + (type === 'error' ? 'dot-err' : type === 'warn' ? 'dot-wait' : 'dot-ok');
  t.style.display = 'flex';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}

function showLoading(text) {
  const m = $('loadingMask');
  m.textContent = text || '处理中…';
  m.classList.remove('hidden');
}
function hideLoading() { $('loadingMask').classList.add('hidden'); }

function setDot(el, cls) { if (el) el.className = 'dot ' + cls; }

/* ---------------- 主题 ---------------- */
const THEME_KEY = 'biligrab.theme';
function applyTheme(mode) {
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark', dark);
}
function currentTheme() { return localStorage.getItem(THEME_KEY) || 'auto'; }
function setTheme(mode) {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme(mode);
  document.querySelectorAll('#themeSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === mode);
  });
}
applyTheme(currentTheme());
document.querySelectorAll('#themeSeg button').forEach((b) => {
  b.classList.toggle('active', b.dataset.theme === currentTheme());
  b.addEventListener('click', () => setTheme(b.dataset.theme));
});
$('themeBtn').addEventListener('click', () => {
  setTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
});
if (window.matchMedia('(prefers-color-scheme: dark)').addEventListener) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentTheme() === 'auto') applyTheme('auto');
  });
}

/* ---------------- 窗口控制 ---------------- */
$('winClose').addEventListener('click', () => App.windowClose());
$('winMin').addEventListener('click', () => App.windowMinimize());
$('winMax').addEventListener('click', () => App.windowToggleMax());

/* ---------------- 侧边栏视图切换 ---------------- */
function syncBrand(view) {
  const item = document.querySelector('.side-item[data-view="' + view + '"]');
  const mark = $('brandMark');
  const svg = item && item.querySelector('svg');
  if (mark && svg) {
    mark.innerHTML = svg.outerHTML;
    mark.title = '当前平台：' + item.textContent.trim();
  }
}
document.querySelectorAll('.side-item').forEach((it) => {
  it.addEventListener('click', () => {
    document.querySelectorAll('.side-item').forEach((x) => x.classList.remove('active'));
    it.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const target = $('view-' + it.dataset.view);
    if (target) target.classList.add('active');
    syncBrand(it.dataset.view);
    if (it.dataset.view === 'history') loadHistory();
    if (it.dataset.view === 'messages') loadMessages();
  });
});

/* ---------------- 开关（设置持久化） ---------------- */
const SWITCH_KEY = 'biligrab.switches';
(function loadSwitches() {
  let obj = {};
  try { obj = JSON.parse(localStorage.getItem(SWITCH_KEY) || '{}'); } catch (_) { obj = {}; }
  document.querySelectorAll('.switch[data-key]').forEach((el) => {
    const key = el.dataset.key;
    const def = el.classList.contains('on');
    const val = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : def;
    el.classList.toggle('on', !!val);
  });
})();
function switchOn(key) {
  const el = document.querySelector('.switch[data-key="' + key + '"]');
  return el ? el.classList.contains('on') : false;
}
document.querySelectorAll('.switch[data-key]').forEach((el) => {
  el.addEventListener('click', () => {
    el.classList.toggle('on');
    let obj = {};
    try { obj = JSON.parse(localStorage.getItem(SWITCH_KEY) || '{}'); } catch (_) { obj = {}; }
    obj[el.dataset.key] = el.classList.contains('on');
    localStorage.setItem(SWITCH_KEY, JSON.stringify(obj));
    if (el.dataset.key === 'lyrics' && App.desktopLyricsToggle) App.desktopLyricsToggle();
  });
});

/* ---------------- 登录态 ---------------- */
async function refreshAuth() {
  try {
    const r = await App.authStatus();
    const ok = r && r.ok && r.loggedIn;
    state.loggedIn = !!ok;
    const info = (r && (r.user || r.data)) || {};
    if (ok) {
      $('userName').textContent = info.uname || info.name || '已登录';
      $('userSub').textContent = (info.level ? 'LV' + info.level + ' · ' : '') + '已登录 B 站';
      if (info.face || info.avatar) $('userAvatar').src = String(info.face || info.avatar).replace(/^http:/, 'https:');
      $('logoutBtn').style.display = '';
      $('statusLogin').textContent = 'Cookie 已登录';
    } else {
      $('userName').textContent = '未登录';
      $('userSub').textContent = '点击登录 B 站解锁高画质';
      $('logoutBtn').style.display = 'none';
      $('statusLogin').textContent = '未登录';
    }
  } catch (_) { /* 忽略 */ }
}
$('userBox').addEventListener('click', async (e) => {
  if (e.target.closest('#logoutBtn')) return;
  if (state.loggedIn) return;
  showLoading('等待扫码登录…');
  const r = await App.login();
  hideLoading();
  if (r && r.ok) { toast('登录成功'); refreshAuth(); }
  else toast('登录失败：' + ((r && r.error) || '未知错误'), 'error');
});
$('logoutBtn').addEventListener('click', async () => {
  await App.logout();
  toast('已退出登录');
  refreshAuth();
});
$('openBiliBtn').addEventListener('click', () => App.openExternal('https://www.bilibili.com'));

/* ---------------- 保存目录 ---------------- */
function renderSaveDir() {
  $('saveDirDisplay').textContent = state.saveDir || '未选择（将使用默认目录）';
  $('setDirDisplay').textContent = state.saveDir || '—';
}
async function pickDir() {
  const d = await App.pickSaveDir();
  if (d) {
    state.saveDir = d;
    localStorage.setItem('biligrab.saveDir', d);
    renderSaveDir();
    toast('已选择保存目录');
  }
}
$('pickDirBtn').addEventListener('click', pickDir);
$('setDirBtn').addEventListener('click', pickDir);
$('openDirBtn').addEventListener('click', () => {
  if (state.saveDir) App.openPath(state.saveDir);
  else toast('请先选择保存目录', 'warn');
});

/* ---------------- 下载任务 ---------------- */
function createTaskEl(task) {
  const el = document.createElement('div');
  el.className = 'task-item';
  el.id = 'task-' + task.id;
  el.innerHTML = `
    <div class="task-ic dl"><svg class="ic-s" viewBox="0 0 14 14" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M4.5 8 7 10.5 9.5 8M7 10.5v-7"/></svg></div>
    <div class="task-main">
      <div class="task-name">${escapeHtml(task.name)}</div>
      <div class="task-bar"><div class="task-fill" style="width:0%"></div></div>
    </div>
    <span class="task-meta">0%</span>`;
  return el;
}
function addTask(task) {
  state.tasks.set(task.id, task);
  $('taskList').prepend(createTaskEl(task));
  updateStatus();
}
function updateTask(id, patch) {
  const t = state.tasks.get(id);
  if (!t) return;
  Object.assign(t, patch);
  const el = $('task-' + id);
  if (!el) return;
  const fill = el.querySelector('.task-fill');
  const ic = el.querySelector('.task-ic');
  const meta = el.querySelector('.task-meta');
  fill.style.width = (t.progress || 0) + '%';
  if (t.status === 'done') {
    ic.className = 'task-ic ok';
    fill.classList.add('ok');
    meta.textContent = '完成';
  } else if (t.status === 'error') {
    ic.className = 'task-ic err';
    fill.style.background = 'var(--err)';
    meta.textContent = '失败：' + (t.error || '未知错误');
  } else {
    meta.textContent = (t.progress || 0) + '%';
  }
  updateStatus();
}
function updateStatus() {
  let running = 0;
  state.tasks.forEach((t) => { if (t.status === 'running') running++; });
  $('statusQueue').textContent = '队列 ' + running;
  if (running > 0) {
    setDot($('statusDot'), 'dot-run');
    $('statusText').textContent = '下载中 · ' + running + ' 个任务';
  } else {
    setDot($('statusDot'), 'dot-ok');
    $('statusText').textContent = '就绪';
  }
}
$('clearTasksBtn').addEventListener('click', () => {
  let n = 0;
  state.tasks.forEach((t, id) => {
    if (t.status === 'done' || t.status === 'error') {
      const el = $('task-' + id);
      if (el) el.remove();
      state.tasks.delete(id);
      n++;
    }
  });
  updateStatus();
  toast(n ? '已清空 ' + n + ' 条任务' : '没有可清理的任务');
});

// 主进程下载进度回调
if (App.onDownloadProgress) {
  App.onDownloadProgress((d) => {
    if (!d || !d.taskId) return;
    updateTask(d.taskId, { progress: Math.min(100, Math.round(d.progress || 0)) });
  });
}

/* ============================================================
 * B 站
 * ============================================================ */
$('biliParseBtn').addEventListener('click', doBiliParse);
$('biliInput').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doBiliParse();
});

async function doBiliParse() {
  const text = $('biliInput').value.trim();
  if (!text) { toast('请先粘贴链接或 BV 号', 'error'); return; }
  showLoading('正在解析…');
  const r = await App.parseInput(text);
  hideLoading();
  if (!r.ok) { toast('解析失败：' + r.error, 'error'); return; }
  state.biliItems = (r.data || []).filter((x) => x.ok);
  const failed = (r.data || []).filter((x) => !x.ok);
  if (!state.biliItems.length) {
    toast('没有解析到可用内容' + (failed.length ? '：' + failed[0].error : ''), 'error');
    $('biliResults').innerHTML = '';
    return;
  }
  renderBiliResults();
  toast('解析成功 ' + state.biliItems.length + ' 项' + (failed.length ? '，失败 ' + failed.length + ' 项' : ''));
  selectBiliItem(state.biliItems[0], 0);
}

function renderBiliResults() {
  const box = $('biliResults');
  box.innerHTML = '';
  state.biliItems.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'task-item pick';
    row.dataset.idx = String(idx);
    const kindText = it.kind === 'image' ? '图片动态 ' + (it.count || 0) + ' 张'
      : it.kind === 'douyin' ? '抖音' : it.kind === 'kuaishou' ? '快手' : '视频';
    row.innerHTML = `
      <div class="task-ic dl"><svg class="ic-s" viewBox="0 0 14 14" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M4.5 8 7 10.5 9.5 8M7 10.5v-7"/></svg></div>
      <div class="task-main">
        <div class="task-name">${escapeHtml(it.title || it.id || '未命名')}</div>
        <div class="task-sub">${escapeHtml(kindText)} · ${escapeHtml(it.id || '')}</div>
      </div>
      <div class="task-act"><button class="mini-btn">选择</button></div>`;
    row.addEventListener('click', () => selectBiliItem(it, idx));
    box.appendChild(row);
  });
}

async function selectBiliItem(it, idx) {
  state.biliCurrent = it;
  document.querySelectorAll('#biliResults .task-item').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.idx) === idx);
  });

  // 抖音 / 快手：直链下载
  if (it.kind === 'douyin' || it.kind === 'kuaishou') {
    state.videoInfo = null;
    state.dashInfo = null;
    $('biliVideoCard').classList.remove('hidden');
    $('biliCover').src = it.cover || '';
    $('biliTitle').textContent = it.title || '未命名';
    $('biliAuthor').textContent = it.author || '未知作者';
    $('biliBvid').textContent = it.id || '';
    $('biliDuration').textContent = '';
    ['statView', 'statDanmaku', 'statLike', 'statCoin', 'statFav'].forEach((k) => { $(k).textContent = '-'; });
    $('biliQuality').innerHTML = '<button class="active" data-qn="0">原画质</button>';
    return;
  }

  // 图片动态
  if (it.kind === 'image') {
    state.videoInfo = null;
    state.dashInfo = null;
    $('biliVideoCard').classList.remove('hidden');
    $('biliCover').src = (it.images && it.images[0]) || '';
    $('biliTitle').textContent = it.title || '图片动态';
    $('biliAuthor').textContent = '图片动态';
    $('biliBvid').textContent = it.id || '';
    $('biliDuration').textContent = (it.count || 0) + ' 张';
    $('biliQuality').innerHTML = '<button class="active" data-qn="0">原图</button>';
    return;
  }

  // B 站视频：拉详情 + 画质
  showLoading('正在获取视频信息…');
  const pr = await App.parseVideo(it.bvid || it.id);
  hideLoading();
  if (!pr.ok) { toast('获取详情失败：' + pr.error, 'error'); return; }
  const d = pr.data;
  state.videoInfo = d;
  state.cid = d.cid;
  $('biliVideoCard').classList.remove('hidden');
  $('biliCover').src = d.pic ? String(d.pic).replace(/^http:/, 'https:') : '';
  $('biliDuration').textContent = d.durationStr || '';
  $('biliTitle').textContent = d.title || '未命名';
  $('biliAuthor').textContent = (d.owner && d.owner.name) || '未知 UP';
  $('biliBvid').textContent = d.bvid || '';
  const st = d.stat || {};
  $('statView').textContent = formatNum(st.view);
  $('statDanmaku').textContent = formatNum(st.danmaku);
  $('statLike').textContent = formatNum(st.like);
  $('statCoin').textContent = formatNum(st.coin);
  $('statFav').textContent = formatNum(st.favorite);
  await fetchQualities();
}

async function fetchQualities() {
  if (!state.videoInfo) return;
  showLoading('加载画质列表…');
  const qr = await App.getQualities({ bvid: state.videoInfo.bvid, cid: state.cid, qn: 120 });
  hideLoading();
  if (!qr.ok) { toast('画质拉取失败：' + qr.error, 'error'); return; }
  state.qualities = qr.data.qualities || [];
  state.selectedQn = qr.data.quality || 0;
  state.playUrl = qr.data.playUrl || '';
  state.dashInfo = qr.data.dash || null;
  renderQualities(qr.data);
  if (qr.data.segments && qr.data.segments.length > 1) {
    toast('该视频共 ' + qr.data.segments.length + ' 个分段，当前仅下载第一段', 'warn');
  }
}

function renderQualities(data) {
  const box = $('biliQuality');
  box.innerHTML = '';
  const list = data.qualities || [];
  if (!list.length) {
    box.innerHTML = '<button class="active" data-qn="0">默认画质</button>';
    return;
  }
  list.forEach((q) => {
    const b = document.createElement('button');
    b.dataset.qn = String(q.qn);
    b.textContent = q.label || ('qn=' + q.qn);
    if (q.current) b.classList.add('active');
    if (!data.isLogin && q.qn >= 112) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.title = '可能需要登录或大会员';
      lock.innerHTML = '<svg class="ic-s" viewBox="0 0 14 14" fill="none"><rect x="3" y="6" width="8" height="6" rx="1.2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.8 6V4.6a2.2 2.2 0 0 1 4.4 0V6" stroke="currentColor" stroke-linecap="round"/></svg>';
      b.appendChild(lock);
    }
    b.addEventListener('click', async () => {
      if (q.qn === state.selectedQn) { toast('当前已是 ' + (q.label || '该画质')); return; }
      showLoading('切换画质…');
      const r = await App.getQualities({ bvid: state.videoInfo.bvid, cid: state.cid, qn: q.qn });
      hideLoading();
      if (!r.ok) { toast('切换失败：' + r.error, 'error'); return; }
      state.selectedQn = r.data.quality || q.qn;
      state.playUrl = r.data.playUrl || '';
      state.dashInfo = r.data.dash || null;
      box.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      toast('已切换到 ' + (q.label || '该画质'));
    });
    box.appendChild(b);
  });
}

$('dlVideoBtn').addEventListener('click', () => startBiliDownload('video'));
$('dlAudioBtn').addEventListener('click', () => startBiliDownload('audio'));
$('dlVideoOnlyBtn').addEventListener('click', () => startBiliDownload('video-only'));

async function startBiliDownload(mode) {
  const it = state.biliCurrent;
  if (!it) { toast('请先解析内容', 'error'); return; }
  let saveDir = state.saveDir;
  if (!saveDir) saveDir = await App.getDefaultSaveDir();
  if (!saveDir) { toast('请先选择保存目录', 'error'); return; }

  // 抖音 / 快手直链
  if (it.kind === 'douyin' || it.kind === 'kuaishou') {
    const filename = sanitizeFilename(it.title || it.id) + '.mp4';
    const taskId = 'ds_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    addTask({ id: taskId, name: filename, progress: 0, status: 'running' });
    const r = await App.downloadStart({ url: it.videoUrl, filename, saveDir, referer: 'https://www.douyin.com/', taskId });
    if (!r.ok) { updateTask(taskId, { status: 'error', error: r.error }); toast('下载失败：' + r.error, 'error'); return; }
    updateTask(taskId, { progress: 100, status: 'done' });
    toast('下载完成：' + filename);
    if (switchOn('openAfter')) App.showInFolder(r.path);
    return;
  }

  // 图片动态
  if (it.kind === 'image') {
    const imgs = it.images || [];
    if (!imgs.length) { toast('该动态没有图片', 'error'); return; }
    const dir = App.pathJoin(saveDir, sanitizeFilename(it.title || '图片动态'));
    let ok = 0;
    for (let i = 0; i < imgs.length; i++) {
      const filename = sanitizeFilename((it.title || '图片') + '_' + (i + 1)) + '.jpg';
      const taskId = 'img_' + Date.now() + '_' + i;
      addTask({ id: taskId, name: filename, progress: 0, status: 'running' });
      const r = await App.downloadStart({ url: imgs[i], filename, saveDir: dir, referer: 'https://www.bilibili.com/', taskId });
      if (r.ok) { ok++; updateTask(taskId, { progress: 100, status: 'done' }); }
      else updateTask(taskId, { status: 'error', error: r.error });
    }
    toast('图片下载完成：成功 ' + ok + '/' + imgs.length + ' 张');
    return;
  }

  // B 站视频
  if (!state.videoInfo) { toast('请先解析视频', 'error'); return; }
  if (!state.playUrl && !state.dashInfo) { toast('当前画质没有可用链接，请重新解析', 'error'); return; }

  const safeTitle = sanitizeFilename(state.videoInfo.title);
  const ext = mode === 'audio' ? 'mp3' : 'mp4';
  const filename = safeTitle + '_' + state.selectedQn + '.' + ext;
  const tmpName = safeTitle + '_' + state.selectedQn + '_tmp.mp4';
  const taskId = 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const referer = 'https://www.bilibili.com/video/' + state.videoInfo.bvid;
  addTask({ id: taskId, name: filename, progress: 0, status: 'running' });

  try {
    let savedPath = null;
    if (mode === 'video') {
      if (state.dashInfo) {
        const info = await App.biliGetDashUrls({ bvid: state.videoInfo.bvid, cid: state.cid, qn: state.selectedQn });
        if (info && info.videoUrl && info.audioUrl) {
          const dl = await App.downloadDash({
            videoUrl: info.videoUrl, audioUrl: info.audioUrl,
            videoBackup: info.videoBackup, audioBackup: info.audioBackup,
            filename, saveDir, bvid: state.videoInfo.bvid, taskId,
          });
          if (!dl.ok) throw new Error(dl.error);
          savedPath = dl.path;
        }
      }
      if (!savedPath) {
        const dl = await App.downloadStart({ url: state.playUrl, filename, saveDir, referer, taskId });
        if (!dl.ok) throw new Error(dl.error);
        savedPath = dl.path;
      }
    } else if (mode === 'audio') {
      if (state.dashInfo && state.dashInfo.bestAudio) {
        const a = state.dashInfo.bestAudio;
        const url = (a.backupUrl || a.backup_url || [])[0] || a.baseUrl || '';
        const dl = await App.downloadStart({ url, filename, saveDir, referer, taskId });
        if (!dl.ok) throw new Error(dl.error);
        savedPath = dl.path;
      } else {
        const dl = await App.downloadStart({ url: state.playUrl, filename: tmpName, saveDir, referer, taskId });
        if (!dl.ok) throw new Error(dl.error);
        const r = await App.extractAudio({ inputPath: dl.path, outputName: filename, saveDir });
        if (!r.ok) throw new Error(r.error);
        savedPath = r.path;
        await App.fsDelete(dl.path);
      }
    } else {
      if (state.dashInfo) {
        const info = await App.biliGetDashUrls({ bvid: state.videoInfo.bvid, cid: state.cid, qn: state.selectedQn });
        if (info && info.videoUrl) {
          const dl = await App.downloadStart({ url: info.videoBackup || info.videoUrl, filename, saveDir, referer, taskId });
          if (!dl.ok) throw new Error(dl.error);
          savedPath = dl.path;
        }
      }
      if (!savedPath) {
        const dl = await App.downloadStart({ url: state.playUrl, filename: tmpName, saveDir, referer, taskId });
        if (!dl.ok) throw new Error(dl.error);
        const r = await App.extractVideo({ inputPath: dl.path, outputName: filename, saveDir });
        if (!r.ok) throw new Error(r.error);
        savedPath = r.path;
        await App.fsDelete(dl.path);
      }
    }

    if (!savedPath) throw new Error('未获取到下载路径');
    const st = await App.fsStat(savedPath);
    if (!st.ok || !st.exists || st.size < 1024) throw new Error('文件校验失败（可能下载不完整）');
    updateTask(taskId, { progress: 100, status: 'done' });
    toast('下载完成：' + filename);
    if (switchOn('openAfter')) App.showInFolder(savedPath);
  } catch (err) {
    updateTask(taskId, { status: 'error', error: err.message });
    toast('下载失败：' + err.message, 'error');
  }
}

/* ============================================================
 * 抖音 / 快手
 * ============================================================ */
function renderShortResults(box, items) {
  box.innerHTML = '';
  box._selected = 0;
  if (!items.length) { box.innerHTML = '<div class="empty-tip">暂无解析结果</div>'; return; }
  items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'task-item pick' + (idx === 0 ? ' active' : '');
    row.dataset.idx = String(idx);
    row.innerHTML = `
      <div class="task-ic ok"><svg class="ic-s" viewBox="0 0 14 14" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m3 7.5 2.5 2.5L11 4.5"/></svg></div>
      <div class="task-main">
        <div class="task-name">${escapeHtml(it.title || '未命名')}</div>
        <div class="task-sub">${escapeHtml(it.author || '')} · ${escapeHtml(it.id || '')}</div>
      </div>`;
    row.addEventListener('click', () => {
      box.querySelectorAll('.task-item').forEach((x) => x.classList.remove('active'));
      row.classList.add('active');
      box._selected = idx;
    });
    box.appendChild(row);
  });
}

$('dyParseBtn').addEventListener('click', async () => {
  const text = $('dyInput').value.trim();
  if (!text) { toast('请先粘贴抖音链接或口令', 'error'); return; }
  showLoading('正在解析抖音…');
  const r = await App.parseDouyin(text);
  hideLoading();
  if (!r.ok) { toast('解析失败：' + r.error, 'error'); return; }
  state.dyItems = (r.data || []).filter((x) => x.ok);
  renderShortResults($('dyResults'), state.dyItems);
  toast(state.dyItems.length ? '解析成功 ' + state.dyItems.length + ' 个' : '没有解析到可用内容', state.dyItems.length ? 'ok' : 'warn');
});

$('ksParseBtn').addEventListener('click', async () => {
  const text = $('ksInput').value.trim();
  if (!text) { toast('请先粘贴快手链接', 'error'); return; }
  showLoading('正在解析快手…');
  const r = await App.parseKuaishou(text);
  hideLoading();
  if (!r.ok) { toast('解析失败：' + r.error, 'error'); return; }
  state.ksItems = (r.data || []).filter((x) => x.ok);
  renderShortResults($('ksResults'), state.ksItems);
  toast(state.ksItems.length ? '解析成功 ' + state.ksItems.length + ' 个' : '没有解析到可用内容', state.ksItems.length ? 'ok' : 'warn');
});

async function downloadShort(items, box, mode) {
  if (!items.length) { toast('请先解析内容', 'error'); return; }
  let saveDir = state.saveDir;
  if (!saveDir) saveDir = await App.getDefaultSaveDir();
  if (!saveDir) { toast('请先选择保存目录', 'error'); return; }
  const it = items[box._selected || 0];
  if (!it) { toast('请选择一个解析结果', 'error'); return; }
  const filename = sanitizeFilename(it.title || it.id) + '.mp4';
  const taskId = 'short_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  addTask({ id: taskId, name: filename, progress: 0, status: 'running' });
  const r = await App.downloadStart({ url: it.videoUrl, filename, saveDir, referer: 'https://www.douyin.com/', taskId });
  if (!r.ok) { updateTask(taskId, { status: 'error', error: r.error }); toast('下载失败：' + r.error, 'error'); return; }
  if (mode === 'audio') {
    const out = sanitizeFilename(it.title || it.id) + '.mp3';
    const ex = await App.extractAudio({ inputPath: r.path, outputName: out, saveDir });
    await App.fsDelete(r.path);
    if (!ex.ok) { updateTask(taskId, { status: 'error', error: ex.error }); return; }
    updateTask(taskId, { progress: 100, status: 'done', name: out });
    toast('已提取音频：' + out);
    return;
  }
  updateTask(taskId, { progress: 100, status: 'done' });
  toast('下载完成：' + filename);
  if (switchOn('openAfter')) App.showInFolder(r.path);
}
$('dyDownloadBtn').addEventListener('click', () => downloadShort(state.dyItems, $('dyResults'), 'video'));
$('dyAudioBtn').addEventListener('click', () => downloadShort(state.dyItems, $('dyResults'), 'audio'));
$('ksDownloadBtn').addEventListener('click', () => downloadShort(state.ksItems, $('ksResults'), 'video'));

/* ============================================================
 * 音乐（网易云本地 API）
 * ============================================================ */
const audio = $('musicAudio');
const MUSIC = { list: [], index: -1, current: null };

async function musicApi(path, query) {
  try {
    const r = await App.musicApi(path, query || {});
    if (r && r.ok && r.data) return r.data;
    return null;
  } catch (_) { return null; }
}

function songCover(song) {
  const al = song.al || song.album || {};
  if (al.picUrl) return al.picUrl.replace(/^http:/, 'https:');
  if (al.pic) return 'https://p2.music.126.net/' + al.pic + '.jpg';
  if (song.picUrl) return song.picUrl.replace(/^http:/, 'https:');
  return '';
}
function songArtist(song) {
  return (song.artists || song.ar || []).map((a) => a.name).join(' / ') || '未知歌手';
}
function songAlbum(song) {
  const al = song.al || song.album || {};
  return al.name || '';
}

function renderSongs(songs) {
  const box = $('musicList');
  box.innerHTML = '';
  if (!songs.length) { box.innerHTML = '<div class="empty-tip">没有搜索结果</div>'; return; }
  songs.forEach((song, idx) => {
    const row = document.createElement('div');
    row.className = 'song-row';
    const cover = songCover(song);
    row.innerHTML = `
      ${cover ? '<img class="song-thumb" src="' + escapeHtml(cover) + '" alt="">' : '<div class="song-thumb" style="background:var(--control-bg)"></div>'}
      <div class="song-main">
        <div class="song-name">${escapeHtml(song.name || '未知歌曲')}</div>
        <div class="song-artist">${escapeHtml(songArtist(song))}${songAlbum(song) ? ' · ' + escapeHtml(songAlbum(song)) : ''}</div>
      </div>
      <span class="song-dur">${song.dt ? fmtTime(song.dt / 1000) : (song.duration ? fmtTime(song.duration / 1000) : '--:--')}</span>`;
    row.addEventListener('click', () => playSong(song, idx));
    row.addEventListener('dblclick', () => downloadSong(song));
    box.appendChild(row);
  });
  $('musicCount').textContent = '共 ' + songs.length + ' 首';
}

$('musicSearchBtn').addEventListener('click', doMusicSearch);
$('musicSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMusicSearch(); });

async function doMusicSearch() {
  const kw = $('musicSearchInput').value.trim();
  if (!kw) { toast('请输入搜索关键词', 'error'); return; }
  if (!(await ensureMusicApi())) { toast('本地音乐 API 启动失败', 'error'); return; }
  showLoading('正在搜索音乐…');
  const data = await musicApi('/cloudsearch', { keywords: kw, limit: 30 });
  hideLoading();
  const songs = (data && data.result && data.result.songs) || [];
  if (!songs.length) { toast('没有搜索结果', 'warn'); return; }
  MUSIC.list = songs;
  MUSIC.index = -1;
  renderSongs(songs);
  toast('搜索到 ' + songs.length + ' 首');
}

async function ensureMusicApi() {
  try {
    const st = await App.musicStatus();
    if (st && st.ok && st.running) {
      setDot($('musicDot'), 'dot-ok');
      $('musicApiText').textContent = '本地 API 就绪';
      return true;
    }
    showLoading('正在启动本地音乐 API…');
    const r = await App.musicStart();
    hideLoading();
    if (r && r.ok) {
      setDot($('musicDot'), 'dot-ok');
      $('musicApiText').textContent = '本地 API 就绪';
      return true;
    }
  } catch (_) { /* 忽略 */ }
  setDot($('musicDot'), 'dot-err');
  $('musicApiText').textContent = '音乐 API 启动失败';
  return false;
}

async function fetchSongUrl(id) {
  const d = await musicApi('/song/url/v1', { id, level: 'standard' });
  const t = d && d.data && d.data[0];
  let url = (t && t.url) || '';
  if (!url) {
    const d2 = await musicApi('/song/url/v1', { id, level: 'exhigh' });
    const t2 = d2 && d2.data && d2.data[0];
    if (t2 && t2.url) url = t2.url;
  }
  return url;
}

async function playSong(song, idx) {
  if (idx != null) MUSIC.index = idx;
  MUSIC.current = song;
  const cover = songCover(song);
  if (cover) $('musicCover').src = cover;
  $('musicName').textContent = song.name || '未知歌曲';
  $('musicSub').textContent = songArtist(song) + (songAlbum(song) ? ' · ' + songAlbum(song) : '');
  $('musicDur').textContent = song.dt ? fmtTime(song.dt / 1000) : '--:--';
  updateGlobalPlayer('music', { name: song.name, sub: songArtist(song), cover });
  document.querySelectorAll('#musicList .song-row').forEach((el, i) => el.classList.toggle('playing', i === MUSIC.index));

  showLoading('获取播放地址…');
  const url = await fetchSongUrl(song.id);
  hideLoading();
  if (!url) { toast('该歌曲暂无播放地址（可能需要 VIP）', 'error'); return; }
  audio.src = url;
  audio.volume = Number($('musicVol').value) / 100;
  try { await audio.play(); } catch (e) { toast('播放失败：' + e.message, 'error'); return; }
  $('musicPP').checked = true;
  $('gpPP').checked = true;
  if (switchOn('lyrics')) loadLyrics(song.id);
}

async function loadLyrics(id) {
  try {
    const d = await musicApi('/lyric', { id });
    const lrc = d && d.lrc && d.lrc.lyric;
    if (!lrc) return;
    const opened = await App.desktopLyricsIsOpen();
    if (!opened || !opened.open) await App.desktopLyricsOpen();
    App.desktopLyricsLoad({ title: MUSIC.current ? MUSIC.current.name : '', lrc });
  } catch (_) { /* 忽略 */ }
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const p = audio.currentTime / audio.duration * 100;
  $('musicFill').style.width = p + '%';
  $('musicThumb').style.left = p + '%';
  $('musicCur').textContent = fmtTime(audio.currentTime);
  $('musicDur').textContent = fmtTime(audio.duration);
  $('gpFill').style.width = p + '%';
  $('gpThumb').style.left = p + '%';
  $('gpCur').textContent = fmtTime(audio.currentTime);
  $('gpDur').textContent = fmtTime(audio.duration);
  if (switchOn('lyrics')) {
    try { App.desktopLyricsTick({ time: audio.currentTime }); } catch (_) {}
  }
});
audio.addEventListener('ended', () => {
  if (MUSIC.index >= 0 && MUSIC.index < MUSIC.list.length - 1) playSong(MUSIC.list[MUSIC.index + 1], MUSIC.index + 1);
  else { $('musicPP').checked = false; $('gpPP').checked = false; }
});

function togglePlay(play) {
  $('musicPP').checked = play;
  $('gpPP').checked = play;
  if (play) {
    if (audio.src) audio.play().catch(() => {});
    else if (MUSIC.current) playSong(MUSIC.current, MUSIC.index);
  } else {
    audio.pause();
  }
}
$('musicPP').addEventListener('change', () => togglePlay($('musicPP').checked));
$('gpPP').addEventListener('change', () => togglePlay($('gpPP').checked));
function musicStep(step) {
  const next = MUSIC.index + step;
  if (next >= 0 && next < MUSIC.list.length) playSong(MUSIC.list[next], next);
}
$('musicPrev').addEventListener('click', () => musicStep(-1));
$('gpPrev').addEventListener('click', () => musicStep(-1));
$('musicNext').addEventListener('click', () => musicStep(1));
$('gpNext').addEventListener('click', () => musicStep(1));
$('musicVol').addEventListener('input', () => { audio.volume = Number($('musicVol').value) / 100; });

async function downloadSong(song) {
  let saveDir = state.saveDir;
  if (!saveDir) saveDir = await App.getDefaultSaveDir();
  if (!saveDir) { toast('请先选择保存目录', 'error'); return; }
  const s = song || MUSIC.current;
  if (!s) { toast('请先选择歌曲（双击歌曲行可直接下载）', 'error'); return; }
  const filename = sanitizeFilename((s.name || '未知') + ' - ' + songArtist(s)) + '.mp3';
  const taskId = 'mus_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  addTask({ id: taskId, name: filename, progress: 0, status: 'running' });
  const url = await fetchSongUrl(s.id);
  if (!url) { updateTask(taskId, { status: 'error', error: '无播放地址' }); toast('该歌曲暂无下载源', 'error'); return; }
  const r = await App.musicDownload({ url, filename, saveDir });
  if (!r.ok) { updateTask(taskId, { status: 'error', error: r.error }); toast('下载失败：' + r.error, 'error'); return; }
  updateTask(taskId, { progress: 100, status: 'done' });
  toast('下载完成：' + filename);
  if (switchOn('openAfter')) App.showInFolder(r.path);
}
$('musicDownloadBtn').addEventListener('click', () => downloadSong(null));

$('musicHotBtn').addEventListener('click', async () => {
  if (!(await ensureMusicApi())) return;
  const d = await musicApi('/personalized', { limit: 18 });
  renderPlaylists((d && d.result) || []);
});
$('musicPlaylistBtn').addEventListener('click', async () => {
  if (!(await ensureMusicApi())) return;
  const st = await musicApi('/login/status');
  const uid = st && st.data && st.data.profile && st.data.profile.userId;
  if (!uid) { toast('请先扫码登录网易云', 'warn'); return; }
  const d = await musicApi('/user/playlist', { uid, limit: 30 });
  renderPlaylists((d && d.playlist) || []);
});
$('musicImportBtn').addEventListener('click', async () => {
  const id = prompt('请输入网易云歌单 ID（分享链接中的 id 参数）：');
  if (!id) return;
  if (!(await ensureMusicApi())) return;
  const d = await musicApi('/playlist/detail', { id: id.trim() });
  const pl = d && d.playlist;
  if (!pl) { toast('歌单不存在或无法访问', 'error'); return; }
  MUSIC.list = pl.tracks || [];
  MUSIC.index = -1;
  renderSongs(MUSIC.list);
  toast('已导入：' + (pl.name || ''));
});
$('musicLoginBtn').addEventListener('click', async () => {
  if (!(await ensureMusicApi())) return;
  toast('请在新窗口中完成网易云扫码登录');
  const st = await musicApi('/login/status');
  toast(st && st.data && st.data.profile ? '已登录：' + st.data.profile.nickname : '登录页已打开，完成后重试');
});

function renderPlaylists(list) {
  const box = $('musicList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty-tip">没有获取到歌单</div>'; return; }
  list.forEach((pl) => {
    const row = document.createElement('div');
    row.className = 'song-row';
    const cover = pl.coverImgUrl ? String(pl.coverImgUrl).replace(/^http:/, 'https:') : '';
    row.innerHTML = `
      ${cover ? '<img class="song-thumb" src="' + escapeHtml(cover) + '" alt="">' : '<div class="song-thumb" style="background:var(--control-bg)"></div>'}
      <div class="song-main">
        <div class="song-name">${escapeHtml(pl.name || '未命名歌单')}</div>
        <div class="song-artist">${pl.trackCount != null ? pl.trackCount + ' 首' : ''}</div>
      </div>`;
    row.addEventListener('click', async () => {
      showLoading('加载歌单…');
      const d = await musicApi('/playlist/detail', { id: pl.id });
      hideLoading();
      const songs = (d && d.playlist && d.playlist.tracks) || [];
      if (!songs.length) { toast('歌单为空', 'warn'); return; }
      MUSIC.list = songs;
      MUSIC.index = -1;
      renderSongs(songs);
      toast('已加载歌单：' + (pl.name || ''));
    });
    box.appendChild(row);
  });
  $('musicCount').textContent = '共 ' + list.length + ' 个歌单';
}

$('lyricsBtn').addEventListener('click', async () => {
  const r = await App.desktopLyricsToggle();
  toast(r && r.open ? '桌面歌词已开启' : '桌面歌词已关闭');
});

/* ============================================================
 * 影视
 * ============================================================ */
const MOVIE_BASE_PRESETS = [
  'https://bfzyapi.com/App.php/provide/vod',
  'https://App.guangsuapi.com/App.php/provide/vod',
  'https://jszyapi.com/App.php/provide/vod',
  'https://jyzyapi.com/provide/vod/',
  'https://cj.ffzyapi.com/App.php/provide/vod',
  'https://App.apibdzy.com/App.php/provide/vod',
  'https://vip.mtime.cn/App.php/provide/vod',
];
const MOVIE_PARSER_PRESETS = [
  'https://video.isyour.love/player/getplayer?url=',
  'https://yparse.ik9.cc/index.php?url=',
  'https://jx.m3u8.pw/?url=',
  'https://jx.xmflv.cc/?url=',
  'https://www.playm3u8.cn/jiexi.php?url=',
];
function movieBase() { return localStorage.getItem('movieBase') || MOVIE_BASE_PRESETS[0]; }
function movieParser() { return localStorage.getItem('movieParser') || MOVIE_PARSER_PRESETS[0]; }

function parseVodPlayUrl(str) {
  if (!str) return [];
  const out = [];
  String(str).split('#').forEach((g) => {
    if (!g) return;
    const i = g.lastIndexOf('$');
    let name = g, url = g;
    if (i >= 0) { name = g.slice(0, i); url = g.slice(i + 1); }
    if (url) out.push({ name: name || ('第' + (out.length + 1) + '集'), url: url.trim() });
  });
  return out;
}

$('movieSearchBtn').addEventListener('click', doMovieSearch);
$('movieSearchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doMovieSearch(); });

async function doMovieSearch() {
  const kw = $('movieSearchInput').value.trim();
  if (!kw) { toast('请输入影视名称', 'error'); return; }
  showLoading('正在搜索片源…');
  let list = [], usedBase = '';
  const bases = [movieBase()].concat(MOVIE_BASE_PRESETS.filter((b) => b !== movieBase()));
  for (const base of bases) {
    try {
      const r = await App.movieSearch(base, kw, 1, 6000);
      if (r && r.ok && r.data && r.data.list && r.data.list.length) {
        list = r.data.list;
        usedBase = base;
        break;
      }
    } catch (_) { /* 换下一个源 */ }
  }
  hideLoading();
  if (!list.length) {
    toast('没有找到相关影视', 'warn');
    $('movieGrid').innerHTML = '';
    $('movieCount').textContent = '共 0 部';
    return;
  }
  localStorage.setItem('movieBase', usedBase);
  $('movieCount').textContent = '共 ' + list.length + ' 部';
  const grid = $('movieGrid');
  grid.innerHTML = '';
  list.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'movie-card';
    const pic = String(it.vod_pic || '').replace(/^http:/, 'https:');
    card.innerHTML = `
      <div class="movie-poster">
        ${pic ? '<img src="' + escapeHtml(pic) + '" alt="" loading="lazy">' : ''}
        ${it.vod_class ? '<span class="tag">' + escapeHtml(it.vod_class) + '</span>' : ''}
      </div>
      <div class="movie-info">
        <div class="movie-name">${escapeHtml(it.vod_name || '未知')}</div>
        <div class="movie-sub">${escapeHtml([it.vod_year, it.vod_remarks].filter(Boolean).join(' · '))}</div>
      </div>`;
    card.addEventListener('click', () => openMovieDetail(it, usedBase));
    grid.appendChild(card);
  });
}

async function openMovieDetail(item, base) {
  showLoading('加载播放信息…');
  const r = await App.movieDetail(base || movieBase(), item.vod_id);
  hideLoading();
  if (!r.ok) { toast('详情获取失败：' + r.error, 'error'); return; }
  const d = r.data;
  state.movieTitle = d.vod_name || '';
  const pic = String(d.vod_pic || '').replace(/^http:/, 'https:');
  if (pic) $('movieCover').src = pic;
  $('movieName').textContent = d.vod_name || '未知';
  $('movieSub').textContent = [d.vod_year, d.vod_remarks, d.vod_area].filter(Boolean).join(' · ');

  // 多线路：选集数最多的一条
  const playUrls = String(d.vod_play_url || '').split('$$$');
  const sourceNames = String(d.vod_play_from || '').split('$$$');
  let eps = [], bestIdx = 0;
  playUrls.forEach((g, idx) => {
    const parsed = parseVodPlayUrl(g);
    if (parsed.length > eps.length) { eps = parsed; bestIdx = idx; }
  });
  $('movieStatus').textContent = (sourceNames[bestIdx] ? sourceNames[bestIdx] + ' · ' : '') + '共 ' + eps.length + ' 集';
  setDot($('movieDot'), 'dot-run');

  const sel = $('movieLine');
  sel.innerHTML = '';
  playUrls.forEach((g, idx) => {
    const o = document.createElement('option');
    o.value = String(idx);
    o.textContent = (sourceNames[idx] || ('线路' + (idx + 1))) + '（' + parseVodPlayUrl(g).length + ' 集）';
    sel.appendChild(o);
  });
  sel.value = String(bestIdx);
  sel.onchange = () => renderEpisodes(parseVodPlayUrl(playUrls[Number(sel.value)] || ''));

  renderEpisodes(eps);
}

function renderEpisodes(eps) {
  state.movieEps = eps || [];
  const epBox = $('movieEpisodes');
  epBox.innerHTML = '';
  state.movieEps.forEach((ep, idx) => {
    const b = document.createElement('button');
    b.className = 'ep-chip';
    b.textContent = ep.name;
    b.addEventListener('click', () => playMovieEp(idx));
    epBox.appendChild(b);
  });
  if (state.movieEps.length) playMovieEp(0);
}

function isDirectMediaUrl(u) {
  return !!u && /^https?:\/\//i.test(u) && /(\.m3u8(\?|$)|\.mp4(\?|$)|\.flv(\?|$))/i.test(u);
}

async function playMovieEp(idx) {
  const ep = state.movieEps[idx];
  if (!ep) return;
  state.movieEpIndex = idx;
  document.querySelectorAll('#movieEpisodes .ep-chip').forEach((b, i) => b.classList.toggle('active', i === idx));
  $('movieSub').textContent = state.movieTitle + ' · ' + ep.name;
  $('movieStage').classList.remove('hidden');
  updateGlobalPlayer('movie', { name: state.movieTitle + ' · ' + ep.name, sub: '在线播放', cover: $('movieCover').src });
  startMovieProbe();

  if (isDirectMediaUrl(ep.url)) { await playDirect(ep.url); return; }
  try {
    const r = await App.movieServerApi('/api/resolve', { url: ep.url });
    if (r && r.ok && r.data && r.data.code === 0 && r.data.url && /\.(m3u8|mp4)(\?|$)/i.test(r.data.url)) {
      await playDirect(r.data.url);
      return;
    }
  } catch (_) { /* 走解析器 */ }

  const parser = movieParser();
  const sep = parser.includes('?') ? (parser.endsWith('=') ? '' : '&') : '?';
  $('moviePlayer').src = parser + sep + encodeURIComponent(ep.url);
  try { App.movieSetReferer(parser); } catch (_) {}
}

async function playDirect(url) {
  try {
    const sv = await App.movieServerStatus();
    const port = (sv && sv.ok && sv.port) ? sv.port : 3928;
    $('moviePlayer').src = 'http://127.0.0.1:' + port + '/player.html?url=' + encodeURIComponent(url);
  } catch (_) {
    $('moviePlayer').src = url;
  }
}

// 播放进度探测（iframe 跨域，由主进程执行脚本探测）
let movieProbeTimer = null;
function startMovieProbe() {
  if (movieProbeTimer) return;
  movieProbeTimer = setInterval(async () => {
    try {
      const p = await App.movieProbe();
      if (!p || !p.found || !p.duration) return;
      const pct = Math.min(100, p.currentTime / p.duration * 100);
      $('movieFill').style.width = pct + '%';
      $('movieThumb').style.left = pct + '%';
      $('movieCur').textContent = fmtTime(p.currentTime);
      $('movieDur').textContent = fmtTime(p.duration);
      $('gpFill').style.width = pct + '%';
      $('gpThumb').style.left = pct + '%';
    } catch (_) { /* 忽略 */ }
  }, 1000);
}

$('moviePP').addEventListener('change', () => {
  const want = $('moviePP').checked;
  $('gpPP').checked = want;
  toast(want ? '若未自动播放，请点击画面内的播放按钮' : '解析页受跨域限制，暂停请用画面内按钮');
});
$('movieBack').addEventListener('click', async () => {
  const p = await App.movieProbe();
  if (p && p.found) await App.movieSeek(Math.max(0, p.currentTime - 10));
  toast('已后退 10 秒');
});
$('movieForward').addEventListener('click', async () => {
  const p = await App.movieProbe();
  if (p && p.found) await App.movieSeek(p.currentTime + 10);
  toast('已前进 10 秒');
});
$('movieDownloadBtn').addEventListener('click', async () => {
  const ep = state.movieEps[state.movieEpIndex];
  if (!ep) { toast('请先选择要下载的剧集', 'error'); return; }
  let saveDir = state.saveDir;
  if (!saveDir) saveDir = await App.getDefaultSaveDir();
  if (!saveDir) { toast('请先选择保存目录', 'error'); return; }
  const filename = sanitizeFilename(state.movieTitle || '影视') + ' - ' + sanitizeFilename(ep.name) + '.mp4';
  const taskId = 'mov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  addTask({ id: taskId, name: filename, progress: 0, status: 'running' });
  const r = await App.movieDownloadEpisode({ url: ep.url, filename, saveDir, referer: movieParser(), taskId });
  if (!r.ok) { updateTask(taskId, { status: 'error', error: r.error }); toast('下载失败：' + r.error, 'error'); return; }
  updateTask(taskId, { progress: 100, status: 'done' });
  toast('下载完成：' + filename);
  if (switchOn('openAfter')) App.showInFolder(r.path);
});

/* ============================================================
 * UC 网盘
 * ============================================================ */
$('ucParseBtn').addEventListener('click', async () => {
  const url = $('ucInput').value.trim();
  if (!url) { toast('请先粘贴 UC 分享链接', 'error'); return; }
  showLoading('正在解析 UC 分享…');
  const r = await App.parseUc(url);
  hideLoading();
  if (!r.ok) { toast('解析失败：' + r.error, 'error'); return; }
  state.ucData = r.data;
  renderUcFiles(r.data);
});

function renderUcFiles(data) {
  const box = $('ucFiles');
  box.innerHTML = '';
  const files = (data && data.files) || [];
  const nick = (data && (data.nickName || data.nick_name)) || '未知分享者';
  $('ucMeta').textContent = '共 ' + files.length + ' 个 · 分享者：' + nick;
  if (!files.length) { box.innerHTML = '<div class="empty-tip">没有检测到文件</div>'; return; }
  const total = files.reduce((s, f) => s + (Number(f.size) || 0), 0);
  files.forEach((f) => {
    const isVideo = /^(mp4|mkv|avi|mov|flv|rmvb|wmv|m3u8)$/i.test(f.format || '');
    const row = document.createElement('div');
    row.className = 'uc-item';
    row.innerHTML = `
      <div class="uc-badge ${isVideo ? 'video' : 'zip'}">${escapeHtml(String(f.format || (isVideo ? '视频' : '文件')).slice(0, 4))}</div>
      <div class="uc-name">${escapeHtml(f.name || '未命名')}</div>
      <span class="uc-size">${formatSize(f.size)}</span>
      <button class="uc-dl"><svg class="ic-s" viewBox="0 0 14 14" fill="none"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M4.5 8 7 10.5 9.5 8M7 10.5v-7"/></svg>下载</button>`;
    row.querySelector('.uc-dl').addEventListener('click', () => downloadUcFile(f));
    box.appendChild(row);
  });
  updateGlobalPlayer('uc', {
    name: (files[0] && files[0].name) || 'UC 分享',
    sub: files.length + ' 个文件 · ' + formatSize(total),
  });
}

async function downloadUcFile(f) {
  const shareUrl = (f && f.shareUrl) || (state.ucData && state.ucData.shareUrl) || $('ucInput').value.trim();
  if (!shareUrl) { toast('请先解析分享链接', 'error'); return; }
  toast('UC 网盘需在浏览器中下载，已为你打开分享页');
  await App.openUcShare(shareUrl);
}
$('ucDownloadAllBtn').addEventListener('click', async () => {
  const shareUrl = (state.ucData && state.ucData.shareUrl) || $('ucInput').value.trim();
  if (!shareUrl) { toast('请先解析分享链接', 'error'); return; }
  await App.openUcShare(shareUrl);
  toast('已打开分享页，请在浏览器中下载');
});
$('ucOpenBtn').addEventListener('click', async () => {
  const shareUrl = (state.ucData && state.ucData.shareUrl) || $('ucInput').value.trim();
  if (!shareUrl) { toast('请先粘贴分享链接', 'error'); return; }
  await App.openUcShare(shareUrl);
});

/* ============================================================
 * 下载历史
 * ============================================================ */
async function loadHistory() {
  const list = await App.historyList();
  const box = $('historyList');
  box.innerHTML = '';
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) {
    box.innerHTML = '<div class="empty-tip">暂无下载记录</div>';
    $('historySub').textContent = '最近下载的文件';
    return;
  }
  let total = 0;
  arr.slice().reverse().forEach((it) => {
    total += Number(it.size) || 0;
    const row = document.createElement('div');
    row.className = 'hist-item';
    row.innerHTML = `
      <div class="hist-thumb"></div>
      <div class="hist-main">
        <div class="hist-name">${escapeHtml(it.title || it.filename || '未命名')}</div>
        <div class="hist-sub">${escapeHtml(it.kind || '')}${it.time ? ' · ' + escapeHtml(new Date(it.time).toLocaleString()) : ''}</div>
      </div>
      <span class="hist-size">${formatSize(it.size)}</span>`;
    if (it.dir && it.filename) {
      row.style.cursor = 'pointer';
      row.title = '点击在文件夹中显示';
      row.addEventListener('click', () => App.showInFolder(App.pathJoin(it.dir, it.filename)));
    }
    box.appendChild(row);
  });
  $('historySub').textContent = '共 ' + arr.length + ' 个文件 · 已用 ' + formatSize(total);
}
$('historyClearBtn').addEventListener('click', async () => {
  await App.historyClear();
  toast('已清空下载历史');
  loadHistory();
});

/* ============================================================
 * 全局播放栏 / 进度拖动
 * ============================================================ */
function updateGlobalPlayer(kind, d) {
  document.querySelectorAll('.gp-tab').forEach((t) => t.classList.toggle('active', t.dataset.gp === kind));
  $('gpName').textContent = d.name || '—';
  $('gpSub').textContent = d.sub || '';
  $('gpTag').textContent = kind === 'music' ? '音乐' : kind === 'movie' ? '影视' : 'UC';
  if (d.cover) $('gpCover').src = d.cover;
  $('gpFill').className = 'p-fill ' + (kind === 'music' ? 'pink' : 'blue');
}
document.querySelectorAll('.gp-tab').forEach((t) => {
  t.addEventListener('click', () => {
    const kind = t.dataset.gp;
    document.querySelectorAll('.gp-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    const side = document.querySelector('.side-item[data-view="' + kind + '"]');
    if (side) side.click();
  });
});
$('gpClose').addEventListener('click', () => {
  const gp = document.querySelector('.global-player');
  gp.style.display = gp.style.display === 'none' ? 'flex' : 'none';
});

function bindScrub(bar, onSeek) {
  if (!bar || bar._bound) return;
  bar._bound = true;
  const fill = bar.querySelector('.p-fill');
  const thumb = bar.querySelector('.p-thumb');
  const bubble = bar.querySelector('.p-bubble');
  const pctOf = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100));
  };
  bar.addEventListener('pointerdown', (e) => { bar.classList.add('dragging'); bar.setPointerCapture(e.pointerId); });
  bar.addEventListener('pointermove', (e) => {
    const p = pctOf(e);
    if (bar.classList.contains('dragging')) { fill.style.width = p + '%'; thumb.style.left = p + '%'; }
  });
  bar.addEventListener('pointerup', (e) => {
    if (!bar.classList.contains('dragging')) return;
    bar.classList.remove('dragging');
    onSeek(pctOf(e));
  });
  bar.addEventListener('pointercancel', () => bar.classList.remove('dragging'));
  if (bubble) {
    bar.addEventListener('pointermove', (e) => {
      const p = pctOf(e);
      bubble.style.left = p + '%';
    });
  }
}
bindScrub($('musicProgress'), (p) => { if (audio.duration) audio.currentTime = audio.duration * p / 100; });
bindScrub($('movieProgress'), async (p) => {
  const st = await App.movieProbe();
  if (st && st.found && st.duration) await App.movieSeek(st.duration * p / 100);
});
bindScrub($('gpProgress'), (p) => { if (audio.duration) audio.currentTime = audio.duration * p / 100; });

/* ============================================================
 * 初始化
 * ============================================================ */
$('tutorialBtn').addEventListener('click', () => App.openTutorial());

(async function init() {
  try {
    const v = await App.getAppVersion();
    if (v) { $('appVersion').textContent = 'v' + v; $('setVersion').textContent = 'v' + v; }
  } catch (_) {}

  const saved = localStorage.getItem('biligrab.saveDir');
  if (saved) {
    state.saveDir = saved;
  } else {
    try {
      const d = await App.getDefaultSaveDir();
      if (d) state.saveDir = d;
    } catch (_) {}
  }
  renderSaveDir();

  try {
    const f = await App.checkFfmpeg();
    if (f && f.ok) {
      setDot($('ffmpegDot'), 'dot-ok');
      $('ffmpegText').textContent = 'ffmpeg 就绪';
      setDot($('sideDot'), 'dot-ok');
      $('sideFootText').textContent = 'ffmpeg 就绪 · 可正常下载';
    } else {
      setDot($('ffmpegDot'), 'dot-err');
      $('ffmpegText').textContent = '未检测到 ffmpeg';
      $('sideFootText').textContent = '缺少 ffmpeg';
    }
  } catch (_) {}

  await refreshAuth();
  updateStatus();
  syncBrand('bili');
})();

/* ============================================================
 * 智能助手对话（密钥只在主进程；渲染层只发送对话内容、接收回复）
 * ============================================================ */
let aiMessages = [];
let currentModelId = 'auto';   // 'auto'（内置托管模型）或自定义模型 id
let aiBusy = false;

function aiEl(id) { return document.getElementById(id); }

function renderCustomModels(list) {
  const g = aiEl('customGroup'), listBox = aiEl('modelsCustomList');
  g.innerHTML = ''; listBox.innerHTML = '';
  if (!list || !list.length) {
    g.innerHTML = '<div class="mm-empty">暂无自定义模型<br>点击下方添加你自己的模型</div>';
    return;
  }
  list.forEach((m) => {
    const opt = document.createElement('button');
    opt.className = 'mm-opt'; opt.dataset.type = 'custom'; opt.dataset.id = m.id; opt.dataset.name = m.name;
    opt.innerHTML = '<span class="mm-ic"><svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z"/></svg></span>'
      + '<span class="mm-main"><span class="mm-name">' + escapeHtml(m.name) + '</span><span class="mm-sub">' + escapeHtml(m.model) + ' · ' + escapeHtml(m.base) + '</span></span>'
      + '<span class="mm-check"><svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></span>';
    opt.addEventListener('click', () => selectModel(opt));
    g.appendChild(opt);

    const row = document.createElement('div'); row.className = 'mm-row';
    row.innerHTML = '<span class="mm-ic"><svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z"/></svg></span>'
      + '<div class="mm-main"><div class="mm-name">' + escapeHtml(m.name) + ' <span class="mm-tag cust">自定义</span></div><div class="mm-sub">' + escapeHtml(m.model) + ' · ' + escapeHtml(m.base) + '</div></div>';
    const del = document.createElement('button'); del.className = 'mini-btn';
    del.innerHTML = '<svg class="ic-s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> 删除';
    del.addEventListener('click', () => deleteCustomModel(m.id));
    row.appendChild(del);
    listBox.appendChild(row);
  });
}

async function loadCustomModels() {
  try {
    const list = await App.aiModelsGet();
    renderCustomModels(Array.isArray(list) ? list : []);
  } catch (_) { renderCustomModels([]); }
}

function selectModel(btn) {
  document.querySelectorAll('.mm-opt').forEach((x) => x.classList.remove('active'));
  btn.classList.add('active');
  const name = btn.dataset.name;
  aiEl('currentModel').textContent = name;
  const sb = aiEl('sbModel'); if (sb) sb.textContent = name;
  currentModelId = (btn.dataset.type === 'builtin') ? 'auto' : (btn.dataset.id || 'auto');
  const lock = document.querySelector('#modelSelect .ms-lock');
  if (lock) lock.style.display = (btn.dataset.type === 'builtin') ? 'flex' : 'none';
  aiEl('modelMenu').classList.remove('open');
}
document.querySelectorAll('.mm-opt').forEach((b) => b.addEventListener('click', () => selectModel(b)));

aiEl('modelSelect').addEventListener('click', (e) => { e.stopPropagation(); aiEl('modelMenu').classList.toggle('open'); });
document.addEventListener('click', (e) => {
  const menu = aiEl('modelMenu');
  if (menu && !menu.contains(e.target) && e.target !== aiEl('modelSelect')) menu.classList.remove('open');
});

/* 添加 / 删除自定义模型（密钥仅存主进程 userData，渲染层只拿到名称/地址/模型 ID） */
const addModalEl = aiEl('addModal');
function openAddModal() { addModalEl.classList.add('open'); aiEl('cmName').focus(); }
function closeAddModal() { addModalEl.classList.remove('open'); }
aiEl('addCustomBtn').addEventListener('click', openAddModal);
aiEl('addModelBtn2').addEventListener('click', openAddModal);
aiEl('cmCancel').addEventListener('click', closeAddModal);
addModalEl.addEventListener('click', (e) => { if (e.target === addModalEl) closeAddModal(); });
aiEl('cmSave').addEventListener('click', async () => {
  const name = aiEl('cmName').value.trim(), base = aiEl('cmBase').value.trim(),
    key = aiEl('cmKey').value.trim(), model = aiEl('cmModel').value.trim();
  if (!name || !base || !key || !model) { toast('请填写完整信息', 'warn'); return; }
  const r = await App.aiModelSave({ name, base, apiKey: key, model });
  if (r && r.ok) {
    renderCustomModels(r.list); closeAddModal();
    aiEl('cmName').value = aiEl('cmBase').value = aiEl('cmKey').value = aiEl('cmModel').value = '';
    toast('已添加：' + name);
  } else { toast('保存失败：' + ((r && r.error) || '未知错误'), 'error'); }
});
async function deleteCustomModel(id) {
  const r = await App.aiModelDelete(id);
  if (r && r.ok) { renderCustomModels(r.list); toast('已删除自定义模型'); }
  else toast('删除失败', 'error');
}

/* 对话：渲染层只发 messages，逐字接收主进程流式回传 */
function appendUserMsg(text) {
  const empty = aiEl('chatEmpty'); if (empty) empty.style.display = 'none';
  const d = document.createElement('div'); d.className = 'msg user'; d.textContent = text;
  aiEl('chatScroll').appendChild(d); scrollChat();
}
function appendAIMsg() { const d = document.createElement('div'); d.className = 'msg ai'; aiEl('chatScroll').appendChild(d); scrollChat(); return d; }
function appendTyping() { const d = document.createElement('div'); d.className = 'msg ai ai-typing'; d.id = 'aiTyping'; d.innerHTML = '<i></i><i></i><i></i>'; aiEl('chatScroll').appendChild(d); scrollChat(); }
function removeTyping() { const t = aiEl('aiTyping'); if (t) t.remove(); }
function scrollChat() { const s = aiEl('chatScroll'); s.scrollTop = s.scrollHeight; }

aiEl('sendBtn').addEventListener('click', sendMessage);
aiEl('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

async function sendMessage() {
  const input = aiEl('chatInput');
  const text = input.value.trim();
  if (!text || aiBusy) return;
  appendUserMsg(text);
  input.value = '';
  aiMessages.push({ role: 'user', content: text });
  aiBusy = true; aiEl('sendBtn').disabled = true;
  appendTyping();
  let aiMsgNode = null;
  App.aiChat(
    { modelId: currentModelId, messages: aiMessages.slice() },
    (delta) => {
      removeTyping();
      if (!aiMsgNode) aiMsgNode = appendAIMsg();
      aiMsgNode.textContent += delta;
      scrollChat();
    },
    (data) => {
      removeTyping();
      if (!aiMsgNode) aiMsgNode = appendAIMsg();
      if (data && data.ok) {
        if (!aiMsgNode.textContent) aiMsgNode.textContent = '（无内容返回）';
        aiMessages.push({ role: 'assistant', content: aiMsgNode.textContent });
      } else {
        aiMsgNode.textContent = '出错了：' + ((data && data.error) || '未知错误');
      }
      aiBusy = false; aiEl('sendBtn').disabled = false;
      scrollChat();
    }
  );
}

// 初始化时加载已保存的自定义模型
loadCustomModels();

/* ============================================================
 * 全局播放栏：可拖动 + 可缩小（避免遮挡对话框）
 * ============================================================ */
(function () {
  const gp = document.querySelector('.global-player');
  if (!gp) return;
  const grip = aiEl('gpGrip');
  const minBtn = aiEl('gpMinBtn');
  if (!grip || !minBtn) return;
  const icMin = minBtn.querySelector('.ic-min'), icExp = minBtn.querySelector('.ic-exp');
  let dragging = false, ox = 0, oy = 0;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true; gp.classList.add('dragging'); gp.style.bottom = 'auto';
    const r = gp.getBoundingClientRect();
    gp.style.left = r.left + 'px'; gp.style.top = r.top + 'px'; gp.style.transform = 'none';
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    grip.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let x = e.clientX - ox, y = e.clientY - oy;
    x = Math.max(8, Math.min(window.innerWidth - gp.offsetWidth - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - gp.offsetHeight - 8, y));
    gp.style.left = x + 'px'; gp.style.top = y + 'px';
  });
  const end = () => { dragging = false; gp.classList.remove('dragging'); };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  minBtn.addEventListener('click', () => {
    const min = gp.classList.toggle('min');
    if (icMin) icMin.style.display = min ? 'none' : 'block';
    if (icExp) icExp.style.display = min ? 'block' : 'none';
    minBtn.title = min ? '展开播放栏' : '缩小播放栏';
  });
})();

/* ============================================================
 * 消息页（抖音私信，原生 UI + 网页版接口）
 * 登录态复用 dyauth；会话/消息/发送走主进程 douyin-im 模块
 * ============================================================ */
const imState = { loggedIn: false, conversations: [], activeId: null, myUid: '' };

function imEl(id) { return document.getElementById(id); }
function imSafeId(s) { return String(s == null ? '' : s).replace(/["\\]/g, ''); }

// 视图进入：判断登录态
async function loadMessages() {
  let st = null;
  try { st = await App.imStatus(); } catch (_) {}
  imState.loggedIn = !!(st && st.isLogin);
  if (!imState.loggedIn) {
    imEl('imLoginCard').style.display = '';
    imEl('imShell').style.display = 'none';
    return;
  }
  imEl('imLoginCard').style.display = 'none';
  imEl('imShell').style.display = '';
  loadConversations();
}

async function loadConversations() {
  showLoading('加载会话列表…');
  const r = await App.imConversations({ cursor: 0 });
  hideLoading();
  if (!r || !r.ok) {
    if (r && r.needLogin) { loadMessages(); return; }
    toast('加载会话失败：' + ((r && r.error) || '未知错误'), 'error');
    return;
  }
  imState.conversations = r.data || [];
  renderConversations(imState.conversations);
}

function renderConversations(list) {
  const box = imEl('imConvScroll');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="im-empty">暂无私信会话</div>'; return; }
  list.forEach((c) => {
    const item = document.createElement('button');
    item.className = 'im-conv' + (c.id === imState.activeId ? ' active' : '');
    item.dataset.id = c.id;
    const av = c.avatar
      ? '<img class="im-conv-av" src="' + escapeHtml(c.avatar) + '" alt="">'
      : '<div class="im-conv-av im-conv-av--ph"></div>';
    const unread = c.unread ? '<span class="im-badge">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '';
    item.innerHTML =
      av +
      '<div class="im-conv-main"><div class="im-conv-top">' +
        '<span class="im-conv-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="im-conv-time">' + fmtImTime(c.time) + '</span></div>' +
        '<div class="im-conv-last">' + escapeHtml(c.last || '') + '</div></div>' + unread;
    item.addEventListener('click', () => openConversation(c));
    box.appendChild(item);
  });
}

async function openConversation(c) {
  imState.activeId = c.id;
  document.querySelectorAll('.im-conv').forEach((x) => x.classList.remove('active'));
  const node = document.querySelector('.im-conv[data-id="' + imSafeId(c.id) + '"]');
  if (node) node.classList.add('active');
  imEl('imThreadEmpty').style.display = 'none';
  imEl('imThreadMain').style.display = '';
  imEl('imThreadAv').src = c.avatar || '';
  imEl('imThreadName').textContent = c.name || '会话';
  imEl('imMsgs').innerHTML = '';
  showLoading('加载消息…');
  const r = await App.imMessages({ conversationId: c.id, cursor: 0, myUid: imState.myUid });
  hideLoading();
  if (!r || !r.ok) {
    if (r && r.needLogin) { loadMessages(); return; }
    toast('加载消息失败：' + ((r && r.error) || '未知错误'), 'error');
    return;
  }
  renderMessages(r.data || []);
}

function renderMessages(list) {
  const box = imEl('imMsgs');
  box.innerHTML = '';
  list.forEach((m) => appendImMessage(m, false));
  box.scrollTop = box.scrollHeight;
}

function appendImMessage(m, scroll) {
  const box = imEl('imMsgs');
  const row = document.createElement('div');
  row.className = 'im-msg' + (m.mine ? ' mine' : '');
  const bubble = document.createElement('div');
  bubble.className = 'im-bubble';
  bubble.textContent = m.content || '';
  row.appendChild(bubble);
  box.appendChild(row);
  if (scroll !== false) box.scrollTop = box.scrollHeight;
}

async function sendImMessage() {
  const input = imEl('imInput');
  const text = input.value.trim();
  if (!text || !imState.activeId) return;
  input.value = '';
  appendImMessage({ content: text, mine: true }, true);
  showLoading('发送中…');
  const r = await App.imSend({ conversationId: imState.activeId, text });
  hideLoading();
  if (!r || !r.ok) {
    toast('发送失败：' + ((r && r.error) || '未知错误'), 'error');
  }
}

function fmtImTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
}

// 平台选择（当前仅抖音，预留扩展）
document.querySelectorAll('.im-plat').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.im-plat').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  });
});

// 交互绑定
imEl('imLoginBtn').addEventListener('click', () => {
  App.dyLogin();
  toast('已打开登录窗口，请用抖音 App 扫码');
});
imEl('imRefresh').addEventListener('click', loadConversations);
imEl('imSend').addEventListener('click', sendImMessage);
imEl('imInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendImMessage(); }
});

// 登录成功后自动刷新消息页
if (App.onDyLoginSuccess) {
  App.onDyLoginSuccess(() => {
    toast('抖音登录成功');
    if (document.getElementById('view-messages') && document.getElementById('view-messages').classList.contains('active')) {
      loadMessages();
    }
  });
}
