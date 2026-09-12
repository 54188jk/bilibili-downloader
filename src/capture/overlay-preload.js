const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('captureApi', {
  onSnapshot: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('capture:snapshot', h); return () => ipcRenderer.removeListener('capture:snapshot', h); },
  selected: (payload) => ipcRenderer.send('capture:overlay-selected', payload),
  cancel: () => ipcRenderer.send('capture:overlay-cancel'),
});
