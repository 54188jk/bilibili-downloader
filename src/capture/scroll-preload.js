const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('scrollApi', {
  onProgress: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('scroll:progress', h); return () => ipcRenderer.removeListener('scroll:progress', h); },
});