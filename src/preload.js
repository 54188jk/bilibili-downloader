/**
 * Preload 脚本
 * 通过 contextBridge 将安全的 API 暴露给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ===== 窗口控制 =====
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowToggleMax: () => ipcRenderer.invoke('window:toggleMax'),
  toggleAppFullscreen: (flag) => ipcRenderer.invoke('window:fullscreen', !!flag),

  // ===== 视频解析 =====
  parseVideo: (input) => ipcRenderer.invoke('video:parse', input),
  parseInput: (text) => ipcRenderer.invoke('video:parseInput', text),
  biliSearch: (payload) => ipcRenderer.invoke('video:search', payload),
  getQualities: (payload) => ipcRenderer.invoke('video:qualities', payload),
  downloadDash: (payload) => ipcRenderer.invoke('video:downloadDash', payload),
  biliGetDashUrls: (payload) => ipcRenderer.invoke('video:getDashUrls', payload),

  // ===== 抖音解析 =====
  parseDouyin: (text) => ipcRenderer.invoke('douyin:parse', text),
  dySearch: (payload) => ipcRenderer.invoke('douyin:search', payload),
  dyParseAweme: (awemeId) => ipcRenderer.invoke('douyin:parseAweme', awemeId),

  // ===== 快手解析 =====
  parseKuaishou: (text) => ipcRenderer.invoke('kuaishou:parse', text),

  // ===== UC 网盘解析 =====
  parseUc: (text) => ipcRenderer.invoke('uc:parse', text),
  openUcShare: (url) => ipcRenderer.invoke('uc:open', url),

  // ===== 下载历史 =====
  historyAdd: (entry) => ipcRenderer.invoke('history:add', entry),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyClear: () => ipcRenderer.invoke('history:clear'),
  historyRemove: (id) => ipcRenderer.invoke('history:remove', id),

  // ===== UC 登录 =====
  ucStatus: () => ipcRenderer.invoke('uc:status'),
  ucLogin: () => ipcRenderer.invoke('uc:login'),
  ucLogout: () => ipcRenderer.invoke('uc:logout'),
  onUcLoginSuccess: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('uc:loginSuccess', handler);
    return () => ipcRenderer.removeListener('uc:loginSuccess', handler);
  },

  // ===== 影视搜索 / 在线观看 =====
  movieSearch: (base, keyword, pg, timeout) => ipcRenderer.invoke('movie:search', { base, keyword, pg, timeout }),
  movieDetail: (base, id) => ipcRenderer.invoke('movie:detail', { base, id }),
  movieProbe: () => ipcRenderer.invoke('movie:probe'),
  movieCheckText: () => ipcRenderer.invoke('movie:checkText'),
  movieAutoPlayBtn: () => ipcRenderer.invoke('movie:autoPlayBtn'),
  movieSeek: (time) => ipcRenderer.invoke('movie:seek', { time }),
  movieNext: (dir) => ipcRenderer.invoke('movie:next', { dir }),
  movieSetReferer: (referer) => ipcRenderer.invoke('movie:setReferer', referer),
  movieDownloadEpisode: (payload) => ipcRenderer.invoke('movie:downloadEpisode', payload),
  movieServerStatus: () => ipcRenderer.invoke('movie:serverStatus'),
  movieServerApi: (path, query) => ipcRenderer.invoke('movie:serverApi', { path, query }),

  // ===== 抖音登录与收藏/点赞列表 =====
  dyLogin: () => ipcRenderer.invoke('dyauth:login'),
  dyLogout: () => ipcRenderer.invoke('dyauth:logout'),
  dyAuthStatus: () => ipcRenderer.invoke('dyauth:status'),
  onDyLoginSuccess: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('dyauth:loginSuccess', handler);
    return () => ipcRenderer.removeListener('dyauth:loginSuccess', handler);
  },
  getDyList: (type) => ipcRenderer.invoke('douyin:list', { type }),

  // ===== 抖音私信（原生 API；登录态复用 dyauth，隐藏窗口内签名）=====
  imStatus: () => ipcRenderer.invoke('douyin:im:status'),
  imConversations: (arg) => ipcRenderer.invoke('douyin:im:conversations', arg),
  imMessages: (arg) => ipcRenderer.invoke('douyin:im:messages', arg),
  imSend: (arg) => ipcRenderer.invoke('douyin:im:send', arg),

  // ===== 本地音乐 API =====
  musicStart: () => ipcRenderer.invoke('music:start'),
  musicStatus: () => ipcRenderer.invoke('music:status'),
  musicApi: (path, query) => ipcRenderer.invoke('music:api', { path, query }),
  musicDownload: (payload) => ipcRenderer.invoke('music:download', payload),
  musicLike: (id) => ipcRenderer.invoke('music:like', id),
  musicLikelist: () => ipcRenderer.invoke('music:likelist'),

  // ===== 桌面歌词 =====
  desktopLyricsOpen: () => ipcRenderer.invoke('lyrics:open'),
  desktopLyricsClose: () => ipcRenderer.invoke('lyrics:close'),
  desktopLyricsToggle: () => ipcRenderer.invoke('lyrics:toggle'),
  desktopLyricsIsOpen: () => ipcRenderer.invoke('lyrics:isOpen'),
  desktopLyricsLoad: (payload) => ipcRenderer.send('desktop-lyrics:load', payload),
  desktopLyricsTick: (payload) => ipcRenderer.send('desktop-lyrics:tick', payload),
  desktopLyricsSetColor: (color) => { try { ipcRenderer.send('desktop-lyrics:setColor', color); } catch (_) {} },
  onDesktopLyricsClosed: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('desktop-lyrics:closed', handler);
    return () => ipcRenderer.removeListener('desktop-lyrics:closed', handler);
  },
  onDesktopLyricsMusicCmd: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('desktop-lyrics:musicCmd', handler);
    return () => ipcRenderer.removeListener('desktop-lyrics:musicCmd', handler);
  },

  // ===== 视频背景 =====
  bgScanVideos: (dir) => ipcRenderer.invoke('bg:scanVideos', dir),

  // ===== B 站登录 =====
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  authStatus: () => ipcRenderer.invoke('auth:status'),

  // ===== 打开外部链接（新增） =====
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // ===== 教程页面路径 =====
  getTutorialPath: () => ipcRenderer.invoke('app:tutorialPath'),
  openTutorial: () => ipcRenderer.invoke('app:openTutorial'),

  // ===== 下载 & 文件 =====
  pickSaveDir: () => ipcRenderer.invoke('dialog:saveDir'),
  pickAvatar: () => ipcRenderer.invoke('dialog:pickAvatar'),
  getDefaultSaveDir: () => ipcRenderer.invoke('save:getDefaultDir'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),

  // ===== 下载 & 文件 =====
  downloadStart: (payload) => ipcRenderer.invoke('download:start', payload),
  onDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', handler);
    return () => ipcRenderer.removeListener('download:progress', handler);
  },

  extractAudio: (payload) => ipcRenderer.invoke('ffmpeg:extractAudio', payload),
  extractVideo: (payload) => ipcRenderer.invoke('ffmpeg:extractVideo', payload),
  onFfmpegLog: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('ffmpeg:log', handler);
    return () => ipcRenderer.removeListener('ffmpeg:log', handler);
  },
  checkFfmpeg: () => ipcRenderer.invoke('ffmpeg:check'),

  fsRename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
  fsDelete: (p) => ipcRenderer.invoke('fs:delete', p),
  fsStat: (p) => ipcRenderer.invoke('fs:stat', p),
  pathJoin: (...args) => args.join('/').replace(/\\/g, '/'),

  // ===== 智能助手对话（密钥只在主进程，渲染层只发送对话内容）=====
  // 流式：主进程通过事件 ai:chunk / ai:done 回传，渲染层永不接触密钥 / 地址 / 模型名
  aiChat: (payload, onChunk, onDone) => {
    const reqId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const onChunkEv = (_e, d) => { if (d && d.reqId === reqId && onChunk) onChunk(d.delta || ''); };
    const onDoneEv = (_e, d) => {
      if (!d || d.reqId !== reqId) return;
      ipcRenderer.removeListener('ai:chunk', onChunkEv);
      ipcRenderer.removeListener('ai:done', onDoneEv);
      if (onDone) onDone(d);
    };
    ipcRenderer.on('ai:chunk', onChunkEv);
    ipcRenderer.on('ai:done', onDoneEv);
    ipcRenderer.send('ai:chat', Object.assign({}, payload, { reqId }));
  },
  aiModelsGet: () => ipcRenderer.invoke('ai:modelsGet'),
  aiModelSave: (model) => ipcRenderer.invoke('ai:modelSave', model),
  aiModelDelete: (id) => ipcRenderer.invoke('ai:modelDelete', id),

  // ===== 启动动画：渲染层首屏初始化真正完成后上报，主进程据此关闭启动页 =====
  appReady: () => ipcRenderer.send('app:ready'),

});