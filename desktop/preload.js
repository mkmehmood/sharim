const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('__desktopApp', true);
contextBridge.exposeInMainWorld('desktopInfo', { platform: process.platform, version: process.versions.electron });
