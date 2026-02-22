const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pty', {
  spawn: () => ipcRenderer.send('pty-spawn'),
  write: (data) => ipcRenderer.send('pty-write', data),
  onData: (callback) => ipcRenderer.on('pty-data', (_, data) => callback(data)),
  resize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows })
});
