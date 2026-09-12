const { contextBridge, ipcRenderer, clipboard, nativeImage } = require('electron');
contextBridge.exposeInMainWorld('pinApi', {
  onImage: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('pin:image', h); return () => ipcRenderer.removeListener('pin:image', h); },
  copy: (dataURL) => { try { clipboard.writeImage(nativeImage.createFromDataURL(dataURL)); return true; } catch (_) { return false; } },
});
