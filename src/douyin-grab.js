'use strict';

// ============================================
// 抖音视频解析抓取（独立模块，便于单独测试）
// 隐藏窗口加载 PC 页面，经 CDP 拦截官方 aweme/detail 接口，
// 拿到无水印 play_addr + 标题/作者/封面 + 互动数据（点赞/评论/收藏/转发/弹幕），
// 完全本地、不依赖第三方接口。
//
// 提速改造：
// 1) 磁盘缓存开启：JS bundle/接口响应走磁盘缓存，第二次起省 1~3s 冷启动
// 2) 窗口复用：常驻一个隐藏窗口，串行队列排队，避免每次 new BrowserWindow
// 3) 轮询 600ms -> 180ms：后备信号（video src）命中更快
// 4) 验证码中间页 1.5s 内识别：不再干等 18s 轮询耗尽；可弹窗让用户人工过一次，
//    persist 分区记住 cookie 后续就不再拦（config.json: dyCaptchaManual，默认开启）
// 5) 埋点/统计域名一并拦截，减少无关请求抢占带宽
// ============================================

const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

// —— 配置（config.json 可覆盖） ——
function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
  } catch (_) { return {}; }
}
const CFG = loadCfg();
// 验证码人工通道：检测到风控页后弹出可见窗口，用户完成验证即自动继续
// 环境变量 DY_CAPTCHA_MANUAL=0/1 可临时覆盖（测试用）
const CAPTCHA_MANUAL = process.env.DY_CAPTCHA_MANUAL
  ? process.env.DY_CAPTCHA_MANUAL !== '0'
  : CFG.dyCaptchaManual !== false;
// 单次抓取总超时（人工通道下给用户留时间）
const GRAB_TIMEOUT_MS = CAPTCHA_MANUAL ? 45000 : 15000;
// 后备轮询间隔
const POLL_MS = 180;
// 后备轮询最大次数（180ms * 60 ≈ 10.8s）
const POLL_MAX = 60;

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 埋点/统计/推荐流等与解析无关的域名（拦掉可减少带宽与主线程噪音）
const NOISE_URL_PATTERNS = [
  '*://*.snssdk.com/buried*', '*://*.snssdk.com/log*', '*://*.snssdk.com/monitor*',
  '*://*.zijieapi.com/log/*', '*://*.zijieapi.com/monitor/*',
  '*://mcs.douyin.com/*', '*://mss.douyin.com/*', '*://*.doubleclick.net/*',
  '*://*.google-analytics.com/*', '*://hm.baidu.com/*', '*://*.umeng*.com/*',
];

// —— 模块级共享状态：单窗口复用 + 串行队列 ——
let sharedWin = null;   // 常驻隐藏窗口
let sharedDbg = null;   // 常驻 CDP 会话
let queue = Promise.resolve(); // 串行队列（同一时间只解析一条，避免信号串台）
let current = null;     // 当前任务 { awemeId, settled, resolve, poll, timer, captchaWait }

function emit(obj) {
  if (!current || current.settled) return;
  current.settled = true;
  const cur = current;
  current = null;
  if (cur.poll) { try { clearInterval(cur.poll); } catch (_) {} }
  if (cur.timer) { try { clearTimeout(cur.timer); } catch (_) {} }
  cur.captchaWait = false;
  try { if (sharedWin && !sharedWin.isDestroyed()) sharedWin.hide(); } catch (_) {}
  cur.resolve(obj);
}

