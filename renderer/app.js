'use strict';
/* FIP Stats Desktop — interfaccia (renderer). Comunica con il processo principale via window.fip. */

// ============================================================ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = () => $('#view');

const state = {
  seasons: [],
  seasonId: null,
  user: null,
  orderStats: null,   // valori enum OrderStats (introspezione)
  renderToken: 0,
  follows: null,      // cache di cosa segue l'utente: { teams:Set<fid>, competitions:Set<fid> }
};

function qs(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}
const link = (route, params = {}) => `#/${route}${Object.keys(params).length ? '?' + qs(params) : ''}`;

const fmt = {
  num(v, d = 0) {
    if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '–';
    const n = Number(v);
    return n.toLocaleString('it-IT', { minimumFractionDigits: Number.isInteger(n) ? 0 : d, maximumFractionDigits: d });
  },
  dec(v) { return fmt.num(v, 1); },
  pct(v) {
    if (v === null || v === undefined || v === '') return '–';
    let n = Number(v);
    if (Number.isNaN(n)) return '–';
    if (n <= 1 && n > 0) n *= 100; // alcune API restituiscono 0..1
    return `${n.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`;
  },
  shot(made, failed) {
    if (made === undefined || made === null) return '–';
    const att = Number(made) + Number(failed || 0);
    return `${made}/${att}`;
  },
  shotPct(made, failed) {
    const att = Number(made || 0) + Number(failed || 0);
    return att ? `${Math.round((Number(made) / att) * 100)}%` : '–';
  },
  // timePlayed è in millisecondi (come nell'app: Duration.fromMillis -> mm:ss)
  // Alcuni campi (azioni, quintetti) sono in MILLISECONDI invece che in secondi.
  minsMs(ms) { return (ms === null || ms === undefined || ms === '') ? '–' : fmt.mins(Number(ms) / 1000); },
  // Il server esprime i tempi di gioco dei giocatori in SECONDI (es. 1266 = 21:06 a gara).
  mins(secs) {
    if (secs === null || secs === undefined || secs === '') return '–';
    const n = Number(secs);
    if (Number.isNaN(n)) return '–';
    const m = Math.floor(n / 60);
    const s = Math.round(n % 60);
    // gestisce l'arrotondamento di 59,5s → 60
    const mm = m + (s === 60 ? 1 : 0);
    return `${String(mm).padStart(2, '0')}:${String(s === 60 ? 0 : s).padStart(2, '0')}`;
  },
  date(v, withTime = true) {
    if (!v) return '–';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return esc(v);
    const opts = { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' };
    if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleString('it-IT', opts);
  },
  shortDate(v) {
    if (!v) return '–';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
  },
  name(p) { return [p?.name, p?.lastName].filter(Boolean).join(' ') || '—'; },
};

const STATUS = {
  FINISHED: ['Finale', 'grey'], CLOSED: ['Finale', 'grey'], LIVE: ['LIVE', 'live'], LIVE_NOT_AVAILABLE: ['In corso', 'live'],
  NOT_STARTED: ['Da giocare', ''], DEFERRED: ['Rinviata', 'grey'], POSTPONED: ['Rinviata', 'grey'],
};
function statusBadge(ts) {
  if (!ts?.status) return '';
  const [label, cls] = STATUS[ts.status] || [ts.status, 'grey'];
  const extra = ts.status === 'LIVE' && ts.period ? ` · Q${ts.period}` : '';
  return `<span class="badge ${cls}">${esc(label + extra)}</span>`;
}
const isPlayed = (m) => ['FINISHED', 'CLOSED', 'LIVE', 'LIVE_NOT_AVAILABLE'].includes(m?.timeStatus?.status) || !!m?.scores?.total?.homeScore;

// Iniziali per il segnaposto quando manca il logo/la foto.
function initials(name) {
  if (!name) return '';
  return String(name).replace(/\(.*?\)/g, ' ').split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, 3).map((w) => w[0]).join('').toUpperCase().slice(0, 3);
}
// Il server manda un URL http(s) completo quando il logo esiste, altrimenti valori
// come "N/A" o vuoto: quelli non sono immagini, quindi mostriamo un segnaposto con
// le iniziali invece di un'immagine rotta. Niente onerror inline (bloccato dalla CSP):
// gli errori di caricamento sono gestiti da un listener delegato più sotto.
function logo(url, cls = 'logo', name = '') {
  const ini = initials(name);
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    return `<img class="${cls}" src="${esc(url)}" loading="lazy" data-ph="${esc(ini)}" alt="">`;
  }
  return `<span class="${cls} ph">${esc(ini)}</span>`;
}
// Se un'immagine (logo/foto) non si carica, la sostituiamo col segnaposto a iniziali.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset && img.dataset.ph !== undefined) {
    const span = document.createElement('span');
    span.className = `${img.className} ph`;
    span.textContent = img.dataset.ph || '';
    img.replaceWith(span);
  }
}, true);

async function q(name, variables) {
  const { data, errors } = await window.fip.q(name, variables);
  if (errors?.length) console.warn(name, errors);
  return data;
}

// Una mutation: a differenza di q() propaga gli errori (serve per sapere se è andata a buon fine).
async function mutate(name, variables) {
  const { data, errors } = await window.fip.q(name, variables);
  if (errors?.length) throw new Error(errors[0].message || 'Operazione non riuscita.');
  return data;
}

// ---- Segui squadre / campionati ----
// Carica (e mette in cache) la lista di cosa segue l'utente, come insiemi di fid.
async function loadFollows(force = false) {
  if (state.follows && !force) return state.follows;
  const d = await q('USER_FOLLOWS');
  const f = d?.user?.following || {};
  state.follows = {
    teams: new Set((f.teams || []).map((t) => String(t.fid))),
    competitions: new Set((f.competitions || []).map((c) => String(c.fid))),
  };
  return state.follows;
}
function isFollowing(kind, fid) {
  if (!state.follows || fid == null) return false;
  const s = kind === 'team' ? state.follows.teams : state.follows.competitions;
  return s.has(String(fid));
}
// Il cmKey (codice campionato) a volte non è popolato su team/team.competition:
// lo risolviamo dalla query COMPETITION, che lo restituisce in modo affidabile. Cache per fid.
const _cmKeyCache = {};
async function resolveCmKey(projectKey, competitionFid) {
  if (!competitionFid) return undefined;
  if (competitionFid in _cmKeyCache) return _cmKeyCache[competitionFid];
  let ck;
  try { ck = one((await q('COMPETITION', { projectKey, fid: competitionFid }))?.competition)?.cmKey || undefined; }
  catch { ck = undefined; }
  _cmKeyCache[competitionFid] = ck;
  return ck;
}
// Attiva o disattiva il "segui" per una squadra o un campionato.
async function setFollow(kind, item, on) {
  const f = await loadFollows();
  if (kind === 'team') {
    let cmKey = item.cmKey || await resolveCmKey(item.projectKey, item.competitionFid);
    if (!cmKey) throw new Error('Codice campionato (cmKey) non disponibile per questa squadra.');
    const payload = { projectKey: item.projectKey, cmKey, fid: item.fid, competitionFid: item.competitionFid, notificationEnabled: false };
    await mutate(on ? 'UPSERT_TEAM_FOLLOW' : 'REMOVE_TEAM_FOLLOW', on ? { teamFollow: [payload] } : { teams: [payload] });
    if (on) f.teams.add(String(item.fid)); else f.teams.delete(String(item.fid));
  } else {
    const cmKey = item.cmKey || await resolveCmKey(item.projectKey, item.fid);
    if (!cmKey) throw new Error('Codice campionato (cmKey) non disponibile.');
    const payload = { projectKey: item.projectKey, cmKey, fid: item.fid, notificationEnabled: false };
    await mutate(on ? 'UPSERT_COMPETITION_FOLLOW' : 'REMOVE_COMPETITION_FOLLOW', on ? { competitionFollow: [payload] } : { competitions: [payload] });
    if (on) f.competitions.add(String(item.fid)); else f.competitions.delete(String(item.fid));
  }
}
// Collega il bottone #follow-btn renderizzato nell'intestazione di squadra/campionato.
async function wireFollow(kind, item) {
  const btn = $('#follow-btn');
  if (!btn) return;
  if (item.fid == null) { btn.remove(); return; } // senza fid non si può seguire
  const paint = () => {
    const on = isFollowing(kind, item.fid);
    btn.classList.toggle('active', on);
    btn.textContent = on ? '✓ Segui' : '+ Segui';
    btn.title = on ? 'Smetti di seguire' : 'Segui';
  };
  try { await loadFollows(); } catch { /* se non riesco a leggere, lascio stato neutro */ }
  btn.disabled = false;
  paint();
  btn.addEventListener('click', async () => {
    const want = !isFollowing(kind, item.fid);
    btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
    try { await setFollow(kind, item, want); paint(); }
    catch (err) { btn.textContent = prev; alertError(err); }
    btn.disabled = false;
  });
}

// L'utente è in modalità "Fan" (piano gratuito): lo sappiamo solo dopo aver letto i dati utente.
function isFan() { return state.user && state.user.premium === false; }
// Avviso: alcune informazioni sono complete solo col piano Gold.
function fanNotice(extra = '') {
  if (!isFan()) return '';
  return `<div class="notice fan"><strong>Modalità Fan.</strong> Alcune informazioni${extra ? ' ' + esc(extra) : ''} sono complete solo con il piano Gold, quindi qui alcuni dati possono risultare mancanti ("–").</div>`;
}
function loading(msg = 'Caricamento…') { return `<div class="loading">${esc(msg)}</div>`; }
function errorBox(err) {
  if (err?.code === 'USER_CONCURRENCY') {
    return `<div class="notice"><strong>Sessione su un altro dispositivo.</strong> ${esc(err.message)}
      <div style="margin-top:10px"><button class="btn primary" id="reclaim-btn">Usa qui</button></div>
      <div class="muted" style="margin-top:6px">FIP Stats consente una sola sessione per account alla volta: così la sposti sul computer e sul telefono dovrai rientrare.</div></div>`;
  }
  return `<div class="notice"><strong>Errore:</strong> ${esc(err?.message || err)}</div>`;
}

// Delega: il pulsante "Usa qui" riporta la sessione su questo computer e ricarica la pagina.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('#reclaim-btn');
  if (!btn) return;
  btn.disabled = true; btn.textContent = 'Sposto la sessione…';
  try { await window.fip.reclaim(); state.user = await window.fip.userInfo().catch(() => state.user); renderUserBadge(); router(); }
  catch (err) { btn.disabled = false; btn.textContent = 'Usa qui'; alertError(err); }
});

// Rende "sicura" una render asincrona: se nel frattempo si è cambiata pagina, non scrive.
function guard() {
  const t = ++state.renderToken;
  return (html) => { if (t === state.renderToken) { view().innerHTML = html; return true; } return false; };
}
function guardEl(el) {
  const t = state.renderToken;
  return (html) => { if (t === state.renderToken && el.isConnected) { el.innerHTML = html; return true; } return false; };
}

// ============================================================ tabelle ordinabili + CSV

/**
 * cols: [{ key, label, get?(row), fmt?(value,row), cls?, sort? }]
 */
