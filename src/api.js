'use strict';
// Client per le API usate dall'app FIP Stats (NBN23).
// Login: Firebase Auth (email/password) -> ID token -> header Authorization verso il server GraphQL.

const crypto = require('crypto');

const CONFIG = {
  graphqlUrl: 'https://internal.nbn23.app/graphql',
  firebaseApiKey: 'AIzaSyDfES1qET23MQ0Y5_cgbDYbeQ168xVcpiA',
  packageName: 'com.nbn23.fipapp',
  packageVersion: '2.13.0',
  // Impronta SHA-1 del certificato di firma dell'APK: serve solo se la chiave Firebase
  // accetta richieste esclusivamente dall'app Android.
  androidCert: 'A10D43B1DE6D11641554CD0F1542DDD9F4B8B1E1',
};

class ApiError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

class FipApi {
  /**
   * @param {object} store  oggetto con get(key) / set(key, value) per la persistenza
   */
  constructor(store) {
    this.store = store;
    this.session = store.get('session') || null; // { idToken, refreshToken, expiresAt, email, localId }
    this.deviceId = store.get('deviceId');
    if (!this.deviceId) {
      this.deviceId = crypto.randomUUID();
      store.set('deviceId', this.deviceId);
    }
    this.premium = store.get('premium') ?? false;
    this.useAndroidHeaders = store.get('useAndroidHeaders') ?? false;
  }

  isLoggedIn() {
    return !!(this.session && this.session.refreshToken);
  }

  status() {
    return { loggedIn: this.isLoggedIn(), email: this.session?.email || null, premium: this.premium };
  }

  // ---------- Firebase Auth ----------

