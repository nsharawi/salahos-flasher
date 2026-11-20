// preload.js — the only bridge between the renderer (UI) and the device core.
// The renderer gets no Node access and no shell; it only sees window.flasherAPI.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flasherAPI', {
  // renderer -> main
  startFlash:  () => ipcRenderer.send('startFlash'),   // valid in READY; in ERROR = Retry
  closeWindow: () => ipcRenderer.send('closeWindow'),  // ignored by main while FLASHING
  getConfig:   () => ipcRenderer.invoke('getConfig'),
  installDrivers:  () => ipcRenderer.send('installDrivers'),          // valid in PCSETUP
  answerCheck:     (pass) => ipcRenderer.send('answerCheck', !!pass), // valid in CHECK
  restoreOriginal: () => ipcRenderer.send('restoreOriginal'),         // valid in ERROR when offered


  // main -> renderer (subscriptions)
  onStateChange: (cb) => ipcRenderer.on('state',    (_e, p) => cb(p)),   // { state, checks?, reason? }
  onProgress:    (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),   // { pct, label }
  onLog:         (cb) => ipcRenderer.on('log',      (_e, line) => cb(line))
});
