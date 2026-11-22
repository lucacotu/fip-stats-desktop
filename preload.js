'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) {
    const e = new Error(r.error);
    e.code = r.code;
    e.details = r.details;
    throw e;
  }
  return r.result;
};

contextBridge.exposeInMainWorld('fip', {
  status: () => call('auth:status'),
  login: (email, password) => call('auth:login', email, password),
  logout: () => call('auth:logout'),
  reclaim: () => call('auth:reclaim'),
  userInfo: () => call('user:info'),
  diagnose: () => call('diag:run'),
  q: (name, variables) => call('gql:named', name, variables),
  raw: (query, variables) => call('gql:raw', query, variables),
  queries: () => call('gql:list'),
  saveCsv: (name, content) => call('file:saveCsv', name, content),
  open: (url) => call('shell:open', url),
});
