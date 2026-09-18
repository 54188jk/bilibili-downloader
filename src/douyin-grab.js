'use strict';

// ============================================
// 抖音视频解析抓取（独立模块，便于单独测试）
// 隐藏窗口加载 PC 页面，经 CDP 拦截官方 aweme/detail 接口，
// 拿到无水印 play_addr + 标题/作者/封面 + 互动数据（点赞/评论/收藏/转发/弹幕），
// 完全本地、不依赖第三方接口。
//
// 提速要点：使用独立内存会话并拦截 image/media/font 重资源 ——
// 解析只需要 detail 接口响应，屏蔽后页面加载从数秒级降到亚秒级；
// 同时注入主会话抖音 cookie 保持风控通过率，且不影响主窗口登录态。
// ============================================

const { BrowserWindow, session } = require('electron');

function grabDouyinVideo(awemeId) {
  return new Promise((resolve) => {
    let grabSession;
    try {
      // 持久化会话：ttwid 等风控指纹 cookie 跨解析累积，首次解析"预热"后，
      // 后续解析信任度更高、速度更快；cache:false 仅为省磁盘缓存
      grabSession = session.fromPartition('persist:dygrab', { cache: false });
      (async () => {
        // 注入主会话的抖音 cookie（如有登录态），保持与真实浏览器一致的风控通过率
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
        try {
          // 持久化会话：拦截器只注册一次，避免每次解析都叠加监听器（资源泄漏）
          if (!grabSession.__dyGrabHooked) {
            grabSession.__dyGrabHooked = true;
            grabSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
              const t = details.resourceType;
              if (t === 'image' || t === 'media' || t === 'font' || t === 'stylesheet') return callback({ cancel: true });
              callback({});
            });
          }
        } catch (_) {}

        const win = new BrowserWindow({
          show: false,
          width: 1100,
          height: 750,
          webPreferences: { nodeIntegration: false, contextIsolation: true, session: grabSession, backgroundThrottling: false },
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
          try { if (dbg.isAttached()) dbg.detach(); } catch (_) {}
          try { win.destroy(); } catch (_) {}
          resolve(obj);
        }

        const dbg = win.webContents.debugger;
        try { dbg.attach('1.3'); dbg.sendCommand('Network.enable'); } catch (_) {}

        // 收集 detail 接口返回
        let detail = null;
        let playDirect = ''; // 播放器实际请求的 /aweme/v1/play/ 直链（detail 拦截失败时的备选）
        const onMsg = async (_e, method, params) => {
          if (settled || detail) return;
          if (method === 'Network.responseReceived') {
            const url = (params.response && params.response.url) || '';
            // 第二信号源：播放器实际加载的视频直链
            if (/\/aweme\/v1\/play\//.test(url)) {
              if (!playDirect) playDirect = url;
              return;
            }
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
                  const st = detailObj.statistics || {};
                  finish({ ok: true, data: {
                    awemeId: detailObj.aweme_id || awemeId,
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
                  } });
                }
              } catch (e) { /* 忽略，交由其它信号源 */ }
            }
          }
        };
        dbg.on('message', onMsg);

        // 后备信号源：若 detail 拦截不到，轮询 video src 是否为 http 直链
        // 注意：必须排除播放器占位视频（uuu_265 / douyinstatic），否则会在 detail
        // 数据到达前抢跑返回一个假结果（历史上导致解析"成功"但内容错误）
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
                if (!out.title && document.title) out.title = document.title.replace(/ - 抖音$/, '').slice(0,120);
                const nick = document.querySelector('[data-e2e="video-author-name"], [class*="nickname"], .author-info .name');
                if (nick) out.author = nick.textContent.trim().slice(0,40);
                const cis = document.querySelectorAll('img[src*="pcweb_cover"]');
                for (const im of cis) { if (im.src) { out.cover = im.src.replace(/^http:/,'https:'); break; } }
                const bodyTxt = (document.body ? document.body.innerText : '').slice(0,600);
                if (/作品.{0,6}(不存在|已删除|删除)|页面不存在|内容不存在|内容已被作者删除|视频不见了|该作品/.test(bodyTxt)) out.dead = true;
                return out;
              })()`);
              // 占位视频不算数：等待真正的视频源或 play 直链
              const realUrl = r && r.url && !/uuu_|douyinstatic|\/obj\//i.test(r.url) ? r.url : '';
              if (realUrl || playDirect) {
                clearInterval(poll);
                finish({ ok: true, data: { awemeId, title: r.title || '抖音视频', cover: r.cover || '', videoUrl: realUrl || playDirect, author: r.author || '', stats: null } });
              } else if (r && r.dead) {
                clearInterval(poll);
                finish({ ok: false, error: '视频不存在或已被删除' });
              } else if (tries > 30) {
                clearInterval(poll);
                finish({ ok: false, error: '未获取到视频信息（抖音数据加载受限，请重试一次）' });
              }
            } catch (e) {
              if (tries > 30) {
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
      })().catch((e) => {
        resolve({ ok: false, error: '抖音抓取初始化失败：' + e.message });
      });
    } catch (e) {
      resolve({ ok: false, error: '抖音抓取初始化失败：' + e.message });
    }
  });
}

module.exports = { grabDouyinVideo };
