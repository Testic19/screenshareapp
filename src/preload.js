const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getSources: () => ipcRenderer.invoke('get-sources')
});

contextBridge.exposeInMainWorld('net', {
  start: (cfg) => ipcRenderer.invoke('net-start', cfg),
  join: (room) => ipcRenderer.send('net-join', room),
  setRate: (bps) => ipcRenderer.send('net-rate', bps),
  sendFrags: (frags, priority) => ipcRenderer.send('net-frags', frags, !!priority),
  onEvent: (cb) => ipcRenderer.on('net-evt', (e, evt) => cb(evt))
});
