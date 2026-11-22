'use strict';
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { FipApi } = require('./src/api');
// Ricarica le query a caldo: così una modifica a queries.js viene presa senza
// dover riavviare l'app (il processo principale altrimenti terrebbe la versione in cache).
function getQueries() {
  try { delete require.cache[require.resolve('./src/queries')]; } catch { /* in pacchetto */ }
  return require('./src/queries');
}

// ---------- Persistenza semplice (JSON in userData, sessione cifrata col Portachiavi) ----------
function createStore() {
  const file = path.join(app.getPath('userData'), 'store.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const save = () => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return {
    get(key) {
      const v = data[key];
      if (v && typeof v === 'object' && v.__enc) {
        try { return JSON.parse(safeStorage.decryptString(Buffer.from(v.__enc, 'base64'))); } catch { return null; }
      }
      return v;
    },
    set(key, value) {
      if (key === 'session' && value) {
        if (canEncrypt()) {
          data[key] = { __enc: safeStorage.encryptString(JSON.stringify(value)).toString('base64') };
        } else {
          // Cifratura non disponibile: NON salviamo mai i token in chiaro. La sessione
          // resta solo in memoria per questa esecuzione; al prossimo avvio si rifà il login.
          delete data[key];
          save();
          return;
        }
      } else {
        data[key] = value;
      }
      save();
    },
  };
}

let api;
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'FIP Stats Desktop',
    backgroundColor: '#0f1420',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // DevTools solo in sviluppo: nella build distribuita sono disattivati, così
      // chi ha accesso fisico al Mac non può ispezionare i token di sessione.
      devTools: !app.isPackaged,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  api = new FipApi(createStore());

  const wrap = (fn) => async (_e, ...args) => {
    try { return { ok: true, result: await fn(...args) }; }
    catch (err) { return { ok: false, error: err.message, code: err.code ?? null, details: err.details ?? null }; }
  };

  ipcMain.handle('auth:status', wrap(async () => api.status()));
  ipcMain.handle('auth:login', wrap(async (email, password) => api.login(email, password)));
  ipcMain.handle('auth:logout', wrap(async () => { api.logout(); return api.status(); }));
  ipcMain.handle('auth:reclaim', wrap(async () => api.reclaim()));
  ipcMain.handle('diag:run', wrap(async () => api.diagnose()));
  ipcMain.handle('user:info', wrap(async () => api.refreshUserInfo()));

  // Query per nome (dal modulo queries) oppure testo libero (console GraphQL).
  ipcMain.handle('gql:named', wrap(async (name, variables) => {
    const Q = getQueries();
    if (!Q[name]) throw new Error(`Query sconosciuta: ${name}`);
    return api.query(Q[name], variables || {});
  }));
  ipcMain.handle('gql:raw', wrap(async (query, variables) => api.query(query, variables || {})));
  ipcMain.handle('gql:list', wrap(async () => ({ ...getQueries() })));

  ipcMain.handle('file:saveCsv', wrap(async (suggestedName, content) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }));
  ipcMain.handle('shell:open', wrap(async (url) => shell.openExternal(url)));

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
