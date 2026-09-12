/* 启动动画预加载脚本：仅向渲染层暴露进度 / 图标 / 初始化信息通道 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onInit: (cb) => ipcRenderer.on('splash:init', (_e, data) => cb(data)),
  onIcon: (cb) => ipcRenderer.on('splash:icon', (_e, dataUrl) => cb(dataUrl)),
  onProgress: (cb) => ipcRenderer.on('splash:progress', (_e, data) => cb(data)),
  onDone: (cb) => ipcRenderer.on('splash:done', () => cb()),
});