function table(id, cols, rows, { totalRow = null, onRow = null, exportName = null } = {}) {
  const tbl = { cols, rows: rows.slice(), sortKey: null, sortDir: -1, onRow, totalRow, exportName };
  TABLES[id] = tbl;
  return `<div class="row" style="margin-bottom:6px">${exportName ? `<span class="spacer"></span><button class="btn small" data-export="${id}">Esporta CSV</button>` : ''}</div>
    <div class="table-wrap" id="tw-${id}">${renderTable(id)}</div>`;
}
const TABLES = {};
function cellValue(col, row) { return col.get ? col.get(row) : row?.[col.key]; }
function renderTable(id) {
  const t = TABLES[id];
  const rows = t.rows.slice();
  if (t.sortKey) {
    const col = t.cols.find((c) => c.key === t.sortKey);
    rows.sort((a, b) => {
      const va = col.sort ? col.sort(a) : cellValue(col, a);
      const vb = col.sort ? col.sort(b) : cellValue(col, b);
      const na = Number(va); const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * t.sortDir;
      return String(va ?? '').localeCompare(String(vb ?? ''), 'it') * t.sortDir;
    });
  }
  const head = t.cols.map((c) => `<th class="${c.cls || ''} ${t.sortKey === c.key ? 'sorted' : ''}" data-sort="${id}:${c.key}">${esc(c.label)}${t.sortKey === c.key ? (t.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const body = rows.map((r, i) => `<tr class="${t.onRow ? 'clickable' : ''}" data-row="${id}:${t.rows.indexOf(r)}">${t.cols.map((c) => {
    const v = cellValue(c, r);
    return `<td class="${c.cls || ''}">${c.fmt ? c.fmt(v, r) : esc(v ?? '–')}</td>`;
  }).join('')}</tr>`).join('');
  const total = t.totalRow ? `<tr class="total">${t.cols.map((c) => {
    const v = cellValue(c, t.totalRow);
    return `<td class="${c.cls || ''}">${c.fmt ? c.fmt(v, t.totalRow) : esc(v ?? '')}</td>`;
  }).join('')}</tr>` : '';
  return `<table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="l" colspan="${t.cols.length}">Nessun dato</td></tr>`}${total}</tbody></table>`;
}
function stripHtml(s) { const d = document.createElement('div'); d.innerHTML = s; return d.textContent; }
function tableCsv(id) {
  const t = TABLES[id];
  const line = (arr) => arr.map((v) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';');
  const val = (c, r) => {
    const v = cellValue(c, r);
    if (c.csv) return c.csv(v, r);
    if (c.fmt) return stripHtml(c.fmt(v, r));
    return v;
  };
  const out = [line(t.cols.map((c) => c.label))];
  for (const r of t.rows) out.push(line(t.cols.map((c) => val(c, r))));
  if (t.totalRow) out.push(line(t.cols.map((c) => val(c, t.totalRow))));
  return '﻿' + out.join('\n'); // BOM per Excel
}

document.addEventListener('click', async (e) => {
  const th = e.target.closest('th[data-sort]');
  if (th) {
    const [id, key] = th.dataset.sort.split(':');
    const t = TABLES[id];
    if (t.sortKey === key) t.sortDir *= -1; else { t.sortKey = key; t.sortDir = -1; }
    $(`#tw-${id}`).innerHTML = renderTable(id);
    return;
  }
  const tr = e.target.closest('tr[data-row]');
  if (tr) {
    const [id, idx] = tr.dataset.row.split(':');
    const t = TABLES[id];
    if (t?.onRow) t.onRow(t.rows[Number(idx)]);
    return;
  }
  const exp = e.target.closest('[data-export]');
  if (exp) {
    const id = exp.dataset.export;
    try {
      const p = await window.fip.saveCsv(`${TABLES[id].exportName}.csv`, tableCsv(id));
      if (p) exp.textContent = 'Salvato ✓';
    } catch (err) { alertError(err); }
    return;
  }
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = go.dataset.go; }
});

function alertError(err) {
  const n = document.createElement('div');
  n.className = 'notice';
  n.style.cssText = 'position:fixed;right:18px;bottom:18px;max-width:420px;z-index:50';
  n.innerHTML = `<strong>Errore:</strong> ${esc(err.message || err)}`;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 6000);
}

function tabs(id, items, active) {
  return `<div class="tabs" data-tabs="${id}">${items.map(([k, label]) => `<button data-tab="${k}" class="${k === active ? 'active' : ''}">${esc(label)}</button>`).join('')}</div><div id="tab-${id}"></div>`;
}
function bindTabs(id, handlers, first) {
  const bar = $(`[data-tabs="${id}"]`);
  const pane = $(`#tab-${id}`);
  const show = (k) => {
    $$('button', bar).forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
    setHashParam('tab', k);
    pane.innerHTML = loading();
    Promise.resolve(handlers[k](pane)).catch((err) => { pane.innerHTML = errorBox(err); });
  };
  bar.addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) show(b.dataset.tab); });
  show(first);
}

// ============================================================ componenti

function matchCard(m, { projectKey, competitionFid, competitionName } = {}) {
  const pk = m.projectKey || projectKey;
  const cf = m.competitionFid || m.competition?.fid || competitionFid;
  const t = m.scores?.total;
  const played = isPlayed(m) && t;
  const hw = played && Number(t.homeScore) > Number(t.awayScore);
  const aw = played && Number(t.awayScore) > Number(t.homeScore);
  const compName = competitionName || m.competition?.name || '';
  // Regione = "project" della competizione (comitato regionale FIP, es. "FIP Molise").
  const region = m.competition?.project?.name || m.competition?.projectName || '';
  const compLine = [compName, region].filter(Boolean).join(' · ');
  return `<div class="card link" data-go="${link('match', { pk, m: m.fid, c: cf })}">
    <div class="match">
      <div class="team ${hw ? 'winner' : ''}">${logo(m.homeTeam?.logo, 'logo', m.homeTeam?.name)}<span>${esc(m.homeTeam?.name)}</span></div>
      <div class="score ${played ? '' : 'pending'}">${played ? `${esc(t.homeScore)} – ${esc(t.awayScore)}` : (m.date ? new Date(m.date).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'vs')}</div>
      <div class="team away ${aw ? 'winner' : ''}">${logo(m.awayTeam?.logo, 'logo', m.awayTeam?.name)}<span>${esc(m.awayTeam?.name)}</span></div>
    </div>
    <div class="match-meta"><span>${fmt.date(m.date)}${m.court?.place ? ' · ' + esc(m.court.place) : ''}</span><span>${statusBadge(m.timeStatus)}</span></div>
    ${compLine ? `<div class="match-meta"><span>${esc(compLine)}</span></div>` : ''}
  </div>`;
}

// ============================================================ pagine

const routes = {};

// ---------- HOME
routes.home = async () => {
  const set = guard();
  set(`<h1>Home</h1><p class="muted">Squadre e giocatori che segui nell'app.</p>${loading()}`);
  try {
    const [home, follows] = await Promise.all([q('HOME'), q('USER_FOLLOWS').catch(() => null)]);
    const h = home?.home || {};
    let html = `<h1>Home</h1>`;

    // Partite di oggi delle competizioni seguite
    const comps = follows?.user?.following?.competitions || [];
    const teamsF = follows?.user?.following?.teams || [];
    const keys = [
      ...comps.map((c) => ({ projectKey: c.projectKey, competitionFid: c.fid })),
      ...teamsF.map((t) => ({ projectKey: t.projectKey, competitionFid: t.competitionFid })),
    ].filter((k, i, a) => k.projectKey && k.competitionFid && a.findIndex((x) => x.projectKey === k.projectKey && x.competitionFid === k.competitionFid) === i);
    html += `<h2>Partite di oggi</h2><div id="today">${keys.length ? loading() : '<div class="empty">Segui una competizione per vedere qui le partite del giorno.</div>'}</div>`;

    const ft = h.followsTeams || [];
    html += `<h2>Squadre seguite</h2>`;
    html += ft.length ? `<div class="grid">${ft.map((f) => {
      const team = f.team || {};
      const pk = h.competition?.projectKey || f.lastMatch?.projectKey || f.nextMatch?.projectKey;
      return `<div class="card">
        <div class="row"><a class="row" href="${link('team', { pk: team.projectKey || pk, c: team.competitionFid, t: team.fid })}">${logo(team.logo, 'logo', team.name)}<h3 style="margin:0">${esc(team.name)}</h3></a>
        <span class="spacer"></span><span class="muted">${esc(team.stats?.wins ?? '–')}V · ${esc(team.stats?.loses ?? '–')}P</span></div>
        ${f.lastMatch ? `<div style="margin-top:10px" class="muted">Ultima</div>${matchCard(f.lastMatch)}` : ''}
        ${f.nextMatch ? `<div style="margin-top:10px" class="muted">Prossima</div>${matchCard(f.nextMatch)}` : ''}
      </div>`;
    }).join('')}</div>` : '<div class="empty">Nessuna squadra seguita.</div>';

    const fp = h.followsPlayers || [];
    html += `<h2>Giocatori seguiti</h2>`;
    html += fp.length ? `<div class="grid">${fp.map((f) => {
      const p = f.player?.player || {};
      const last = f.player?.lastMatchStats;
      return `<div class="card">
        <div class="row">${logo(p.photo, 'photo', fmt.name(p))}<div><h3 style="margin:0">${esc(fmt.name(p))}</h3><div class="muted">${esc(p.team?.name)}</div></div></div>
        <div class="kpis" style="margin-top:10px">
          <div class="kpi"><div class="v">${fmt.dec(p.stats?.pointsPerGame)}</div><div class="l">PPG</div></div>
          <div class="kpi"><div class="v">${fmt.num(p.stats?.games)}</div><div class="l">Partite</div></div>
          <div class="kpi"><div class="v">${fmt.num(last?.points)}</div><div class="l">Pt ultima</div></div>
        </div>
        ${f.lastMatch ? `<div style="margin-top:10px">${matchCard(f.lastMatch)}</div>` : ''}
      </div>`;
    }).join('')}</div>` : '<div class="empty">Nessun giocatore seguito.</div>';

    if (!set(html)) return;

    if (keys.length) {
      const el = $('#today');
      const now = new Date();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      try {
        const d = await q('MATCHES_BY_DATE_RANGE', { keys, dateRange: { start: start.toISOString(), end: end.toISOString() } });
        const ms = d?.matchesByDateRange || [];
        guardEl(el)(ms.length ? `<div class="stack">${ms.map((m) => matchCard(m)).join('')}</div>` : '<div class="empty">Nessuna partita oggi nelle competizioni seguite.</div>');
      } catch (err) { guardEl(el)(errorBox(err)); }
    }
  } catch (err) { set(`<h1>Home</h1>${errorBox(err)}`); }
};

