const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('recorderApi', {
  start: (opts) => ipcRenderer.invoke('capture:record-start', opts),
  stop: () => ipcRenderer.invoke('capture:record-stop'),
  save: (format, dataURL) => ipcRenderer.invoke('capture:record-save', format, dataURL),
  close: () => ipcRenderer.send('capture:recorder-close'),
});