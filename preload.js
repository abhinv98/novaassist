const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaAssist', {
  executeCommand: (input) => ipcRenderer.invoke('execute-command', input),
  voiceListen: () => ipcRenderer.invoke('voice-listen'),
  voiceSpeak: (text) => ipcRenderer.invoke('voice-speak', text),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  onOverlayUpdate: (cb) => ipcRenderer.on('overlay-update', (_e, data) => cb(data)),
  checkAccessibility: () => ipcRenderer.invoke('check-accessibility'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  verifyAws: (creds) => ipcRenderer.invoke('verify-aws', creds),
  installDeps: () => ipcRenderer.invoke('install-deps'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onDepsOutput: (cb) => ipcRenderer.on('deps-output', (_e, data) => cb(data)),
});
