const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  listItems: () => ipcRenderer.invoke('list-items'),
  copyItem: (id) => ipcRenderer.invoke('copy-item', id),
  pasteItem: (id) => ipcRenderer.invoke('paste-item', id),
  createItemFromClipboard: () => ipcRenderer.invoke('create-item-from-clipboard'),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  deleteItem: (id) => ipcRenderer.invoke('delete-item', id),
  addText: (text) => ipcRenderer.invoke('add-text', text)
});

// server config and download progress subscription
contextBridge.exposeInMainWorld('electronAPI', Object.assign({}, window.electronAPI || {}, {
  getServerConfig: () => ipcRenderer.invoke('get-server-config'),
  setServerConfig: (cfg) => ipcRenderer.invoke('set-server-config', cfg),
  onDownloadProgress: (cb) => {
    ipcRenderer.on('download-progress', (ev, data) => cb && cb(data));
  },
  onDownloadComplete: (cb) => {
    ipcRenderer.on('download-complete', (ev, data) => cb && cb(data));
  },
  onDownloadError: (cb) => {
    ipcRenderer.on('download-error', (ev, data) => cb && cb(data));
  }
}));