// ---------- CERCA
routes.search = async (params) => {
  const set = guard();
  const term = params.q || '';
  const kind = params.k || 'all';
  set(`<h1>Cerca</h1>
    <form id="search-form" class="row" style="margin:12px 0 4px">
      <input id="search-q" placeholder="Campionato, squadra o giocatore…" value="${esc(term)}" style="flex:1;min-width:260px" autofocus>
      <select id="search-k">
        ${[['all', 'Tutto'], ['competitions', 'Campionati'], ['teams', 'Squadre'], ['players', 'Giocatori']].map(([v, l]) => `<option value="${v}" ${v === kind ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn primary">Cerca</button>
    </form>
    <p class="muted">Stagione: ${esc(currentSeasonName())}. Cambiala dalla barra laterale.</p>
    <div id="search-res"></div>`);
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = link('search', { q: $('#search-q').value.trim(), k: $('#search-k').value });
  });
  if (!term) return;
  const el = $('#search-res');
  el.innerHTML = loading('Ricerca…');
  // Nella ricerca "Tutto" ogni categoria mostra pochi risultati; filtrando una categoria
  // ne mostriamo molti di più.
  const vars = { searchCriteria: term, seasonId: state.seasonId, searchOptions: { limit: kind === 'all' ? 30 : 200 } };
  // Titolo di sezione: nella vista "Tutto" è cliccabile e porta a tutti i risultati di quella categoria.
  const sec = (label, typeKey) => (kind === 'all' && typeKey
    ? `<h2 class="sec-head"><a href="${link('search', { q: term, k: typeKey })}">${esc(label)} <span class="see-all">vedi tutti →</span></a></h2>`
    : `<h2>${esc(label)}</h2>`);
  try {
    let comps = []; let teams = []; let players = []; let uniques = [];
    if (kind === 'all') {
      const d = await q('SEARCH', vars);
      for (const r of d?.search || []) {
        if (r.__typename === 'Competition') comps.push({ fid: r.cFid, name: r.competitionName, projectName: r.projectName, projectKey: r.cprojectKey, season: r.season });
        else if (r.__typename === 'Team') teams.push({ fid: r.tFid, name: r.teamName, logo: r.logo, competition: r.competition, competitionFid: r.competitionFid, projectKey: r.tprojectKey });
        else if (r.__typename === 'Player') players.push({ fid: r.pFid, name: r.playerName, lastName: r.lastName, photo: r.photo, team: r.team, competition: r.competition, competitionFid: r.competitionFid, projectKey: r.pprojectKey });
        else if (r.__typename === 'UniquePlayer') uniques.push({ id: r.uPid, name: r.name, lastName: r.uLastName, photo: r.uPhoto });
      }
    } else {
      const raw = await window.fip.raw(SEARCH_QUERIES[kind], vars);
      const list = raw.data?.[kind === 'competitions' ? 'searchCompetitions' : kind === 'teams' ? 'searchTeams' : 'searchPlayers'] || [];
      if (kind === 'competitions') comps = list; else if (kind === 'teams') teams = list; else players = list;
    }
    let html = '';
    if (comps.length) html += `${sec('Campionati', 'competitions')}<div class="list">${comps.map((c) => `<a class="item" href="${link('competition', { pk: c.projectKey, c: c.fid })}">
      <div><div><strong>${esc(c.name)}</strong></div><div class="sub">${esc(c.projectName)} · ${esc(c.season?.name)}</div></div></a>`).join('')}</div>`;
    if (teams.length) html += `${sec('Squadre', 'teams')}<div class="list">${teams.map((t) => `<a class="item" href="${link('team', { pk: t.projectKey, c: t.competitionFid, t: t.fid })}">
      ${logo(t.logo)}<div><div><strong>${esc(t.name)}</strong></div><div class="sub">${esc(t.competition?.name)} · ${esc(t.competition?.projectName)}</div></div></a>`).join('')}</div>`;
    if (uniques.length) html += `${sec('Profili giocatore', null)}<div class="list">${uniques.map((u) => `<a class="item" href="${link('unique', { id: u.id })}">
      ${logo(u.photo, 'photo', fmt.name(u))}<div><strong>${esc(fmt.name(u))}</strong><div class="sub">Tutte le squadre e stagioni</div></div></a>`).join('')}</div>`;
    if (players.length) html += `${sec('Giocatori', 'players')}<div class="list">${players.map((p) => `<a class="item" href="${link('player', { pk: p.projectKey, c: p.competitionFid, t: p.team?.fid, p: p.fid })}">
      ${logo(p.photo, 'photo', fmt.name(p))}<div><div><strong>${esc(fmt.name(p))}</strong></div><div class="sub">${esc(p.team?.name)} · ${esc(p.competition?.name)}</div></div></a>`).join('')}</div>`;
    guardEl(el)(html || '<div class="empty">Nessun risultato.</div>');
  } catch (err) { guardEl(el)(errorBox(err)); }
};

const SEARCH_QUERIES = {
  competitions: `query SearchCompetitions($searchCriteria: String!, $seasonId: String!, $searchOptions: ISearchOptions!) {
    searchCompetitions(searchCriteria: $searchCriteria, seasonId: $seasonId, searchOptions: $searchOptions) { fid name season { name } projectKey projectName cmKey } }`,
  teams: `query SearchTeams($searchCriteria: String!, $seasonId: String!, $searchOptions: ISearchOptions!) {
    searchTeams(searchCriteria: $searchCriteria, seasonId: $seasonId, searchOptions: $searchOptions) { fid name logo season { name } cmKey competition { name projectName } projectKey competitionFid } }`,
  players: `query SearchPlayers($searchCriteria: String!, $seasonId: String!, $searchOptions: ISearchOptions!) {
    searchPlayers(searchCriteria: $searchCriteria, seasonId: $seasonId, searchOptions: $searchOptions) { fid name lastName photo team { name fid } season { name } competition { name projectName } competitionFid projectKey } }`,
};

// Alcune query di dettaglio restituiscono una LISTA ([ {oggetto} ]): prendiamo il primo.
const one = (x) => (Array.isArray(x) ? x[0] : x);

// ---------- COMPETIZIONE
routes.competition = async (params) => {
  const set = guard();
  const pk = params.pk; const cf = params.c;
  set(loading());
  let comp;
  try {
    comp = one((await q('COMPETITION', { projectKey: pk, fid: cf }))?.competition);
    if (!comp) throw new Error('Competizione non trovata.');
  } catch (err) { set(errorBox(err)); return; }

  const groups = (comp.groups || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const gid = params.g || groups[0]?.id;
  const ok = set(`<div class="crumbs">${esc(comp.season?.name)}</div>
    <div class="page-head"><div><h1>${esc(comp.name)}</h1>
    <div class="row muted">${comp.freeContent ? '<span class="badge grey">Gratis</span>' : '<span class="badge">Gold</span>'}
      ${groups.length > 1 ? `<label class="row">Girone <select id="group-select">${groups.map((g) => `<option value="${esc(g.id)}" ${g.id === gid ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
    </div></div>
    <button id="follow-btn" class="btn follow" disabled>Segui</button></div>
    ${comp.freeContent ? '' : fanNotice('di questo campionato')}
    ${tabs('comp', [['calendar', 'Calendario'], ['standings', 'Classifica'], ['stats', 'Classifiche giocatori'], ['totals', 'Numeri del campionato']], params.tab || 'calendar')}`);
  if (!ok) return;
  wireFollow('competition', { projectKey: comp.projectKey || pk, cmKey: comp.cmKey, fid: comp.fid || cf });
  $('#group-select')?.addEventListener('change', (e) => { location.hash = link('competition', { pk, c: cf, g: e.target.value }); });

  bindTabs('comp', {
    calendar: async (pane) => {
      if (!gid) { pane.innerHTML = '<div class="empty">Nessun girone disponibile.</div>'; return; }
      const d = await q('COMPETITION_GROUP', { projectKey: pk, competitionFid: cf, groupFid: gid });
      const grp = one(d?.group);
      const rounds = (grp?.rounds || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      if (!rounds.length) { pane.innerHTML = '<div class="empty">Nessuna giornata.</div>'; return; }
      // Giornata da mostrare all'apertura: quella con la PROSSIMA partita da giocare
      // (la data futura più vicina a oggi). Se la stagione è finita, l'ultima con partite.
      const now = Date.now();
      let cur = -1; let best = Infinity;
      rounds.forEach((r, i) => {
        for (const m of r.matches || []) {
          const t = new Date(m.date).getTime();
          if (!Number.isNaN(t) && t >= now && t < best) { best = t; cur = i; }
        }
      });
      if (cur < 0) {
        for (let i = rounds.length - 1; i >= 0; i--) {
          if ((rounds[i].matches || []).some((m) => !Number.isNaN(new Date(m.date).getTime()))) { cur = i; break; }
        }
        if (cur < 0) cur = rounds.length - 1;
      }
      const draw = (i) => {
        const r = rounds[i];
        const ms = (r.matches || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        pane.innerHTML = `<div class="rounds">${rounds.map((x, j) => `<button class="btn small ${j === i ? 'active' : ''}" data-round="${j}">${esc(x.name || `G${j + 1}`)}</button>`).join('')}</div>
          <p class="muted">${fmt.date(r.startDate, false)} – ${fmt.date(r.endDate, false)}</p>
          <div class="stack">${ms.map((m) => matchCard(m, { projectKey: pk, competitionFid: cf })).join('') || '<div class="empty">Nessuna partita.</div>'}</div>`;
        $$('[data-round]', pane).forEach((b) => b.addEventListener('click', () => draw(Number(b.dataset.round))));
        $(`[data-round="${i}"]`, pane)?.scrollIntoView({ inline: 'center', block: 'nearest' });
      };
      draw(cur);
    },
    standings: async (pane) => {
      const d = await q('STANDINGS', { projectKey: pk, provider: comp.cmKey, groupId: gid });
      const rows = (d?.standing || []).slice().sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
      pane.innerHTML = table('standings', [
        { key: 'position', label: '#', cls: 'l' },
        { key: 'name', label: 'Squadra', cls: 'l', fmt: (v, r) => `<span class="name">${logo(r.logo, 'logo', v)}${esc(v)}</span>`, csv: (v) => v },
        { key: 'g', label: 'G', get: (r) => r.stats?.playedMatches },
        { key: 'w', label: 'V', get: (r) => r.stats?.wonMatches },
        { key: 'l', label: 'P', get: (r) => r.stats?.lostMatches },
        { key: 'pct', label: '% V', get: (r) => (r.stats?.playedMatches ? r.stats.wonMatches / r.stats.playedMatches : null), fmt: (v) => (v === null ? '–' : `${Math.round(v * 100)}%`) },
        { key: 'ppg', label: 'PF/G', get: (r) => r.stats?.pointsPerGame, fmt: fmt.dec },
        { key: 'oppg', label: 'PS/G', get: (r) => r.stats?.opponentsPointsPerGame, fmt: fmt.dec },
        { key: 'diff', label: 'Diff/G', get: (r) => (r.stats ? r.stats.pointsPerGame - r.stats.opponentsPointsPerGame : null), fmt: (v) => (v === null || Number.isNaN(v) ? '–' : `${v > 0 ? '+' : ''}${fmt.dec(v)}`) },
      ], rows, { exportName: `classifica-${slug(comp.name)}`, onRow: (r) => { location.hash = link('team', { pk, c: cf, t: r.fid }); } });
    },
    stats: async (pane) => renderPlayerRankings(pane, comp, pk, cf, gid, groups),
    totals: async (pane) => {
      const d = await q('COMPETITION_STATS', { projectKey: pk, competitionFid: cf });
      const s = d?.competitionStats;
      if (!s) { pane.innerHTML = '<div class="empty">Dati non disponibili.</div>'; return; }
      const items = [['Partite', s.games], ['Giocatori', s.players], ['Media gare/giocatore', s.avgGamesPlayers, 1], ['Punti', s.points],
        ['Tiri da 2', fmt.shot(s.inArcThrowsMade, s.inArcThrowsFailed)], ['Tiri da 3', fmt.shot(s.outArcThrowsMade, s.outArcThrowsFailed)],
        ['Tiri liberi', fmt.shot(s.freeThrowsMade, s.freeThrowsFailed)], ['Rimbalzi off.', s.offensiveRebounds], ['Rimbalzi dif.', s.defensiveRebounds],
        ['Assist', s.assists], ['Palle perse', s.turnovers], ['Recuperi', s.steals], ['Stoppate', s.blocks], ['Falli', s.fouls], ['Valutazione', s.fibaRating]];
      pane.innerHTML = `<div class="kpis">${items.map(([l, v, d2]) => `<div class="kpi"><div class="v">${typeof v === 'string' ? esc(v) : fmt.num(v, d2 || 0)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>
        ${s.games ? `<h2>Medie per partita</h2><div class="kpis">${[['Punti', s.points], ['Assist', s.assists], ['Rimbalzi', (s.offensiveRebounds || 0) + (s.defensiveRebounds || 0)], ['Palle perse', s.turnovers], ['Falli', s.fouls]].map(([l, v]) => `<div class="kpi"><div class="v">${fmt.dec(v / s.games)}</div><div class="l">${l}</div></div>`).join('')}</div>` : ''}`;
    },
  }, params.tab || 'calendar');
};

const ORDER_FALLBACK = ['POINTS', 'POINTS_AVG', 'FIBA_RATING', 'ASSISTS', 'REBOUNDS', 'STEALS', 'BLOCKS', 'FREE_THROWS', 'IN_ARC_THROWS', 'OUT_ARC_THROWS'];
async function loadOrderStats() {
  if (state.orderStats) return state.orderStats;
  try {
    const r = await window.fip.raw('query { t: __type(name: "OrderStats") { enumValues { name } } s: __type(name: "TypeStat") { enumValues { name } } }', {});
    const o = r.data?.t?.enumValues?.map((e) => e.name);
    const t = r.data?.s?.enumValues?.map((e) => e.name);
    state.orderStats = { order: o?.length ? o : ORDER_FALLBACK, types: t?.length ? t : ['SIMPLE', 'ADVANCED'], introspected: !!o?.length };
  } catch {
    state.orderStats = { order: ORDER_FALLBACK, types: ['SIMPLE', 'ADVANCED'], introspected: false };
  }
  return state.orderStats;
}

async function renderPlayerRankings(pane, comp, pk, cf, gid, groups) {
  const enums = await loadOrderStats();
  const defType = enums.types.includes(comp.statsType) ? comp.statsType : (enums.types.includes(comp.configuration?.statsType) ? comp.configuration.statsType : enums.types[0]);
  pane.innerHTML = `<div class="row" style="margin-bottom:12px">
    <label class="row">Ordina per <select id="rk-order">${enums.order.map((o) => `<option ${o.toUpperCase().startsWith('POINTS') && !o.includes('AVG') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
    <label class="row">Tipo <select id="rk-type">${enums.types.map((t) => `<option ${t === defType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
    ${groups.length > 1 ? `<label class="row"><input type="checkbox" id="rk-group"> Solo girone selezionato</label>` : ''}
    <label class="row">Risultati <select id="rk-limit"><option>25</option><option selected>50</option><option>100</option><option>200</option></select></label>
    </div>${enums.introspected ? '' : '<p class="muted">Elenco dei criteri di ordinamento stimato: se il server rifiuta un valore, provane un altro.</p>'}<div id="rk-out"></div>`;
  const run = async () => {
    const out = $('#rk-out');
    out.innerHTML = loading();
    const order = $('#rk-order').value; const typeStat = $('#rk-type').value;
    const limit = Number($('#rk-limit').value);
    const onlyGroup = $('#rk-group')?.checked;
    try {
      let list;
      if (onlyGroup) {
        const d = await q('GROUP_PLAYER_STATS', { projectKey: pk, competitionFid: cf, groupsFid: [gid], order, typeStat, pagination: { cursor: '', limit } });
        list = d?.groupPlayerStats;
      } else {
        const d = await q('COMPETITION_PLAYER_STATS', { projectKey: pk, competitionFid: cf, order, typeStat, pagination: { cursor: '', limit } });
        list = d?.competitionPlayerStats;
      }
      list = Array.isArray(list) ? list : (list?.items || list?.data || []);
      out.innerHTML = table('rank', [
        { key: 'i', label: '#', cls: 'l', get: (r) => list.indexOf(r) + 1 },
        { key: 'name', label: 'Giocatore', cls: 'l', get: (r) => fmt.name(r.player), fmt: (v, r) => `<span class="name">${logo(r.player?.photo, 'photo', fmt.name(r.player))}${esc(v)}</span>`, csv: (v) => v },
        { key: 'team', label: 'Squadra', cls: 'l', get: (r) => r.player?.team?.name },
        { key: 'games', label: 'G' },
        { key: 'points', label: 'PT' }, { key: 'pointsAVG', label: 'PT/G', fmt: fmt.dec },
        { key: 'p2', label: '2P', get: (r) => r.inArcThrowsMade, fmt: (v, r) => fmt.shot(r.inArcThrowsMade, r.inArcThrowsFailed) },
        { key: 'inArcThrowsPercentage', label: '2P%', fmt: fmt.pct },
        { key: 'p3', label: '3P', get: (r) => r.outArcThrowsMade, fmt: (v, r) => fmt.shot(r.outArcThrowsMade, r.outArcThrowsFailed) },
        { key: 'outArcThrowsPercentage', label: '3P%', fmt: fmt.pct },
        { key: 'ft', label: 'TL', get: (r) => r.freeThrowsMade, fmt: (v, r) => fmt.shot(r.freeThrowsMade, r.freeThrowsFailed) },
        { key: 'freeThrowsPercentage', label: 'TL%', fmt: fmt.pct },
        { key: 'reb', label: 'RIM', get: (r) => (r.offensiveRebounds ?? 0) + (r.defensiveRebounds ?? 0) },
        { key: 'reboundsAVG', label: 'RIM/G', fmt: fmt.dec },
        { key: 'assists', label: 'AS' }, { key: 'assistsAVG', label: 'AS/G', fmt: fmt.dec },
        { key: 'steals', label: 'REC' }, { key: 'blocks', label: 'STO' },
        { key: 'fibaRating', label: 'VAL' }, { key: 'fibaRatingAVG', label: 'VAL/G', fmt: fmt.dec },
      ], list, { exportName: `classifica-giocatori-${slug(comp.name)}-${order}`, onRow: (r) => { location.hash = link('player', { pk, c: cf, t: r.player?.teamFid, p: r.player?.fid }); } });
    } catch (err) { out.innerHTML = errorBox(err); }
  };
  ['#rk-order', '#rk-type', '#rk-limit', '#rk-group'].forEach((s) => $(s, pane)?.addEventListener('change', run));
  run();
}

// ---------- SQUADRA
routes.team = async (params) => {
  const set = guard();
  const { pk, c: cf, t: tf } = params;
  set(loading());
  let team; let matches = [];
  try {
    const [tData, sData] = await Promise.all([
      q('TEAM', { projectKey: pk, competitionFid: cf, fid: tf }).then((d) => d?.team),
      q('TEAM_SCHEDULE', { projectKey: pk, competitionFid: cf, teamFid: tf }).then((d) => d?.teamMatch || []).catch(() => []),
    ]);
    team = tData;
    if (!team) throw new Error('Squadra non trovata.');
    matches = (sData || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    team._mid = resolveTeamId(matches); // id interno della squadra nel calendario
    if (!team.name) team.name = deriveTeamName(team, matches); // nome mancante → dal calendario
  } catch (err) { set(errorBox(err)); return; }
  const roster = team.players || [];
  const byFid = Object.fromEntries(roster.map((p) => [p.fid, p]));
  // Il server spesso non popola team.stats: in quel caso calcoliamo il record dalle partite.
  const rec = teamRecord(matches, team);
  const wins = team.stats?.wins ?? rec.wins;
  const losses = team.stats?.loses ?? rec.losses;
  const pfg = team.stats?.pointsPerGame ?? rec.pfg;
  const psg = team.stats?.opponentsPointsPerGame ?? rec.psg;
  const ok = set(`<div class="crumbs"><a href="${link('competition', { pk, c: cf })}">${esc(team.competition?.name)}</a></div>
    <div class="page-head">${logo(team.logo, 'logo', team.name)}<div><h1>${esc(team.name)}</h1>
      <div class="muted">${esc(wins ?? '–')} vinte · ${esc(losses ?? '–')} perse · ${fmt.dec(pfg)} PF/G · ${fmt.dec(psg)} PS/G</div></div>
      <button id="follow-btn" class="btn follow" disabled>Segui</button></div>
    ${tabs('team', [['schedule', 'Calendario'], ['players', 'Giocatori'], ['teamstats', 'Statistiche squadra'], ['standing', 'Classifica'], ['lineups', 'Quintetti']], params.tab || 'schedule')}`);
  if (!ok) return;
  wireFollow('team', { projectKey: team.projectKey || pk, cmKey: team.cmKey || team.competition?.cmKey, fid: team.fid || tf, competitionFid: team.competitionFid || cf });

  bindTabs('team', {
    schedule: async (pane) => {
      const ms = matches;
      const played = ms.filter((m) => isPlayed(m)); const next = ms.filter((m) => !isPlayed(m));
      pane.innerHTML = `${next.length ? `<h2>Prossime</h2><div class="stack">${next.map((m) => matchCard(m, { projectKey: pk, competitionFid: cf })).join('')}</div>` : ''}
        <h2>Giocate</h2>${table('results', [
          { key: 'date', label: 'Data', cls: 'l', fmt: (v) => fmt.shortDate(v), sort: (r) => new Date(r.date).getTime() },
          { key: 'opp', label: 'Avversario', cls: 'l', get: (r) => (isHome(r, team) ? r.awayTeam?.name : r.homeTeam?.name) },
          { key: 'ha', label: 'C/T', get: (r) => (isHome(r, team) ? 'Casa' : 'Trasferta') },
          { key: 'res', label: 'Risultato', get: (r) => `${r.scores?.total?.homeScore ?? '–'}-${r.scores?.total?.awayScore ?? '–'}` },
          { key: 'wl', label: 'Esito', get: (r) => teamResult(r, team), fmt: (v) => (v === 'V' ? `<span style="color:var(--good);font-weight:700">V</span>` : v === 'P' ? `<span style="color:var(--bad);font-weight:700">P</span>` : '–'), csv: (v) => v },
          { key: 'diff', label: '+/-', get: (r) => teamDiff(r, team), fmt: (v) => (v === null ? '–' : `${v > 0 ? '+' : ''}${v}`) },
        ], played.reverse(), { exportName: `risultati-${slug(team.name)}`, onRow: (r) => { location.hash = link('match', { pk, m: r.fid, c: cf }); } })}`;
    },
    players: async (pane) => {
      const d = await q('TEAM_BOXSCORES', { projectKey: pk, competitionFid: cf, teamFid: tf }).catch(() => null);
      const box = d?.teamBoxscores || [];
      // Il tabellino squadra dà solo playerFid. I nomi di norma vengono dalla rosa
      // (team.players), ma in diverse competizioni la rosa torna vuota: in quel caso
      // risolviamo l'anagrafica di ogni playerFid con un'unica richiesta in blocco.
      const idx = {};
      for (const p of roster) for (const k of [p.fid, p.id]) if (k != null) idx[String(k)] = p;
      const named = (b) => idx[String(b.playerFid)];
      if (box.length && !box.some(named)) {
        try {
          const fids = [...new Set(box.map((b) => String(b.playerFid)).filter((f) => f && f !== 'null'))];
          const parts = fids.map((f, i) => `p${i}: player(projectKey:$pk, competitionFid:$cf, teamFid:$tf, fid:${JSON.stringify(f)}){ fid name lastName number photo }`);
          const res = await window.fip.raw(`query($pk:String!,$cf:String!,$tf:String!){ ${parts.join(' ')} }`, { pk, cf, tf });
          fids.forEach((f, i) => { const pl = res.data?.[`p${i}`]; if (pl) idx[f] = pl; });
        } catch (e) { console.warn('anagrafica giocatori', e); }
      }
      let rows;
      if (box.length) {
        rows = box.map((b) => { const p = idx[String(b.playerFid)] || { fid: b.playerFid, name: '' }; return { ...b, p, _pid: p.fid || p.id || b.playerFid }; });
      } else {
        rows = roster.map((p) => ({ p, _pid: p.fid || p.id, games: p.stats?.games, pointsAVG: p.stats?.pointsPerGame }));
      }
      pane.innerHTML = table('roster', [
        { key: 'num', label: '#', cls: 'l', get: (r) => r.p.number },
        { key: 'name', label: 'Giocatore', cls: 'l', get: (r) => fmt.name(r.p), fmt: (v, r) => `<span class="name">${logo(r.p.photo, 'photo', fmt.name(r.p))}${esc(v)}</span>`, csv: (v) => v },
        { key: 'games', label: 'G' },
        { key: 'timePlayedAVG', label: 'MIN/G', fmt: fmt.mins },
        { key: 'pointsAVG', label: 'PT/G', fmt: fmt.dec },
        { key: 'points', label: 'PT' },
        { key: 'p2', label: '2P', get: (r) => r.inArcThrowsMade, fmt: (v, r) => fmt.shot(r.inArcThrowsMade, r.inArcThrowsFailed) },
        { key: 'p2p', label: '2P%', get: (r) => r.inArcThrowsPercentage, fmt: fmt.pct },
        { key: 'p3', label: '3P', get: (r) => r.outArcThrowsMade, fmt: (v, r) => fmt.shot(r.outArcThrowsMade, r.outArcThrowsFailed) },
        { key: 'p3p', label: '3P%', get: (r) => r.outArcThrowsPercentage, fmt: fmt.pct },
        { key: 'ft', label: 'TL', get: (r) => r.freeThrowsMade, fmt: (v, r) => fmt.shot(r.freeThrowsMade, r.freeThrowsFailed) },
        { key: 'ftp', label: 'TL%', get: (r) => r.freeThrowsPercentage, fmt: fmt.pct },
        { key: 'reb', label: 'RIM/G', get: (r) => (r.offensiveReboundsAVG ?? 0) + (r.defensiveReboundsAVG ?? 0), fmt: fmt.dec },
        { key: 'assistsAVG', label: 'AS/G', fmt: fmt.dec },
        { key: 'stealsAVG', label: 'REC/G', fmt: fmt.dec },
        { key: 'turnoversAVG', label: 'PP/G', fmt: fmt.dec },
        { key: 'foulsAVG', label: 'FALLI/G', fmt: fmt.dec },
        { key: 'plusMinusAVG', label: '+/-/G', fmt: fmt.dec },
      ], rows, { exportName: `giocatori-${slug(team.name)}`, onRow: (r) => { location.hash = link('player', { pk, c: cf, t: tf, p: r._pid }); } });
    },
    teamstats: async (pane) => {
      const d = await q('TEAM_STATS', { projectKey: pk, competitionFid: cf, teamFid: tf });
      const s = d?.competitionStatsByTeam;
      if (!s) { pane.innerHTML = '<div class="empty">Dati non disponibili.</div>'; return; }
      const k = (l, v) => `<div class="kpi"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;
      pane.innerHTML = `<div class="kpis">
        ${k('Partite', fmt.num(s.games))}${k('Vinte', `${fmt.num(s.wins)} (${fmt.pct(s.winsPercentage)})`)}${k('Perse', fmt.num(s.losses))}
        ${k('Punti fatti/G', fmt.dec(s.pointsAVG))}${k('Punti subiti/G', fmt.dec(s.pointsConcededAVG))}${k('+/-/G', fmt.dec(s.plusMinusAVG))}
        ${k('Eff. offensiva', fmt.dec(s.offensiveEfficiency))}${k('Eff. difensiva', fmt.dec(s.defensiveEfficiency))}</div>
        <h2>Tiro</h2><div class="kpis">
        ${k('Da 2', `${fmt.shot(s.inArcThrowsMade, s.inArcThrowsFailed)} · ${fmt.pct(s.inArcThrowsPercentage)}`)}
        ${k('Da 3', `${fmt.shot(s.outArcThrowsMade, s.outArcThrowsFailed)} · ${fmt.pct(s.outArcThrowsPercentage)}`)}
        ${k('Liberi', `${fmt.shot(s.freeThrowsMade, s.freeThrowsFailed)} · ${fmt.pct(s.freeThrowsPercentage)}`)}
        ${k('Tiri da 2/G', fmt.dec(s.inArcThrowsAVG))}${k('Tiri da 3/G', fmt.dec(s.outArcThrowsAVG))}</div>
        <h2>Medie per partita</h2><div class="kpis">
        ${k('Rimb. off.', fmt.dec(s.offensiveReboundsAVG))}${k('Rimb. dif.', fmt.dec(s.defensiveReboundsAVG))}${k('Assist', fmt.dec(s.assistsAVG))}
        ${k('Recuperi', fmt.dec(s.stealsAVG))}${k('Palle perse', fmt.dec(s.turnoversAVG))}${k('Stoppate', fmt.dec(s.blocksAVG))}${k('Falli', fmt.dec(s.foulsAVG))}</div>`;
    },
    standing: async (pane) => {
      const d = await q('STANDINGS_BY_TEAM', { projectKey: pk, competitionFid: cf, teamFid: tf });
      const groups = d?.standingsByTeam || [];
      if (!groups.length) { pane.innerHTML = '<div class="empty">Classifica non disponibile.</div>'; return; }
      pane.innerHTML = groups.map((g, gi) => `<h2>${esc(g.group?.name || 'Classifica')}</h2>` + table(`stb${gi}`, [
        { key: 'position', label: '#', cls: 'l' },
        { key: 'name', label: 'Squadra', cls: 'l', fmt: (v, r) => `<span class="name">${logo(r.logo, 'logo', v)}${r.fid === tf ? `<strong>${esc(v)}</strong>` : esc(v)}</span>`, csv: (v) => v },
        { key: 'g', label: 'G', get: (r) => r.stats?.playedMatches },
        { key: 'w', label: 'V', get: (r) => r.stats?.wonMatches },
        { key: 'l', label: 'P', get: (r) => r.stats?.lostMatches },
        { key: 'ppg', label: 'PF/G', get: (r) => r.stats?.pointsPerGame, fmt: fmt.dec },
        { key: 'oppg', label: 'PS/G', get: (r) => r.stats?.opponentsPointsPerGame, fmt: fmt.dec },
      ], (g.standings || []).slice().sort((a, b) => a.position - b.position), { onRow: (r) => { location.hash = link('team', { pk, c: cf, t: r.fid }); } })).join('');
    },
    lineups: async (pane) => {
      const d = await q('TEAM_LINEUPS', { projectKey: pk, competitionFid: cf, teamFid: tf, options: { orderField: 'timePlayed', orderType: 'DESC', limit: 100 } });
      const lus = (one(d?.competitionLineupStats)?.lineups || []).filter((l) => Number(l.stats?.timePlayed) > 0);
      if (!lus.length) { pane.innerHTML = '<div class="empty">Statistiche dei quintetti non disponibili per questa competizione.</div>'; return; }
      pane.innerHTML = lineupTable('tlu', lus, true, `quintetti-${slug(team.name)}`);
    },
  }, params.tab || 'schedule');
};

function lineupTable(id, lus, avg, exportName) {
  return table(id, [
    { key: 'players', label: 'Quintetto', cls: 'l', get: (r) => (r.players || []).map((p) => p.lastName || p.name).join(' · ') },
    ...(avg ? [{ key: 'games', label: 'G', get: (r) => r.stats?.games }, { key: 'min', label: 'MIN/G', get: (r) => r.stats?.timePlayedAVG, fmt: fmt.minsMs }]
      : [{ key: 'min', label: 'MIN', get: (r) => r.stats?.timePlayed, fmt: fmt.minsMs }]),
    { key: 'pts', label: avg ? 'PF/G' : 'PF', get: (r) => (avg ? r.stats?.pointsAVG : r.stats?.points), fmt: fmt.dec },
    { key: 'ptsr', label: avg ? 'PS/G' : 'PS', get: (r) => (avg ? r.stats?.pointsReceivedAVG : r.stats?.pointsReceived), fmt: fmt.dec },
    { key: 'pm', label: '+/-', get: (r) => (avg ? r.stats?.plusMinusAVG : r.stats?.plusMinus), fmt: fmt.dec },
    { key: 'oe', label: 'Eff. off.', get: (r) => r.stats?.offensiveEfficiency, fmt: fmt.dec },
    { key: 'de', label: 'Eff. dif.', get: (r) => r.stats?.defensiveEfficiency, fmt: fmt.dec },
    { key: 'p2', label: '2P%', get: (r) => r.stats?.inArcThrowsPercentage, fmt: fmt.pct },
    { key: 'p3', label: '3P%', get: (r) => r.stats?.outArcThrowsPercentage, fmt: fmt.pct },
    { key: 'ft', label: 'TL%', get: (r) => r.stats?.freeThrowsPercentage, fmt: fmt.pct },
    { key: 'reb', label: avg ? 'RIM/G' : 'RIM', get: (r) => (avg ? r.stats?.reboundsAVG : r.stats?.rebounds), fmt: fmt.dec },
    { key: 'ast', label: avg ? 'AS/G' : 'AS', get: (r) => (avg ? r.stats?.assistsAVG : r.stats?.assists), fmt: fmt.dec },
    { key: 'to', label: avg ? 'PP/G' : 'PP', get: (r) => (avg ? r.stats?.turnoversAVG : r.stats?.turnovers), fmt: fmt.dec },
  ], lus, { exportName });
}

function teamKey(s) { return String(s || '').toUpperCase().replace(/\(.*?\)/g, ' ').replace(/[^A-Z0-9]/g, ''); }
// Nel calendario il server dà fid=null e un nome spesso diverso da quello della pagina
// squadra. L'unico identificatore affidabile è l'`id` interno della partita: la nostra
// squadra è l'unico id presente in TUTTE le sue partite, quindi lo ricaviamo per frequenza.
function resolveTeamId(matches) {
  const count = {};
  for (const m of matches || []) for (const s of [m.homeTeam, m.awayTeam]) {
    const id = s?.id; if (id != null) count[id] = (count[id] || 0) + 1;
  }
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return null;
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null; // ambiguo (es. una sola partita)
  return sorted[0][0];
}
// Il server a volte non popola team.name (come succede con team.players in alcune
// competizioni): in quel caso ricaviamo il nome dal calendario, dove la squadra
// compare come home o away, individuata col suo id interno (_mid) o col fid.
function deriveTeamName(team, matches) {
  const mid = team?._mid;
  const tf = team?.fid;
  for (const m of matches || []) {
    if (mid != null) {
      if (String(m.homeTeam?.id) === String(mid)) return m.homeTeam?.name || '';
      if (String(m.awayTeam?.id) === String(mid)) return m.awayTeam?.name || '';
    }
  }
  for (const m of matches || []) {
    if (tf != null) {
      if (String(m.homeTeam?.fid) === String(tf)) return m.homeTeam?.name || '';
      if (String(m.awayTeam?.fid) === String(tf)) return m.awayTeam?.name || '';
    }
  }
  return '';
}
function isHome(m, team) {
  const mid = team && team._mid;
  if (mid != null) {
    if (m.homeTeam?.id != null && String(m.homeTeam.id) === String(mid)) return true;
    if (m.awayTeam?.id != null && String(m.awayTeam.id) === String(mid)) return false;
  }
  const h = m.homeTeam || {};
  if (h.fid && team.fid) return h.fid === team.fid;
  return teamKey(h.name) === teamKey(team.name);
}
// Record (V, P, PF/G, PS/G) calcolato dalle partite giocate, quando il server non lo fornisce.
function teamRecord(matches, team) {
  let wins = 0, losses = 0, pf = 0, pa = 0, games = 0;
  for (const m of matches) {
    if (!isPlayed(m)) continue;
    const t = m.scores?.total;
    if (!t || t.homeScore == null) continue;
    const home = isHome(m, team);
    const my = Number(home ? t.homeScore : t.awayScore);
    const opp = Number(home ? t.awayScore : t.homeScore);
    if (Number.isNaN(my) || Number.isNaN(opp)) continue;
    games++; pf += my; pa += opp;
    if (my > opp) wins++; else if (opp > my) losses++;
  }
  return { wins, losses, games, pfg: games ? pf / games : null, psg: games ? pa / games : null };
}
function teamDiff(m, team) {
  const t = m.scores?.total; if (!t || t.homeScore == null) return null;
  const d = Number(t.homeScore) - Number(t.awayScore);
  return isHome(m, team) ? d : -d;
}
function teamResult(m, team) { const d = teamDiff(m, team); return d === null ? '' : d > 0 ? 'V' : d < 0 ? 'P' : 'N'; }

// ---------- PARTITA
// Il server restituisce matchBy come LISTA ([ {partita} ]): prendiamo il primo elemento.
const mBy = (d) => { const x = d?.matchBy; return Array.isArray(x) ? x[0] : x; };
routes.match = async (params) => {
  const set = guard();
  const { pk, m: mf } = params;
  set(loading());
  let match;
  try {
    match = mBy(await q('MATCH', { matchFid: mf, projectKey: pk, lang: 'it' }));
    if (!match) throw new Error('Partita non trovata.');
  } catch (err) { set(errorBox(err)); return; }
  const cf = params.c || match.competition?.fid;
  const H = match.homeTeam || {}; const A = match.awayTeam || {};
  const t = match.scores?.total || {};
  const partials = (match.scores?.partials || []).slice().sort((a, b) => a.period - b.period);
  const played = isPlayed(match);
  const playersByFid = {};
  for (const p of H.players || []) playersByFid[p.fid] = { ...p, side: 'home' };
  for (const p of A.players || []) playersByFid[p.fid] = { ...p, side: 'away' };

  const teamLink = (tm) => link('team', { pk, c: cf, t: tm.fid });
  const ok = set(`<div class="crumbs"><a href="${link('competition', { pk, c: cf })}">${esc(match.competition?.name)}</a>${match.roundName ? ' · ' + esc(match.roundName) : ''}</div>
    <div class="scoreboard">
      <a class="side" href="${teamLink(H)}">${logo(H.logo, 'logo', H.name)}<span>${esc(H.name)}</span><span class="muted">${esc(H.stats?.wins ?? '')}${H.stats ? 'V-' : ''}${esc(H.stats?.losses ?? '')}${H.stats ? 'P' : ''}</span></a>
      <div><div class="big">${played ? `${esc(t.homeScore ?? 0)} – ${esc(t.awayScore ?? 0)}` : 'vs'}</div>
        <div class="partials">${partials.map((p) => `<span>${p.period > (match.configuration?.periodNum || 4) ? 'TS' : 'Q' + p.period} ${p.homeScore}-${p.awayScore}</span>`).join('')}</div>
        <div style="text-align:center;margin-top:8px">${statusBadge(match.timeStatus)}</div>
        <div class="muted" style="text-align:center;margin-top:6px">${fmt.date(match.date)}</div>
        <div class="muted" style="text-align:center">${esc([match.court?.place, match.court?.town].filter(Boolean).join(' · '))}</div></div>
      <a class="side" href="${teamLink(A)}">${logo(A.logo, 'logo', A.name)}<span>${esc(A.name)}</span><span class="muted">${esc(A.stats?.wins ?? '')}${A.stats ? 'V-' : ''}${esc(A.stats?.losses ?? '')}${A.stats ? 'P' : ''}</span></a>
    </div>
    ${fanNotice('di dettaglio della partita')}
    ${tabs('match', played
    ? [['box', 'Tabellino'], ['leaders', 'Migliori'], ['pbp', 'Play-by-play'], ['flow', 'Andamento'], ['lineups', 'Quintetti'], ['chron', 'Cronaca'], ['pre', 'Pre-partita']]
    : [['pre', 'Pre-partita'], ['roster', 'Roster']], params.tab || (played ? 'box' : 'pre'))}`);
  if (!ok) return;

  const periodSelect = (id, nPeriods) => `<label class="row">Periodo <select id="${id}"><option value="">Tutta la partita</option>${Array.from({ length: nPeriods }, (_, i) => `<option value="${i + 1}">${i + 1 > (match.configuration?.periodNum || 4) ? 'Suppl. ' + (i + 1 - (match.configuration?.periodNum || 4)) : (i + 1) + 'º quarto'}</option>`).join('')}</select></label>`;
  const nPeriods = Math.max(partials.length, match.configuration?.periodNum || 4);

  bindTabs('match', {
    box: async (pane) => {
      pane.innerHTML = `<div class="row" style="margin-bottom:10px">${periodSelect('box-period', nPeriods)}</div><div id="box-out">${loading()}</div>`;
      const draw = async () => {
        const out = $('#box-out');
        const per = $('#box-period').value;
        out.innerHTML = loading();
        try {
          const d = await q('MATCH_BOXSCORE', { matchFid: mf, projectKey: pk, periods: per ? [Number(per)] : null });
          const b = mBy(d)?.boxscore;
          if (!b) { out.innerHTML = '<div class="empty">Tabellino non disponibile.</div>'; return; }
          out.innerHTML = ['homeTeam', 'awayTeam'].map((side) => {
            const tm = b[side]; if (!tm) return '';
            const rows = (tm.players || []).map((x) => ({ ...x.stats, player: x.player }));
            const tot = { ...(tm.totals || tm.stats || {}), player: { name: 'Totale' } };
            return `<h2>${esc(tm.team?.name)}</h2>` + boxTable(`box-${side}`, rows, tot, `tabellino-${slug(tm.team?.name)}-${slug(match.date?.slice(0, 10))}${per ? '-q' + per : ''}`, (r) => {
              if (r.player?.fid) location.hash = link('player', { pk, c: cf, t: r.player.teamFid || tm.team?.fid, p: r.player.fid });
            });
          }).join('');
        } catch (err) { out.innerHTML = errorBox(err); }
      };
      $('#box-period').addEventListener('change', draw);
      draw();
    },
    leaders: async (pane) => {
      const d = await q('GAME_LEADERS', { matchFid: mf, projectKey: pk, periods: null });
      const L = mBy(d)?.leaders;
      if (!L) { pane.innerHTML = '<div class="empty">Dati non disponibili.</div>'; return; }
      const labels = { points: 'Punti', rebounds: 'Rimbalzi', assists: 'Assist', fibaRating: 'Valutazione', inArcThrowsMade: 'Canestri da 2', outArcThrowsMade: 'Canestri da 3', freeThrows: 'Tiri liberi' };
      const col = (arr) => (arr || []).slice(0, 3).map((x) => `<div class="leader-row">${logo(x.player?.photo, 'photo', fmt.name(x.player))}<span>${esc(fmt.name(x.player))}</span><span class="v">${x.made !== undefined ? `${x.made}/${x.attempted}` : esc(x.value)}</span></div>`).join('') || '<div class="muted">–</div>';
      pane.innerHTML = `<div class="leaders">${Object.keys(labels).filter((k) => L[k]).map((k) => `<div class="card"><h3>${labels[k]}</h3>
        <div class="muted" style="font-size:11px;margin-top:4px">${esc(H.name)}</div>${col(L[k].homePlayers)}
        <div class="muted" style="font-size:11px;margin-top:8px">${esc(A.name)}</div>${col(L[k].awayPlayers)}</div>`).join('')}</div>`;
    },
    pbp: async (pane) => {
      const d = await q('MATCH_ACTIONS', { matchFid: mf, projectKey: pk });
      // 'time' è il tempo RIMANENTE nel periodo in ms (600000 = 10:00 a inizio periodo, 0 a
      // fine): lo confermano i titolari, che entrano con time=600000. Il server manda tutte
      // le azioni al CONTRARIO (ultima prima), anche dentro lo stesso istante (prima i tiri
      // liberi, poi il fallo). Quindi basta invertire l'array per avere l'ordine cronologico,
      // poi un ordinamento STABILE per solo periodo mette i quarti in sequenza senza toccare
      // l'ordine interno.
      const acts = (mBy(d)?.actions || []).slice().reverse();
      if (!acts.length) { pane.innerHTML = '<div class="empty">Play-by-play non disponibile.</div>'; return; }
      acts.sort((a, b) => (Number(a.period) || 0) - (Number(b.period) || 0));
      let hs = 0; let as = 0; let lastPeriod = null;
      const homeFid = H.fid;
      const rows = [];
      const csvRows = [];
      for (const a of acts) {
        if (a.period !== lastPeriod) { rows.push(`<div class="period">${a.period > (match.configuration?.periodNum || 4) ? 'Supplementare ' + (a.period - (match.configuration?.periodNum || 4)) : a.period + 'º quarto'}</div>`); lastPeriod = a.period; }
        const side = a.teamFid ? (a.teamFid === homeFid ? 'home' : 'away') : '';
        if (a.code === 'POINTS' && madeShot(a)) { const v = Number(a.value) || 0; if (side === 'home') hs += v; else if (side === 'away') as += v; }
        const actor = a.actor?.fid ? playersByFid[a.actor.fid] : null;
        const who = actor ? fmt.name(actor) : (side === 'home' ? H.name : side === 'away' ? A.name : '');
        const desc = describeAction(a);
        const clock = fmt.mins(Number(a.time) / 1000); // time = ms rimanenti nel periodo
        rows.push(`<div class="ev ${side}"><span class="t">${esc(clock)}</span><span class="who">${esc(side === 'home' ? H.name?.split(' ')[0] : side === 'away' ? A.name?.split(' ')[0] : '')}</span><span>${actor ? `<strong>${esc(who)}</strong> · ` : ''}${esc(desc)}</span><span class="sc">${hs}-${as}</span></div>`);
        csvRows.push({ period: a.period, time: clock, team: side === 'home' ? H.name : side === 'away' ? A.name : '', player: actor ? who : '', action: desc, code: a.code, subCode: a.subCode, result: a.result, value: a.value, score: `${hs}-${as}` });
      }
      TABLES.pbpcsv = { cols: ['period', 'time', 'team', 'player', 'action', 'code', 'subCode', 'result', 'value', 'score'].map((k) => ({ key: k, label: k })), rows: csvRows, exportName: `pbp-${slug(H.name)}-${slug(A.name)}` };
      pane.innerHTML = `<div class="row" style="margin-bottom:8px"><span class="muted">Le descrizioni derivano dai codici azione del server.</span><span class="spacer"></span><button class="btn small" data-export="pbpcsv">Esporta CSV</button></div><div class="pbp">${rows.join('')}</div>`;
    },
    flow: async (pane) => {
      const [d, s] = await Promise.all([q('GAME_FLOW', { matchFid: mf, projectKey: pk }), q('GAME_FLOW_STATS', { matchFid: mf, projectKey: pk }).catch(() => null)]);
      const acts = (mBy(d)?.actions || []).filter((a) => madeShot(a)).slice()
        .sort((a, b) => (a.period - b.period) || (elapsed(a, match) - elapsed(b, match)));
      const st = mBy(s)?.stats;
      pane.innerHTML = `${st ? `<div class="kpis" style="margin-bottom:12px">
        <div class="kpi"><div class="v">${fmt.num(st.biggestLead?.homeTeam)}</div><div class="l">Max vantaggio ${esc(H.name)}</div></div>
        <div class="kpi"><div class="v">${fmt.num(st.biggestLead?.awayTeam)}</div><div class="l">Max vantaggio ${esc(A.name)}</div></div>
        <div class="kpi"><div class="v">${fmt.num(st.timesTied)}</div><div class="l">Parità</div></div>
        <div class="kpi"><div class="v">${fmt.num(st.leadChanges)}</div><div class="l">Cambi di guida</div></div></div>` : ''}
        ${flowChart(acts, H, A, match, nPeriods)}`;
    },
    lineups: async (pane) => {
      pane.innerHTML = `<div class="row" style="margin-bottom:10px"><label class="row">Squadra <select id="lu-team"><option value="${esc(H.fid)}">${esc(H.name)}</option><option value="${esc(A.fid)}">${esc(A.name)}</option></select></label></div><div id="lu-out"></div>`;
      const draw = async () => {
        const out = $('#lu-out'); out.innerHTML = loading();
        try {
          // Senza opzioni il server limita a 10 quintetti (i migliori per punti). Chiediamo
          // tutti ordinati per minuti giocati.
          const d = await q('MATCH_LINEUPS', { projectKey: pk, competitionFid: cf, matchFid: mf, teamFid: $('#lu-team').value, options: { orderField: 'timePlayed', orderType: 'DESC', limit: 100 } });
          const lus = (one(d?.matchLineupStats)?.lineups || []).filter((l) => Number(l.stats?.timePlayed) > 0);
          out.innerHTML = lus.length ? lineupTable('mlu', lus, false, `quintetti-partita-${slug(H.name)}-${slug(A.name)}`) : '<div class="empty">Dati sui quintetti non disponibili.</div>';
        } catch (err) { out.innerHTML = errorBox(err); }
      };
      $('#lu-team').addEventListener('change', draw);
      draw();
    },
    chron: async (pane) => {
      const c = match.chronicles;
      const parts = [];
      if (c?.postMatch?.text) parts.push(`<div class="card"><h3>Cronaca post-partita</h3><div class="chron">${esc(c.postMatch.text)}</div>${c.postMatch.audioURL ? `<audio controls src="${esc(c.postMatch.audioURL)}" style="margin-top:10px;width:100%"></audio>` : ''}</div>`);
      if (c?.preMatch?.text) parts.push(`<div class="card"><h3>Presentazione</h3><div class="chron">${esc(c.preMatch.text)}</div></div>`);
      pane.innerHTML = parts.length ? `<div class="grid" style="grid-template-columns:1fr">${parts.join('')}</div><p class="muted">Testi generati automaticamente da NBN23.</p>` : '<div class="empty">Nessuna cronaca disponibile per questa partita.</div>';
    },
    pre: async (pane) => renderPrematch(pane, pk, cf, mf),
    roster: async (pane) => {
      pane.innerHTML = `<div class="grid">${[H, A].map((tm) => `<div class="card"><h3>${esc(tm.name)}</h3>
        ${(tm.players || []).slice().sort((a, b) => Number(a.number) - Number(b.number)).map((p) => `<div class="leader-row">${logo(p.photo, 'photo', fmt.name(p))}<span class="muted" style="width:24px">${esc(p.number ?? '')}</span><span>${esc(fmt.name(p))}</span></div>`).join('') || '<div class="muted">Roster non disponibile</div>'}
        ${(tm.staff || []).length ? `<div class="muted" style="margin-top:8px">Staff: ${esc(tm.staff.map((s) => fmt.name(s)).join(', '))}</div>` : ''}</div>`).join('')}</div>`;
    },
  }, params.tab || (played ? 'box' : 'pre'));
};

function boxTable(id, rows, totalRow, exportName, onRow) {
  return table(id, [
    { key: 'num', label: '#', cls: 'l', get: (r) => r.player?.number ?? '' },
    { key: 'name', label: 'Giocatore', cls: 'l', get: (r) => fmt.name(r.player), fmt: (v, r) => `${esc(v)}${r.player?.starting ? '<span class="starter">★</span>' : ''}`, csv: (v) => v },
    { key: 'timePlayed', label: 'MIN', fmt: fmt.mins },
    { key: 'points', label: 'PT' },
    { key: 'p2', label: '2P', get: (r) => r.inArcThrowsMade, fmt: (v, r) => fmt.shot(r.inArcThrowsMade, r.inArcThrowsFailed) },
    { key: 'p2p', label: '2P%', get: (r) => r.inArcThrowsMade, fmt: (v, r) => fmt.shotPct(r.inArcThrowsMade, r.inArcThrowsFailed) },
    { key: 'p3', label: '3P', get: (r) => r.outArcThrowsMade, fmt: (v, r) => fmt.shot(r.outArcThrowsMade, r.outArcThrowsFailed) },
    { key: 'p3p', label: '3P%', get: (r) => r.outArcThrowsMade, fmt: (v, r) => fmt.shotPct(r.outArcThrowsMade, r.outArcThrowsFailed) },
    { key: 'ft', label: 'TL', get: (r) => r.freeThrowsMade, fmt: (v, r) => fmt.shot(r.freeThrowsMade, r.freeThrowsFailed) },
    { key: 'ftp', label: 'TL%', get: (r) => r.freeThrowsMade, fmt: (v, r) => fmt.shotPct(r.freeThrowsMade, r.freeThrowsFailed) },
    { key: 'offensiveRebounds', label: 'RO' },
    { key: 'defensiveRebounds', label: 'RD' },
    { key: 'reb', label: 'RT', get: (r) => (r.offensiveRebounds ?? 0) + (r.defensiveRebounds ?? 0) },
    { key: 'assists', label: 'AS' },
    { key: 'turnovers', label: 'PP' },
    { key: 'steals', label: 'REC' },
    { key: 'blocks', label: 'STO' },
    { key: 'receivedBlocks', label: 'STS' },
    { key: 'fouls', label: 'FF' },
    { key: 'receivedFouls', label: 'FS' },
    { key: 'plusMinus', label: '+/-' },
    { key: 'fibaRating', label: 'VAL' },
  ], rows, { totalRow, exportName, onRow });
}

async function renderPrematch(pane, pk, cf, mf) {
  const d = await q('PREMATCH', { projectKey: pk, competitionFid: cf, matchFid: mf });
  const P = d?.preMatchData;
  if (!P) { pane.innerHTML = '<div class="empty">Dati pre-partita non disponibili.</div>'; return; }
  const side = (tm) => {
    if (!tm) return '';
    const cs = tm.competitionStats || {};
    const top = (title, arr, val) => `<div style="margin-top:10px"><div class="muted" style="font-size:11px">${title}</div>${(arr || []).slice(0, 3).map((p) => `<div class="leader-row">${logo(p.photo, 'photo', fmt.name(p))}<span>${esc(fmt.name(p))}</span><span class="v">${val(p)}</span></div>`).join('') || '<div class="muted">–</div>'}</div>`;
    return `<div class="card"><div class="row">${logo(tm.logo, 'logo', tm.name)}<h3 style="margin:0">${esc(tm.name)}</h3><span class="spacer"></span>${tm.standingPosition ? `<span class="badge">${esc(tm.standingPosition)}º</span>` : ''}</div>
      <div class="kpis" style="margin-top:10px">
        <div class="kpi"><div class="v">${fmt.num(cs.wins)}-${fmt.num(cs.losses)}</div><div class="l">V-P</div></div>
        <div class="kpi"><div class="v">${fmt.dec(cs.pointsAVG)}</div><div class="l">PF/G</div></div>
        <div class="kpi"><div class="v">${fmt.dec(cs.pointsConcededAVG)}</div><div class="l">PS/G</div></div></div>
      <div style="margin-top:10px" class="muted">Ultime partite</div>
      ${(tm.lastMatches || []).map((m) => `<div class="leader-row" style="cursor:pointer" data-go="${link('match', { pk: m.projectKey, m: m.fid, c: m.competitionFid })}"><span class="muted">${fmt.shortDate(m.date)}</span><span>${esc(m.homeTeam?.name)} – ${esc(m.awayTeam?.name)}</span><span class="v">${esc(m.scores?.total?.homeScore ?? '')}-${esc(m.scores?.total?.awayScore ?? '')}</span></div>`).join('') || '<div class="muted">–</div>'}
      ${top('Migliori marcatori', tm.topScorers, (p) => `${fmt.dec(p.stats?.pointsAVG)} pt`)}
      ${top('Più minuti', tm.topLiners, (p) => fmt.mins(p.stats?.timePlayedAVG))}
      ${top('Tiratori da 3', tm.topOutArcScorers, (p) => `${fmt.dec(p.stats?.outArcThrowsAVG)}/G`)}
      ${top('Tiratori da 2', tm.topInArcScorers, (p) => `${fmt.dec(p.stats?.inArcThrowsAVG)}/G`)}
    </div>`;
  };
  pane.innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr">${side(P.homeTeam)}${side(P.awayTeam)}</div>`;
}

const ACTION_LABELS = {
  POINTS: 'Tiro', FOUL: 'Fallo', FOULS: 'Fallo', REBOUND: 'Rimbalzo', REBOUNDS: 'Rimbalzo', ASSIST: 'Assist', ASSISTS: 'Assist',
  TURNOVER: 'Palla persa', TURNOVERS: 'Palla persa', STEAL: 'Recupero', STEALS: 'Recupero', BLOCK: 'Stoppata', BLOCKS: 'Stoppata',
  SUBSTITUTION: 'Cambio', SUBSTITUTIONS: 'Cambio', IN: 'Entra', OUT: 'Esce', TIMEOUT: 'Timeout', TIMEOUTS: 'Timeout', JUMP_BALL: 'Palla a due',
};
function madeShot(a) {
  if (a.code && a.code !== 'POINTS') return false;
  const r = a.result;
  if (r === true || r === 1) return true;
  if (r === false || r === 0 || r == null) return false;
  const s = String(r).toUpperCase();
  return !/(MISS|FAIL|KO|NO_|FALSE)/.test(s);
}
function describeAction(a) {
  if (a.code === 'POINTS') {
    const v = Number(a.value);
    const kind = v === 1 ? 'Tiro libero' : v === 3 ? 'Tiro da 3' : v === 2 ? 'Tiro da 2' : 'Tiro';
    return `${kind} ${madeShot(a) ? 'segnato' : 'sbagliato'}`;
  }
  if (a.code === 'SWAP') return /SWAP_OUT/i.test(a.subCode || '') ? 'Esce' : 'Entra';
  if (a.code === 'RECEIVE') return 'Subisce fallo';
  const base = ACTION_LABELS[a.code] || a.code || 'Azione';
  const sub = a.subCode && !['NONE', 'DEFAULT'].includes(a.subCode) ? ` (${String(a.subCode).toLowerCase().replace(/_/g, ' ')})` : '';
  return base + sub;
}
// Durata di un periodo in ms (periodDuration è in minuti; gli overtime durano meno).
function periodMsOf(match, period) {
  const base = Number(match?.configuration?.periodDuration) || 10;
  const baseMs = base > 1000 ? base : base * 60000;
  const otMin = Number(match?.configuration?.overtimeDuration);
  if (period > (match?.configuration?.periodNum || 4) && otMin) return otMin > 1000 ? otMin : otMin * 60000;
  return baseMs;
}
function elapsed(a, match) {
  // 'time' è il tempo RIMANENTE nel periodo, quindi il trascorso nel periodo = durata − time.
  const perMs = periodMsOf(match, a.period);
  const t = Number(a.time);
  const inPeriod = perMs - (Number.isNaN(t) ? perMs : t);
  return (a.period - 1) * perMs + inPeriod;
}

function flowChart(acts, H, A, match, nPeriods) {
  if (!acts.length) return '<div class="empty">Andamento non disponibile.</div>';
  // punti cumulati in ordine; asse X = indice dell'azione (con separatori di periodo)
  let hs = 0; let as = 0;
  const pts = [{ i: 0, d: 0, hs: 0, as: 0, period: 1 }];
  acts.forEach((a, i) => {
    const v = Number(a.value) || 0;
    if (a.teamFid === H.fid) hs += v; else as += v;
    pts.push({ i: i + 1, d: hs - as, hs, as, period: a.period });
  });
  const W = 1000; const Ht = 280; const pad = 34;
  const maxAbs = Math.max(5, ...pts.map((p) => Math.abs(p.d)));
  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (d) => Ht / 2 - (d / maxAbs) * (Ht / 2 - pad);
  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.d).toFixed(1)}`).join(' ');
  const area = `${path} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const seps = [];
  for (let k = 1; k < pts.length; k++) if (pts[k].period !== pts[k - 1].period) seps.push({ i: pts[k - 1].i, p: pts[k].period });
  const final = pts[pts.length - 1];
  const totals = match.scores?.total;
  const mismatch = totals && (Number(totals.homeScore) !== final.hs || Number(totals.awayScore) !== final.as);
  return `<svg class="chart" viewBox="0 0 ${W} ${Ht}" preserveAspectRatio="none">
    <defs><clipPath id="cTop"><rect x="0" y="0" width="${W}" height="${y(0)}"/></clipPath><clipPath id="cBot"><rect x="0" y="${y(0)}" width="${W}" height="${Ht}"/></clipPath></defs>
    <line x1="${pad}" x2="${W - pad}" y1="${y(0)}" y2="${y(0)}" stroke="#273248"/>
    ${seps.map((s) => `<line x1="${x(s.i)}" x2="${x(s.i)}" y1="${pad / 2}" y2="${Ht - pad / 2}" stroke="#273248" stroke-dasharray="4 4"/><text x="${x(s.i) + 4}" y="${Ht - 8}">${s.p > (match.configuration?.periodNum || 4) ? 'TS' : 'Q' + s.p}</text>`).join('')}
    <path d="${area}" fill="var(--home)" opacity=".25" clip-path="url(#cTop)"/>
    <path d="${area}" fill="var(--away)" opacity=".25" clip-path="url(#cBot)"/>
    <path d="${path}" fill="none" stroke="#e8ecf4" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <text x="${pad}" y="16">▲ ${esc(H.name)} avanti (max +${maxAbs})</text>
    <text x="${pad}" y="${Ht - 8}">▼ ${esc(A.name)} avanti</text>
  </svg>${mismatch ? `<p class="muted">Nota: la somma delle azioni (${final.hs}-${final.as}) non coincide col punteggio finale; alcune azioni potrebbero mancare.</p>` : ''}`;
}

// ---------- GIOCATORE
routes.player = async (params) => {
  const set = guard();
  const { pk, c: cf, t: tf, p: pf } = params;
  set(loading());
  let p;
  try {
    p = (await q('PLAYER', { projectKey: pk, competitionFid: cf, teamFid: tf, fid: pf }))?.player;
    if (!p) throw new Error('Giocatore non trovato.');
  } catch (err) { set(errorBox(err)); return; }
  const s = p.stats || {};
  const k = (l, v) => `<div class="kpi"><div class="v">${v}</div><div class="l">${esc(l)}</div></div>`;
  const ok = set(`<div class="crumbs"><a href="${link('team', { pk, c: cf, t: p.team?.fid || tf })}">${esc(p.team?.name)}</a></div>
    <div class="page-head">${logo(p.photo, 'photo big', fmt.name(p))}<div><h1>${esc(fmt.name(p))}</h1>
      <div class="row muted">${logo(p.team?.logo, 'logo', p.team?.name)}${esc(p.team?.name)}${p.uniquePlayer?.id ? ` · <a href="${link('unique', { id: p.uniquePlayer.id })}" style="color:var(--accent)">Carriera completa →</a>` : ''}</div></div></div>
    <div class="kpis">
      ${k('Partite', fmt.num(s.games))}${k('Punti/G', fmt.dec(s.pointsPerGame))}${k('Rimbalzi/G', fmt.dec(s.reboundPerGame))}${k('Assist/G', fmt.dec(s.assistsPerGame))}
      ${k('Minuti/G', s.games ? fmt.mins(s.timePlayed / s.games) : '–')}${k('Valutazione', fmt.num(s.fibaRating))}
      ${k('2P', `${fmt.shot(s.inArcThrowsMade, s.inArcThrowsFailed)} · ${fmt.pct(s.shotsInArcPercent)}`)}
      ${k('3P', `${fmt.shot(s.outArcThrowsMade, s.outArcThrowsFailed)} · ${fmt.pct(s.shotsOutArcPercent)}`)}
      ${k('TL', `${fmt.shot(s.freeThrowsMade, s.freeThrowsFail)} · ${fmt.pct(s.freeThrowsPercent)}`)}
      ${k('+/-', fmt.num(s.plusMinus))}${k('Falli', fmt.num(s.fouls))}${k('Palle perse', fmt.num(s.turnovers))}
    </div>
    <h2>Partita per partita</h2><div id="gamelog">${loading()}</div>`);
  if (!ok) return;
  try {
    const d = await q('PLAYER_BOXSCORES', { playerFid: pf, teamFid: p.team?.fid || tf, competitionFid: cf, projectKey: pk, cursor: '', limit: 100 });
    let list = d?.playerBoxscores || [];
    list = Array.isArray(list) ? list : (list.items || []);
    const teamName = p.team?.name;
    list.sort((a, b) => new Date(b.match?.date) - new Date(a.match?.date));
    const rows = list.map((r) => ({ ...r, player: { name: '' } }));
    guardEl($('#gamelog'))(table('glog', [
      { key: 'date', label: 'Data', cls: 'l', get: (r) => r.match?.date, fmt: (v) => fmt.shortDate(v), sort: (r) => new Date(r.match?.date).getTime() },
      { key: 'opp', label: 'Avversario', cls: 'l', get: (r) => (r.match?.homeTeam?.name === teamName ? `vs ${r.match?.awayTeam?.name}` : `@ ${r.match?.homeTeam?.name}`) },
      { key: 'res', label: 'Ris.', get: (r) => `${r.match?.scores?.total?.homeScore ?? ''}-${r.match?.scores?.total?.awayScore ?? ''}` },
      { key: 'timePlayed', label: 'MIN', fmt: fmt.mins },
      { key: 'points', label: 'PT' },
      { key: 'p2', label: '2P', get: (r) => r.inArcThrowsMade, fmt: (v, r) => fmt.shot(r.inArcThrowsMade, r.inArcThrowsFailed) },
      { key: 'p3', label: '3P', get: (r) => r.outArcThrowsMade, fmt: (v, r) => fmt.shot(r.outArcThrowsMade, r.outArcThrowsFailed) },
      { key: 'ft', label: 'TL', get: (r) => r.freeThrowsMade, fmt: (v, r) => fmt.shot(r.freeThrowsMade, r.freeThrowsFailed) },
      { key: 'reb', label: 'RIM', get: (r) => (r.offensiveRebounds ?? 0) + (r.defensiveRebounds ?? 0) },
      { key: 'assists', label: 'AS' }, { key: 'turnovers', label: 'PP' }, { key: 'steals', label: 'REC' },
      { key: 'blocks', label: 'STO' }, { key: 'fouls', label: 'FF' }, { key: 'receivedFouls', label: 'FS' },
      { key: 'plusMinus', label: '+/-' }, { key: 'fibaRating', label: 'VAL' },
    ], rows, { exportName: `partite-${slug(fmt.name(p))}`, onRow: (r) => { if (r.match?.fid) location.hash = link('match', { pk, m: r.match.fid, c: cf }); } }));
  } catch (err) { guardEl($('#gamelog'))(errorBox(err)); }
};

// ---------- PROFILO GIOCATORE UNICO (carriera)
routes.unique = async (params) => {
  const set = guard();
  set(loading());
  try {
    const d = await q('UNIQUE_PLAYER', { uniquePlayerId: params.id, hidePersonalData: false });
    const u = d?.uniquePlayer;
    if (!u) throw new Error('Profilo non trovato.');
    const seasons = u.seasonStats || [];
    set(`<div class="page-head">${logo(u.photo, 'photo big', fmt.name(u))}<div><h1>${esc(fmt.name(u))}</h1><div class="muted">Profilo carriera</div></div></div>
      <h2>Squadre e competizioni</h2>
      ${table('uplayers', [
    { key: 'season', label: 'Stagione', cls: 'l', get: (r) => r.season?.name },
    { key: 'comp', label: 'Competizione', cls: 'l', get: (r) => r.competition?.name },
    { key: 'team', label: 'Squadra', cls: 'l', get: (r) => r.team?.name },
    { key: 'number', label: '#' },
    { key: 'games', label: 'G', get: (r) => r.stats?.games },
    { key: 'ppg', label: 'PT/G', get: (r) => r.stats?.pointsPerGame, fmt: fmt.dec },
    { key: 'min', label: 'MIN/G', get: (r) => r.stats?.timePlayedAVG, fmt: fmt.mins },
    { key: 'p3', label: '3P/G', get: (r) => r.stats?.outArcThrowsAVG, fmt: fmt.dec },
    { key: 'ft', label: 'TL%', get: (r) => r.stats?.freeThrowsPercentage, fmt: fmt.pct },
    { key: 'pm', label: '+/-/G', get: (r) => r.stats?.plusMinusAVG, fmt: fmt.dec },
  ], u.players || [], { exportName: `carriera-${slug(fmt.name(u))}`, onRow: (r) => { location.hash = link('player', { pk: r.projectKey, c: r.competition?.fid, t: r.team?.fid, p: r.fid }); } })}
      ${seasons.length ? `<h2>Per stagione</h2>${table('useasons', [
    { key: 'seasonId', label: 'Stagione', cls: 'l', get: (r) => state.seasons.find((s) => s.id === r.seasonId)?.name || r.seasonId },
    { key: 'games', label: 'G' }, { key: 'points', label: 'PT' }, { key: 'pointsPerGame', label: 'PT/G', fmt: fmt.dec },
    { key: 'timePlayedPerGame', label: 'MIN/G', fmt: fmt.mins },
    { key: 'outArcThrowsMadePerGame', label: '3P/G', fmt: fmt.dec },
    { key: 'freeThrowsPercentage', label: 'TL%', fmt: fmt.pct },
    { key: 'foulsPerGame', label: 'FALLI/G', fmt: fmt.dec }, { key: 'plusMinusPerGame', label: '+/-/G', fmt: fmt.dec },
  ], seasons, { exportName: `stagioni-${slug(fmt.name(u))}` })}` : ''}`);
  } catch (err) { set(errorBox(err)); }
};

// ---------- SEGUITI
routes.follows = async () => {
  const set = guard();
  set(`<h1>Seguiti</h1>${loading()}`);
  try {
    const d = await q('USER_FOLLOWS');
    const f = d?.user?.following || {};
    const sec = (title, arr, render) => `<h2>${title}</h2>${arr?.length ? `<div class="list">${arr.map(render).join('')}</div>` : '<div class="empty">Nessuno.</div>'}`;
    set(`<h1>Seguiti</h1><p class="muted">Squadre e campionati si seguono dalle rispettive pagine con il tasto "Segui". Giocatori e profili si gestiscono dall'app sul telefono.</p>
      ${sec('Campionati', f.competitions, (c) => `<a class="item" href="${link('competition', { pk: c.projectKey, c: c.fid })}"><div><strong>${esc(c.competition?.name)}</strong><div class="sub">${esc(c.competition?.projectName)}</div></div></a>`)}
      ${sec('Squadre', f.teams, (t) => `<a class="item" href="${link('team', { pk: t.projectKey, c: t.competitionFid, t: t.fid })}">${logo(t.team?.logo)}<div><strong>${esc(t.team?.name)}</strong><div class="sub">${esc(t.team?.competition?.name)}</div></div></a>`)}
      ${sec('Giocatori', f.players, (p) => `<a class="item" href="${link('player', { pk: p.projectKey, c: p.competition?.fid, t: p.team?.fid, p: p.fid })}">${logo(p.player?.photo, 'photo', fmt.name(p.player))}<div><strong>${esc(fmt.name(p.player))}</strong><div class="sub">${esc(p.team?.name)} · ${esc(p.competition?.name)}</div></div></a>`)}
      ${sec('Profili giocatore', f.uniquePlayers, (u) => `<a class="item" href="${link('unique', { id: u.uniquePlayerId })}">${logo(u.uniquePlayer?.photo, 'photo', fmt.name(u.uniquePlayer))}<div><strong>${esc(fmt.name(u.uniquePlayer))}</strong></div></a>`)}`);
  } catch (err) { set(`<h1>Seguiti</h1>${errorBox(err)}`); }
};

// ---------- CONSOLE API
routes.console = async () => {
  const set = guard();
  const list = await window.fip.queries();
  set(`<h1>Console API</h1>
    <p class="muted">Esegui qualsiasi query GraphQL sul server di FIP Stats con il tuo account. Utile per esplorare dati non ancora mostrati nell'app.</p>
    <div class="row" style="margin:10px 0"><label class="row">Parti da <select id="c-tpl"><option value="">— query vuota —</option>${Object.keys(list).map((k) => `<option>${k}</option>`).join('')}<option value="__intro">Schema (introspezione)</option></select></label></div>
    <div class="grid" style="grid-template-columns:2fr 1fr">
      <textarea id="c-q" rows="16" spellcheck="false">query { seasons { id name startDate endDate } }</textarea>
      <textarea id="c-v" rows="16" spellcheck="false">{}</textarea>
    </div>
    <div class="row" style="margin:10px 0"><button class="btn primary" id="c-run">Esegui</button><button class="btn" id="c-save">Salva JSON</button><span id="c-time" class="muted"></span></div>
    <pre class="json" id="c-out">—</pre>`);
  $('#c-tpl').addEventListener('change', (e) => {
    const k = e.target.value;
    if (k === '__intro') { $('#c-q').value = 'query { __schema { queryType { fields { name args { name type { name kind ofType { name kind } } } } } } }'; $('#c-v').value = '{}'; return; }
    if (k) { $('#c-q').value = list[k]; $('#c-v').value = JSON.stringify(guessVars(list[k]), null, 2); }
  });
  let last = null;
  $('#c-run').addEventListener('click', async () => {
    const out = $('#c-out'); out.textContent = '…';
    const t0 = performance.now();
    try {
      const vars = JSON.parse($('#c-v').value || '{}');
      last = await window.fip.raw($('#c-q').value, vars);
      out.textContent = JSON.stringify(last, null, 2);
    } catch (err) { out.textContent = `Errore: ${err.message}\n${err.details ? JSON.stringify(err.details, null, 2) : ''}`; }
    $('#c-time').textContent = `${Math.round(performance.now() - t0)} ms`;
  });
  $('#c-save').addEventListener('click', async () => {
    if (!last) return;
    try { await window.fip.saveCsv('risposta.json', JSON.stringify(last, null, 2)); } catch (err) { alertError(err); }
  });
};
function guessVars(query) {
  const vars = {};
  const m = query.match(/\(([^)]*)\)\s*\{/);
  if (!m) return vars;
  for (const v of m[1].matchAll(/\$(\w+)\s*:\s*([\[\]\w!]+)/g)) vars[v[1]] = v[2].startsWith('[') ? [] : v[2].startsWith('Int') ? 10 : '';
  return vars;
}

// ---------- ACCOUNT
routes.account = async () => {
  const set = guard();
  set(`<h1>Account</h1>${loading()}`);
  try {
    const u = await window.fip.userInfo();
    state.user = u;
    renderUserBadge();
    const sub = u?.subscriptionState;
    set(`<h1>Account</h1>
      <div class="card" style="max-width:560px">
        <div class="row">${logo(u?.photo, 'photo', (u?.name||''))}<div><h3 style="margin:0">${esc(u?.name || '')}</h3><div class="muted">${esc(u?.email || '')}</div></div>
        <span class="spacer"></span>${u?.premium ? '<span class="badge">GOLD</span>' : '<span class="badge grey">FAN</span>'}</div>
        ${fanNotice()}
        ${sub ? `<p class="muted">Abbonamento: ${esc(sub.productId || '')} · ${sub.autoRenew ? 'rinnovo automatico' : 'senza rinnovo'} · scade ${fmt.date(sub.expirationDate, false)} (${esc(sub.provider || '')})</p>` : ''}
        <div class="row" style="margin-top:12px"><button class="btn" id="logout">Esci</button></div>
      </div>
      <p class="muted" style="margin-top:18px">Client non ufficiale per uso personale: usa le stesse API dell'app FIP Stats con il tuo account.</p>`);
    $('#logout').addEventListener('click', async () => { await window.fip.logout(); showLogin(); });
  } catch (err) {
    set(`<h1>Account</h1>${errorBox(err)}<button class="btn" id="logout">Esci</button>`);
    $('#logout').addEventListener('click', async () => { await window.fip.logout(); showLogin(); });
  }
};

// ---------- DIAGNOSTICA
routes.diag = async () => {
  const set = guard();
  set(`<h1>Diagnostica</h1><p class="muted">Fa due richieste di prova al server dati e mostra la risposta completa. Il token è oscurato: puoi copiare il testo e mandarlo a Claude senza problemi.</p>
    <div class="row" style="margin:10px 0"><button class="btn primary" id="d-run">Esegui test</button><button class="btn" id="d-copy">Copia risultato</button></div>
    <pre class="json" id="d-out">—</pre>`);
  const run = async () => {
    $('#d-out').textContent = 'Test in corso…';
    try { $('#d-out').textContent = JSON.stringify(await window.fip.diagnose(), null, 2); }
    catch (err) { $('#d-out').textContent = `Errore: ${err.message}`; }
  };
  $('#d-run').addEventListener('click', run);
  $('#d-copy').addEventListener('click', () => navigator.clipboard.writeText($('#d-out').textContent));
  run();
};

// ============================================================ boot / routing

function slug(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
function currentSeasonName() { return state.seasons.find((s) => s.id === state.seasonId)?.name || '—'; }

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [route, query] = h.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  return { route: route || 'home', params };
}

// Storico di navigazione per il pulsante "Indietro".
const backStack = [];
let prevHash = null;
let goingBack = false;
let navReset = false; // le voci di primo livello del menu azzerano la cronologia
function trackNav() {
  const cur = location.hash || '#/home';
  if (navReset) { backStack.length = 0; navReset = false; }
  else if (goingBack) { goingBack = false; }
  else if (prevHash && prevHash !== cur) { backStack.push(prevHash); }
  prevHash = cur;
  const btn = $('#back-btn');
  if (btn) btn.classList.toggle('hidden', backStack.length === 0);
}
function goBack() {
  const h = backStack.pop();
  if (h) { goingBack = true; location.hash = h; }
}
// Scrive un parametro nell'URL corrente senza ricaricare la pagina: così la
// scheda attiva (es. "Giocatori" di una squadra) resta nella cronologia e il
// tasto Indietro riporta sulla scheda dov'eri, non su quella iniziale.
function setHashParam(key, value) {
  const { route, params } = parseHash();
  if (params[key] === String(value)) return;
  params[key] = value;
  const h = link(route, params);
  history.replaceState(null, '', h);
  prevHash = h;
}

async function router() {
  trackNav();
  const { route, params } = parseHash();
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === route));
  const fn = routes[route] || routes.home;
  $('#main').scrollTop = 0;
  try { await fn(params); } catch (err) { view().innerHTML = errorBox(err); }
}

function renderUserBadge() {
  const u = state.user;
  $('#user-badge').innerHTML = u ? `${esc(u.email || u.name || '')} ${u.premium ? '<span class="badge">GOLD</span>' : '<span class="badge grey">FAN</span>'}` : '';
}

async function loadSeasons() {
  try {
    const d = await q('SEASONS');
    state.seasons = (d?.seasons || []).slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
  } catch { state.seasons = []; }
  let saved = null;
  try { saved = localStorage.getItem('seasonId'); } catch { /* */ }
  const now = Date.now();
  const current = state.seasons.find((s) => new Date(s.startDate) <= now && now <= new Date(s.endDate)) || state.seasons[0];
  state.seasonId = state.seasons.some((s) => s.id === saved) ? saved : current?.id;
  const sel = $('#season-select');
  sel.innerHTML = state.seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === state.seasonId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  sel.onchange = () => {
    state.seasonId = sel.value;
    try { localStorage.setItem('seasonId', sel.value); } catch { /* */ }
    if (parseHash().route === 'search') router();
  };
}

function showLogin() {
  state.follows = null;
  $('#shell').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

async function showApp() {
  state.follows = null;
  $('#login').classList.add('hidden');
  $('#shell').classList.remove('hidden');
  await loadSeasons();
  window.fip.userInfo().then((u) => { state.user = u; renderUserBadge(); }).catch(() => {});
  router();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn'); const errEl = $('#login-error');
  btn.disabled = true; btn.textContent = 'Accesso…'; errEl.textContent = '';
  try {
    await window.fip.login($('#login-email').value.trim(), $('#login-password').value);
    $('#login-password').value = '';
    await showApp();
  } catch (err) { errEl.textContent = err.message; }
  btn.disabled = false; btn.textContent = 'Accedi';
});

window.addEventListener('hashchange', router);
// Le voci del menu laterale (Home, Cerca, …) sono sezioni di primo livello: azzerano
// la cronologia, così da lì non si torna indietro.
$$('nav a').forEach((a) => a.addEventListener('click', () => {
  if (a.getAttribute('href') !== (location.hash || '#/home')) navReset = true;
}));
$('#back-btn')?.addEventListener('click', goBack);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '[') { e.preventDefault(); goBack(); }
});
// Pulsante "indietro" del mouse.
window.addEventListener('mouseup', (e) => { if (e.button === 3) { e.preventDefault(); goBack(); } });

(async function boot() {
  const st = await window.fip.status();
  if (st.loggedIn) {
    // All'avvio con sessione già salvata, registriamo subito questo computer come
    // dispositivo attivo: così le stagioni (e tutto il resto) si caricano al primo colpo.
    try { await window.fip.reclaim(); } catch { /* la rete/ricarica automatica farà il resto */ }
    showApp();
  } else showLogin();
}());
