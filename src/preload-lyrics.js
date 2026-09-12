/**
 * 桌面歌词窗口 Preload
 * 通过 contextBridge 暴露安全的 IPC 接口给桌面歌词页面
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dl', {
  // 接收整首歌歌词 {title, artist, lines:[{time,text,chars}]}
  onData: (cb) => {
    ipcRenderer.on('desktop-lyrics:data', (_e, p) => cb(p));
  },
  // 接收播放进度 {time, playing, duration}
  onTick: (cb) => {
    ipcRenderer.on('desktop-lyrics:tick', (_e, p) => cb(p));
  },
  // 接收右键菜单 / 主进程命令 {type, value}
  onCmd: (cb) => {
    ipcRenderer.on('desktop-lyrics:cmd', (_e, p) => cb(p));
  },
  // 弹出原生右键菜单（携带当前设置快照用于勾选态）
  showMenu: (state) => ipcRenderer.send('lyrics:menu', state),
  // 关闭桌面歌词
  close: () => ipcRenderer.send('lyrics:close'),
  // 让主进程把窗口移到屏幕底部中央
  resetPos: () => ipcRenderer.send('lyrics:resetPos'),
  // 设置窗口是否忽略鼠标事件（点击穿透）
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('lyrics:setIgnoreMouseEvents', ignore),
  // 音乐控制：play/pause/next/prev
  musicControl: (action) => ipcRenderer.send('lyrics:musicControl', action),
});