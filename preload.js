'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitor', {
  onUsage: (callback) => ipcRenderer.on('usage', (_event, data) => callback(data)),
  onState: (callback) => ipcRenderer.on('state', (_event, data) => callback(data)),
  onSys: (callback) => ipcRenderer.on('sys', (_event, data) => callback(data)),
  onExt: (callback) => ipcRenderer.on('ext', (_event, data) => callback(data)),
  onTab: (callback) => ipcRenderer.on('tab', (_event, name) => callback(name)),
  setTab: (name) => ipcRenderer.send('tab-changed', name),
  openDisplaysSettings: () => ipcRenderer.send('open-displays'),
  hideDashboard: () => ipcRenderer.send('hide-dashboard'),
  refreshExternal: () => ipcRenderer.send('refresh-external'),
});