  _firebaseHeaders(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.useAndroidHeaders) {
      h['X-Android-Package'] = CONFIG.packageName;
      h['X-Android-Cert'] = CONFIG.androidCert;
    }
    return h;
  }

  async _firebaseFetch(url, init) {
    let res = await fetch(url, init);
    let body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || '';
    // Chiave limitata alle app Android: riprova presentandosi come l'app.
    if (!res.ok && !this.useAndroidHeaders && /android|blocked|API_KEY|PERMISSION_DENIED/i.test(msg)) {
      this.useAndroidHeaders = true;
      this.store.set('useAndroidHeaders', true);
      init.headers = { ...init.headers, 'X-Android-Package': CONFIG.packageName, 'X-Android-Cert': CONFIG.androidCert };
      res = await fetch(url, init);
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok) {
      throw new ApiError(translateFirebaseError(body?.error?.message || `HTTP ${res.status}`), body);
    }
    return body;
  }

  async login(email, password) {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.firebaseApiKey}`;
    const body = await this._firebaseFetch(url, {
      method: 'POST',
      headers: this._firebaseHeaders(),
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    // Se accede un account DIVERSO, rigeneriamo l'identità del dispositivo e azzeriamo lo
    // stato premium: così un account Fan non eredita device-id, cache o stato Gold del
    // precedente. L'x-user-premium riflette sempre l'account corrente (letto da upsertUser).
    const lastLocalId = this.store.get('lastLocalId');
    if (lastLocalId && lastLocalId !== body.localId) {
      this.deviceId = crypto.randomUUID();
      this.store.set('deviceId', this.deviceId);
    }
    this.premium = false;
    this.store.set('premium', false);
    this.store.set('lastLocalId', body.localId);
    this._saveSession({
      idToken: body.idToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + Number(body.expiresIn || 3600) * 1000,
      email: body.email,
      localId: body.localId,
    });
    // L'app ufficiale, subito dopo il login, registra il dispositivo con una mutation
    // upsertUser: è questo che rende "attivo" il dispositivo lato server (una sola
    // sessione per account). Senza, il server continua a considerare attivo il telefono
    // e rifiuta tutte le richieste con 403 user-concurrency.
    await this.claimSession().catch(() => {});
    await this.refreshUserInfo().catch(() => {});
    return this.status();
  }

  // Costruisce l'oggetto IUser come fa l'app al login.
  _userPayload() {
    const providerMap = { 'password': 'CUSTOM', 'google.com': 'GOOGLE', 'apple.com': 'APPLE', 'facebook.com': 'FACEBOOK' };
    let provider = 'CUSTOM';
    try {
      const claims = JSON.parse(Buffer.from(this.session.idToken.split('.')[1], 'base64url').toString('utf8'));
      provider = providerMap[claims.firebase?.sign_in_provider] || 'CUSTOM';
    } catch { /* usa default */ }
    return {
      provider,
      appVersion: CONFIG.packageVersion,
      platform: 'ANDROID',
      platformVersion: '14',
      language: 'it',
      emailVerified: true,
    };
  }

  // Registra questo dispositivo come sessione attiva (riporta la sessione qui).
  // È la stessa operazione che l'app ufficiale esegue a ogni login.
  async claimSession() {
    const mutation = 'mutation CreateUser($user: IUser!) { upsertUser(user: $user) }';
    return this.query(mutation, { user: this._userPayload() }, { retry: false, claiming: true, setDevice: true });
  }

  async reclaim() {
    await this.claimSession();
    return this.refreshUserInfo();
  }

  logout() {
    this.session = null;
    this.store.set('session', null);
    this.premium = false;
    this.store.set('premium', false);
    // Rigeneriamo l'identità del dispositivo a ogni logout, così il prossimo accesso
    // (anche con lo stesso account) parte pulito, senza cache/stato dell'account precedente.
    this.deviceId = crypto.randomUUID();
    this.store.set('deviceId', this.deviceId);
    this.store.set('lastLocalId', null);
  }

  _saveSession(s) {
    this.session = s;
    this.store.set('session', s);
  }

  async _refreshToken() {
    const url = `https://securetoken.googleapis.com/v1/token?key=${CONFIG.firebaseApiKey}`;
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.useAndroidHeaders) {
      headers['X-Android-Package'] = CONFIG.packageName;
      headers['X-Android-Cert'] = CONFIG.androidCert;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.session.refreshToken }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.logout();
      throw new ApiError('Sessione scaduta: effettua di nuovo l\'accesso.', body);
    }
    this._saveSession({
      ...this.session,
      idToken: body.id_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    });
  }

  async _getIdToken() {
    if (!this.isLoggedIn()) return null;
    if (!this.session.idToken || Date.now() > this.session.expiresAt - 5 * 60 * 1000) {
      await this._refreshToken();
    }
    return this.session.idToken;
  }

  // ---------- GraphQL ----------

  async _headers({ setDevice = false } = {}) {
    const h = {
      accept: '*/*',
      'content-type': 'application/json',
      'x-package-name': CONFIG.packageName,
      'User-Agent': CONFIG.packageName,
      'x-package-version': CONFIG.packageVersion,
      'x-device-id': this.deviceId,
      'x-user-premium': String(!!this.premium),
    };
    // Header che l'app invia solo con la mutation createUser al login: dice al server
    // "registra come dispositivo attivo quello indicato in x-device-id". Senza, il
    // controllo di concorrenza blocca anche la mutation stessa (403 user-concurrency).
    if (setDevice) h['x-set-device-id'] = 'true';
    const token = await this._getIdToken();
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  }

  async query(query, variables = {}, { retry = true, claiming = false, setDevice = false, reclaimed = false } = {}) {
    const res = await fetch(CONFIG.graphqlUrl, {
      method: 'POST',
      headers: await this._headers({ setDevice }),
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }

    if (res.status === 401 && retry && this.isLoggedIn()) {
      await this._refreshToken();
      return this.query(query, variables, { retry: false });
    }
    // Un altro dispositivo (di solito il telefono) ha preso la sessione.
    // Riportiamo automaticamente la sessione su questo computer (registrazione dispositivo)
    // e ritentiamo una volta: così il PC torna attivo da solo, senza intervento.
    if (res.status === 403 && /user-concurrency/i.test(text) && !claiming && !reclaimed) {
      try { await this.claimSession(); } catch { /* se fallisce, cadiamo nel caso gestito sotto */ }
      return this.query(query, variables, { retry, claiming, setDevice, reclaimed: true });
    }
    // Se anche dopo aver reclamato la sessione resta occupata (es. il telefono la
    // ri-prende di continuo), segnaliamo con un errore gestito e il pulsante "Usa qui".
    if (res.status === 403 && /user-concurrency/i.test(text) && !claiming) {
      const e = new ApiError('La sessione è attiva su un altro dispositivo (di solito il telefono). Riportala su questo computer con "Usa qui".', { status: 403, body: text.slice(0, 500) });
      e.code = 'USER_CONCURRENCY';
      throw e;
    }
    if (!res.ok && !(body && (body.data || body.errors))) {
      const msg = body?.message || body?.error || text.slice(0, 200) || res.statusText;
      throw new ApiError(`Il server ha risposto HTTP ${res.status}: ${msg}`, { status: res.status, body: text.slice(0, 1000) });
    }
    if (!body) throw new ApiError(`Risposta non valida dal server (HTTP ${res.status})`, text.slice(0, 500));
    if (body.errors?.length && !body.data) {
      throw new ApiError(body.errors.map(e => e.message).join('; '), body.errors);
    }
    return { data: body.data, errors: body.errors || null };
  }

  // Richiesta di prova con tutti i dettagli (token oscurato) per capire perché il server rifiuta.
  async diagnose() {
    const out = { time: new Date().toISOString(), graphqlUrl: CONFIG.graphqlUrl, loggedIn: this.isLoggedIn(), useAndroidHeaders: this.useAndroidHeaders };
    try {
      const headers = await this._headers();
      out.headersSent = { ...headers, authorization: headers.authorization ? `Bearer ${headers.authorization.slice(7, 19)}…(${headers.authorization.length - 7} car.)` : '(nessuno)' };
      const tok = headers.authorization?.slice(7);
      if (tok) {
        try {
          const c = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
          out.tokenClaims = {
            iss: c.iss, aud: c.aud, sign_in_provider: c.firebase?.sign_in_provider, email_verified: c.email_verified,
            uid: c.user_id ? `${c.user_id.slice(0, 6)}…` : undefined,
            scaduto: c.exp * 1000 < Date.now(), scade: new Date(c.exp * 1000).toISOString(),
          };
        } catch (e) { out.tokenClaims = `non leggibile: ${e.message}`; }
      }
      const probe = async (q, vars = {}, setDevice = false) => {
        const hh = setDevice ? { ...headers, 'x-set-device-id': 'true' } : headers;
        const res = await fetch(CONFIG.graphqlUrl, { method: 'POST', headers: hh, body: JSON.stringify({ query: q, variables: vars }) });
        return { status: res.status, body: (await res.text()).slice(0, 500) };
      };
      // 1) stato attuale  2) registra questo dispositivo con x-set-device-id (come l'app al login)  3) riprova
      out.step1_prima = await probe('query GetSeasons { seasons { id name } }');
      out.userPayload = this._userPayload();
      out.step2_claim = await probe('mutation CreateUser($user: IUser!) { upsertUser(user: $user) }', { user: this._userPayload() }, true);
      out.step3_dopo = await probe('query GetSeasons { seasons { id name } }');
      out.esito = out.step3_dopo.status === 200 ? 'OK: dopo la registrazione del dispositivo le richieste funzionano.' : 'Ancora bloccato: serve un altro meccanismo.';
    } catch (e) { out.error = e.message; }
    return out;
  }

  async refreshUserInfo() {
    const { USER_INFO } = require('./queries');
    const { data } = await this.query(USER_INFO);
    if (data?.user) {
      this.premium = !!data.user.premium;
      this.store.set('premium', this.premium);
    }
    return data?.user || null;
  }
}

function translateFirebaseError(code) {
  const map = {
    EMAIL_NOT_FOUND: 'Email non registrata.',
    INVALID_PASSWORD: 'Password errata.',
    INVALID_LOGIN_CREDENTIALS: 'Email o password errate.',
    USER_DISABLED: 'Account disabilitato.',
    INVALID_EMAIL: 'Email non valida.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Troppi tentativi: riprova tra qualche minuto.',
  };
  const key = String(code).split(' ')[0].split(':')[0];
  return map[key] || `Accesso non riuscito (${code}).`;
}

module.exports = { FipApi, ApiError, CONFIG };
