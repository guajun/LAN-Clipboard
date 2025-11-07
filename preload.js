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
