const { app, BrowserWindow, Menu, protocol, net, session, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_HOST = 'mkmehmood.github.io';
const APP_BASE = '/sarim/';
const ROOT = path.join(__dirname, 'app');

protocol.registerSchemesAsPrivileged([
  { scheme: 'https', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

function resolveLocal(urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.startsWith(APP_BASE)) p = p.slice(APP_BASE.length);
  else if (p.startsWith('/')) p = p.slice(1);
  if (!p || p.endsWith('/')) p += 'index.html';
  const full = path.normalize(path.join(ROOT, p));
  if (!full.startsWith(ROOT)) return null;
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 640,
    title: 'Gull & Zubair',
    backgroundColor: '#E8ECF0',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:|tel:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const u = new URL(url);
      if (u.host !== APP_HOST) { e.preventDefault(); shell.openExternal(url); }
    } catch (_) { e.preventDefault(); }
  });
  win.loadURL(`https://${APP_HOST}${APP_BASE}index.html`);
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.host === APP_HOST && (url.pathname.startsWith(APP_BASE) || url.pathname === '/' || !url.pathname.startsWith('/_'))) {
      const file = resolveLocal(url.pathname);
      if (file) return net.fetch(pathToFileURL(file).toString());
      if (url.host === APP_HOST && url.pathname.startsWith(APP_BASE)) return new Response('Not found', { status: 404 });
    }
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'geolocation', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission));
  });

  session.defaultSession.on('will-download', (event, item) => {
    item.once('done', (_e, state) => {
      if (state === 'completed' && win) {
        dialog.showMessageBox(win, { type: 'info', message: 'File saved', detail: item.getSavePath(), buttons: ['Show in folder', 'OK'], defaultId: 1 })
          .then(r => { if (r.response === 0) shell.showItemInFolder(item.getSavePath()); }).catch(() => {});
      }
    });
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'App', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }] }
  ]));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