function ensureWindow() {
  if (sharedWin && !sharedWin.isDestroyed() && sharedWin.webContents && !sharedWin.webContents.isDestroyed()) {
    return sharedWin;
  }

  const grabSession = session.fromPartition('persist:dygrab'); // 保留磁盘缓存：bundle 二次加载更快
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 750,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: grabSession,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(DESKTOP_UA);

  // 一次性注册：资源拦截 + 埋点屏蔽（只注册一次，避免重复叠加监听器）
  if (!grabSession.__dyGrabHooked) {
    grabSession.__dyGrabHooked = true;
    grabSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const t = details.resourceType;
      if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return callback({ cancel: true });
      callback({});
    });
  }

  // 注入主会话的抖音 cookie（如有登录态），保持与真实浏览器一致的风控通过率
  (async () => {
    try {
      const dyCookies = await session.defaultSession.cookies.get({ domain: '.douyin.com' });
      for (const c of dyCookies) {
        await grabSession.cookies.set({
          url: 'https://www.douyin.com', name: c.name, value: c.value,
          domain: c.domain || '.douyin.com', path: c.path || '/',
          secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate,
        }).catch(() => {});
      }
    } catch (_) {}
  })();

  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
    dbg.sendCommand('Network.enable');
    dbg.sendCommand('Network.setBlockedURLs', { urls: NOISE_URL_PATTERNS }).catch(() => {});
  } catch (_) {}
  sharedDbg = dbg;

  // 常驻 CDP 监听：拦截 detail 接口（主动信号，页面加载后通常 0.3~1s 内命中）
  dbg.on('message', async (_e, method, params) => {
    const cur = current;
    if (!cur || cur.settled) return;
    if (method !== 'Network.responseReceived') return;
    const url = (params.response && params.response.url) || '';
    // 第二信号源：播放器实际加载的视频直链
    if (/\/aweme\/v1\/play\//.test(url)) {
      if (!cur.playDirect) cur.playDirect = url;
      return;
    }
    // detail 接口（含 web 版与非 web 版、multi 版）
    if (!/\/aweme\/v1\/(?:web\/|multi\/)?aweme\/detail\//.test(url)) return;
    try {
      const { body } = await sharedDbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const data = JSON.parse(body);
      const detailObj = data.aweme_detail || data.data || {};
      if (!(detailObj && detailObj.video && detailObj.video.play_addr)) return;
      const list = (detailObj.video.play_addr.url_list || []).map(u =>
        u.replace(/\/playwm\//, '/play/').replace(/^http:/, 'https:'));
      const videoUrl = list.find(u => /douyinvod|douyinstatic|\.mp4|v\d+\-web/.test(u)) || list[0];
      if (!videoUrl) return;
      const coverList = (detailObj.video.cover && detailObj.video.cover.url_list) || [];
      const st = detailObj.statistics || {};
      emit({
        ok: true,
        data: {
          awemeId: detailObj.aweme_id || cur.awemeId,
          title: detailObj.desc || '抖音视频',
          cover: (coverList[0] || '').replace(/^http:/, 'https:'),
          videoUrl,
          author: (detailObj.author && detailObj.author.nickname) || '',
          stats: {
            play: st.play_count || 0,
            digg: st.digg_count || 0,
            comment: st.comment_count || 0,
            collect: st.collect_count || 0,
            share: st.share_count || 0,
            danmaku: st.danmaku_count || 0,
          },
        },
      });
    } catch (_) { /* 交由其它信号源 */ }
  });

  // —— 测试钩子：DY_MOCK_HTML 存在时用假页面顶替真实视频页，
  //    便于在被风控的机器上回归验证"成功路径"的耗时与信号链路 ——
  if (process.env.DY_MOCK_HTML) {
    try {
      dbg.sendCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*douyin.com/video/*', resourceType: 'Document', requestStage: 'Request' }],
      }).catch(() => {});
      dbg.on('message', (_e, method, params) => {
        if (method !== 'Fetch.requestPaused') return;
        const html = process.env.DY_MOCK_HTML;
        dbg.sendCommand('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(html, 'utf-8').toString('base64'),
        }).catch(() => {});
      });
    } catch (_) {}
  }

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (current && !current.settled) emit({ ok: false, error: '抖音页面加载失败：' + desc });
  });

  sharedWin = win;
  return win;
}

// 读取当前 DOM 状态（视频直链 / 标题 / 作者 / 封面 / 是否风控页 / 是否已删除）
function probeDom() {
  return sharedWin.webContents.executeJavaScript(`(() => {
    const out = { url:'', title:'', cover:'', author:'', dead:false, captcha:false };
    const v = document.querySelector('video');
    if (v) out.url = v.currentSrc || v.src || '';
    if (out.url && !/^https?:/i.test(out.url)) out.url = '';
    if (out.url) out.url = out.url.replace(/^http:/,'https:');
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) out.title = h1.textContent.trim().slice(0,120);
    if (!out.title && document.title) out.title = document.title.replace(/ - 抖音$/,'').slice(0,120);
    const nick = document.querySelector('[data-e2e="video-author-name"], [class*="nickname"], .author-info .name');
    if (nick) out.author = nick.textContent.trim().slice(0,40);
    const cis = document.querySelectorAll('img[src*="pcweb_cover"]');
    for (const im of cis) { if (im.src) { out.cover = im.src.replace(/^http:/,'https:'); break; } }
    const bodyTxt = (document.body ? document.body.innerText : '').slice(0,600);
    const head = out.title + ' ' + bodyTxt;
    if (/验证码|安全验证|人机验证|请完成验证|captcha/i.test(head)) out.captcha = true;
    if (/作品.{0,6}(不存在|已删除|删除)|页面不存在|内容不存在|内容已被作者删除|视频不见了|该作品/.test(bodyTxt)) out.dead = true;
    return out;
  })()`);
}

// 验证码人工通道：弹出可见窗口，等用户完成验证后自动继续
function waitCaptchaManual() {
  const cur = current;
  if (!cur || cur.settled || cur.captchaWait) return;
  cur.captchaWait = true;
  if (!CAPTCHA_MANUAL) {
    emit({ ok: false, error: '抖音触发风控验证（人工验证通道已关闭，未等待）。可在 config.json 设 dyCaptchaManual:true 弹窗手动过验证' });
    return;
  }
  try {
    sharedWin.setTitle('BiliGrab - 请完成抖音安全验证（完成后自动继续解析）');
    sharedWin.show();
    sharedWin.focus();
  } catch (_) {}
}

function runGrab(awemeId) {
  return new Promise((resolve) => {
    const win = ensureWindow();

    current = {
      awemeId,
      settled: false,
      resolve,
      poll: null,
      timer: null,
      playDirect: '',
      captchaWait: false,
    };
    const cur = current;

    cur.timer = setTimeout(() => {
      if (cur.captchaWait) {
        emit({ ok: false, error: '等待抖音验证超时（可重试，或先登录抖音账号提高通过率）' });
      } else {
        emit({ ok: false, error: '抖音页面加载超时' });
      }
    }, GRAB_TIMEOUT_MS);

    // 导航前清掉上一次任务的残留监听/轮询
    win.webContents.removeAllListeners('dom-ready');
    if (cur.poll) clearInterval(cur.poll);

    let started = false;
    const startPolling = () => {
      if (started) return;
      started = true;
      if (current !== cur || cur.settled) return;
      let tries = 0;
      cur.poll = setInterval(async () => {
        if (current !== cur || cur.settled) { clearInterval(cur.poll); return; }
        tries++;
        try {
          const r = await probeDom();
          if (current !== cur || cur.settled) return;
          const realUrl = r && r.url && !/uuu_|douyinstatic|\/obj\//i.test(r.url) ? r.url : '';
          if (realUrl || cur.playDirect) {
            return emit({ ok: true, data: { awemeId, title: r.title || '抖音视频', cover: r.cover || '', videoUrl: realUrl || cur.playDirect, author: r.author || '', stats: null } });
          }
          if (r && r.captcha) { waitCaptchaManual(); tries = 0; return; }   // 1.5s 级识别；人工验证期间不计入失败计数
          if (r && r.dead) return emit({ ok: false, error: '视频不存在或已被删除' });
          if (tries > POLL_MAX) return emit({ ok: false, error: '未获取到视频信息（抖音数据加载受限，请重试一次）' });
        } catch (e) {
          if (tries > POLL_MAX) return emit({ ok: false, error: '抓取失败：' + e.message });
        }
      }, POLL_MS);
    };

    win.webContents.on('dom-ready', startPolling);
    win.webContents.once('did-finish-load', startPolling);

    // 风控页停留检测：dom 就绪后立刻探一次，命中验证码马上转人工
    win.webContents.once('dom-ready', async () => {
      try {
        const r = await probeDom();
        if (current === cur && !cur.settled && r && r.captcha) waitCaptchaManual();
      } catch (_) {}
    });

    win.loadURL('https://www.douyin.com/video/' + awemeId).catch(() => {});
  });
}

// 对外入口：串行队列化，同一时间只跑一个抓取任务
function grabDouyinVideo(awemeId) {
  const task = queue.then(() => runGrab(String(awemeId)), () => runGrab(String(awemeId)));
  queue = task.then(() => {}, () => {});
  return task;
}

// 竞速落败方主动收工：快线路已成功时立刻终止窗口任务，别再占着窗口跑
function cancelGrab() {
  if (current && !current.settled) emit({ ok: false, error: '已由更快线路完成，窗口抓取已取消' });
}

// 预热：应用启动后提前把隐藏窗口/会话/拦截器建好，
// 首次解析就不用再付 BrowserWindow 创建 + 分区初始化的开销（省 200~500ms）
function prewarmGrabWindow() {
  try { ensureWindow(); } catch (_) {}
}

module.exports = { grabDouyinVideo, cancelGrab, prewarmGrabWindow };
