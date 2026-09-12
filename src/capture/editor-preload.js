const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('editorApi', {
  onImage: (cb) => { const h = (_e, d) => cb(d); ipcRenderer.on('editor:image', h); return () => ipcRenderer.removeListener('editor:image', h); },
  done: (dataURL) => ipcRenderer.send('capture:editor-action', { action: 'copy', dataURL }),
  save: (dataURL) => ipcRenderer.send('capture:editor-action', { action: 'save', dataURL }),
  pin: (dataURL) => ipcRenderer.send('capture:editor-action', { action: 'pin', dataURL }),
  ocr: (dataURL) => ipcRenderer.send('capture:editor-action', { action: 'ocr', dataURL }),
  cancel: () => ipcRenderer.send('capture:editor-cancel'),
});
