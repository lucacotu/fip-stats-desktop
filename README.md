# FIP Stats Desktop

Client **desktop non ufficiale** per i dati di **FIP Stats** (statistiche della pallacanestro
FIP, piattaforma NBN23), per **macOS e Windows**. Replica e amplia le funzioni dell'app mobile ufficiale
usandone le stesse API, così da poter consultare i dati comodamente dal Mac — con il **proprio
account** FIP Stats (incluso l'account Gold, se posseduto).

> ⚠️ **Progetto personale e non ufficiale.** Non è affiliato né approvato da FIP o NBN23.
> Usa le API private dell'app ufficiale (versione Android 2.13.0), che possono cambiare o
> smettere di funzionare in qualsiasi momento. Serve un tuo account FIP Stats: l'app **non**
> aggira l'abbonamento Gold, si limita ad accedere con le tue credenziali.

<p align="center">
  <img src="build/icon.png" width="140" alt="Icona FIP Stats Desktop">
</p>

---

## Caratteristiche

- **Login con il tuo account** (email e password), come nell'app ufficiale. Supporta account
  **Gold** e **Fan**: in modalità Fan compare un avviso dove alcuni dati sono limitati.
- **Home** con i prossimi incontri e i risultati delle squadre che segui.
- **Ricerca** di campionati, squadre e giocatori; dai titoli di sezione si aprono *tutti* i
  risultati di quella categoria, non solo i primi.
- **Campionati**: calendario giornata per giornata (con apertura automatica sulla giornata
  della prossima partita), classifica, classifiche giocatori e numeri complessivi del torneo.
- **Squadre**: calendario e risultati, rosa con statistiche per giocatore, statistiche di
  squadra, classifica e **quintetti** (lineup) con minuti e punti.
- **Partite**: tabellino completo, leader della gara, flusso punteggio, mappa dei tiri,
  **play-by-play** azione per azione e formazioni.
- **Giocatori**: statistiche nel campionato, andamento gara per gara e carriera completa
  (profilo unico su più stagioni/squadre).
- **Segui squadre e campionati** direttamente dal desktop, con un tasto nella pagina della
  squadra o del campionato (si sincronizza con i "Seguiti" dell'app sul telefono).
- **Esportazione CSV** di tabelle e classifiche.
- Navigazione con cronologia (tasto Indietro) che ricorda anche la scheda in cui ti trovavi.
- Interfaccia in **italiano**, tema scuro.

---

## Installazione (consigliata, senza terminale)

Scarica il file adatto al tuo sistema dalla sezione **[Releases](../../releases)** del repository.

### macOS (Intel e Apple Silicon)

1. Scarica `FIP-Stats-Desktop-1.0.0-universal.dmg` (va bene sia per i Mac con chip Apple sia per quelli Intel).
2. Fai doppio clic per aprirlo e **trascina** l'icona *FIP Stats Desktop* nella cartella **Applicazioni**.
3. Apri l'app dalla cartella Applicazioni. **Al primo avvio**, siccome l'app non è firmata con un
   certificato Apple a pagamento, macOS chiede conferma: fai **clic destro sull'app → Apri**, poi di
   nuovo **Apri** nella finestra che compare. Da quel momento parte con un normale doppio clic.

> Se macOS dicesse che l'app *«è danneggiata e non può essere aperta»* (succede con le app non
> firmate scaricate da internet), rimuovi la quarantena una volta sola da Terminale:
> ```
> xattr -dr com.apple.quarantine "/Applications/FIP Stats Desktop.app"
> ```
> e riapri l'app.

### Windows

1. Scarica `FIP-Stats-Desktop-Setup-1.0.0.exe`.
2. Avvia l'installer e segui la procedura (puoi scegliere la cartella di installazione).
3. **Al primo avvio** Windows SmartScreen può mostrare *«Windows ha protetto il PC»* (l'app non è
   firmata): fai clic su **Ulteriori informazioni → Esegui comunque**. Da quel momento parte normalmente.

---

## Avvio da sorgente (sviluppatori)

Serve [Node.js](https://nodejs.org) 18 o successivo.

```bash
npm install     # installa le dipendenze (Electron, electron-builder)
npm start       # avvia l'app in modalità sviluppo
```

## Creare gli installer da sé

Ogni installer si costruisce **sul sistema operativo corrispondente** (gli strumenti di
packaging sono specifici di ogni piattaforma):

```bash
npm install
npm run dist        # costruisce per il sistema su cui lo lanci
# oppure, esplicitamente:
npm run dist:mac    # su macOS  → dist/FIP-Stats-Desktop-1.0.0-universal.dmg (+ .zip)
npm run dist:win    # su Windows → dist/FIP-Stats-Desktop-Setup-1.0.0.exe
```

- Su **macOS** il build produce un pacchetto *universal* (Intel + Apple Silicon in un solo file).
  L'app viene firmata *ad-hoc* automaticamente (nessun Apple Developer ID richiesto).
- Su **Windows** il build produce un installer NSIS (`.exe`).

### Build automatico per tutte le piattaforme (GitHub Actions)

Il repository include un workflow (`.github/workflows/release.yml`) che costruisce
**automaticamente** gli installer macOS e Windows in cloud e li allega alla Release. Non serve
possedere entrambe le macchine. Per usarlo:

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub avvia il build su un runner macOS e uno Windows e, al termine, pubblica i due installer
nella Release del tag. Si può anche lanciare a mano dalla scheda **Actions → Build & Release → Run workflow**.

---

## Struttura del progetto

```
fip-stats-desktop/
├─ main.js            # processo principale Electron: finestra, IPC, storage, salvataggio CSV
├─ preload.js         # ponte sicuro (contextBridge) tra interfaccia e processo principale
├─ src/
│  ├─ api.js          # login Firebase, rinnovo token, chiamate GraphQL, gestione sessione
│  └─ queries.js      # query e mutation GraphQL estratte dall'app ufficiale
├─ renderer/          # interfaccia (HTML/CSS/JS, senza passaggi di build)
│  ├─ index.html
│  ├─ app.js
│  └─ styles.css
├─ build/
│  └─ icon.png        # icona dell'app (electron-builder genera .icns per Mac e .ico per Windows)
├─ .github/
│  └─ workflows/
│     └─ release.yml  # build automatico mac+win e pubblicazione nella Release
└─ package.json
```

---

## Sicurezza e privacy

- La **password non viene mai salvata né registrata**: è usata solo al momento del login per la
  singola richiesta a Firebase, poi scartata (il campo del form viene svuotato). Nessuna query al
  server di FIP la riceve, quindi non è recuperabile dall'app.
- L'unica credenziale conservata è il **token di sessione**, cifrato con il **Portachiavi di
  macOS** (`safeStorage`). Se la cifratura non fosse disponibile, il token **non** viene scritto
  su disco (resta solo in memoria).
- Finestra con `contextIsolation` attivo e `nodeIntegration` disattivato; l'interfaccia non ha
  accesso diretto al file system.
- Nella **build di distribuzione** gli **strumenti per sviluppatori (DevTools) sono disattivati**,
  così chi ha accesso fisico al Mac non può ispezionare i token di sessione.
- Nessun dato viene inviato a terzi: l'app comunica **solo** con Firebase (login) e con il server
  di FIP Stats (dati).

---

## Avvertenze

Software fornito "così com'è", per uso personale e a scopo di studio/interoperabilità. Rispetta i
Termini di Servizio di FIP/NBN23 e usa esclusivamente il tuo account. Le API sono private e non
documentate: possono cambiare senza preavviso.
