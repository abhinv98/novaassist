const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('novaAssist', {
  executeCommand: (input) => ipcRenderer.invoke('execute-command', input),
  voiceListen: () => ipcRenderer.invoke('voice-listen'),
  voiceSpeak: (text) => ipcRenderer.invoke('voice-speak', text),
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
});
