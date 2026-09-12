const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ocrApi', {
  onImage: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('ocr:image', h); return () => ipcRenderer.removeListener('ocr:image', h); },
  recognize: (dataURL, lang) => ipcRenderer.invoke('capture:ocr', dataURL, lang || 'chi_sim+eng'),
  close: () => ipcRenderer.send('capture:ocr-close'),
});