const { app, BrowserWindow, ipcMain, clipboard, nativeImage } = require('electron');
// Log environment at startup to help diagnose Wayland/X11 session detection
console.log('ENV: XDG_SESSION_TYPE=' + (process.env.XDG_SESSION_TYPE || '') +
  ' ELECTRON_ENABLE_WAYLAND=' + (process.env.ELECTRON_ENABLE_WAYLAND || '') +
  ' WAYLAND_DISPLAY=' + (process.env.WAYLAND_DISPLAY || '') +
  ' XDG_RUNTIME_DIR=' + (process.env.XDG_RUNTIME_DIR || ''));
const path = require('path');
const server = require('./web/server'); // will start the web server
const store = require('./src/clipboard-store');
const { getDeviceInfo } = require('./src/device');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const child_process = require('child_process');
const { v4: uuidv4 } = require('uuid');

// Helper to run wl-copy asynchronously with a timeout to avoid blocking the main thread
function runWlCopy(gnomePayload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    // Write payload to a temp file
    const tmpName = `lan-clipboard-wlcopy-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const tmpPath = path.join(os.tmpdir(), tmpName);
    try {
      fs.writeFileSync(tmpPath, gnomePayload, 'utf8');
    } catch (e) {
      return resolve({ status: null, error: e, stdout: '', stderr: (e && e.message) || '' });
    }

    // Use shell pipeline and background (&) so the child may stay alive without blocking us.
    // We will not wait for the wl-copy process to exit; instead we immediately probe wl-paste.
    // This mimics the user's `printf 'copy\nfile://...' | wl-copy --type x-special/gnome-copied-files` behavior.
    const safeTmp = tmpPath.replace(/'/g, "'\\''");
    const cmd = `sh -c "wl-copy --type x-special/gnome-copied-files < '${safeTmp}' >/dev/null 2>&1 &"`;
    try {
      // spawn the backgrounded shell command; child exit indicates shell started the background job
      const cp = child_process.spawn('sh', ['-c', `wl-copy --type x-special/gnome-copied-files < '${safeTmp}' >/dev/null 2>&1 &`], { env: process.env });
      // give the system a short moment, then probe wk-paste for the type
      setTimeout(() => {
        try {
          const check = child_process.spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8', timeout: 2000, env: process.env });
          try { fs.unlinkSync(tmpPath); } catch (e) {}
          if (check && check.status === 0 && check.stdout && check.stdout.includes('x-special/gnome-copied-files')) {
            return resolve({ status: 0, stdout: check.stdout, stderr: check.stderr || '' });
          }
          return resolve({ status: null, timedOut: true, stdout: check && check.stdout || '', stderr: check && check.stderr || '' });
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch (e2) {}
          return resolve({ status: null, error: e, stdout: '', stderr: (e && e.message) || '' });
        }
      }, 150);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (e2) {}
      return resolve({ status: null, error: e, stdout: '', stderr: (e && e.message) || '' });
    }
  });
}

// device info
const deviceInfo = getDeviceInfo();
let wsClient = null;

function connectToServerWS() {
  try {
    const url = `ws://127.0.0.1:${process.env.PORT || 3000}`;
    wsClient = new WebSocket(url);
    wsClient.on('open', () => {
      wsClient.send(JSON.stringify({ type: 'register', deviceId: deviceInfo.id, name: deviceInfo.name }));
    });
    wsClient.on('message', (m) => {
      // ignore for now or could be used to show notifications
      try { const msg = JSON.parse(m.toString()); /* console.log('ws msg', msg); */ } catch (e) {}
    });
    wsClient.on('close', () => { setTimeout(connectToServerWS, 2000); });
    wsClient.on('error', () => { /* ignore */ });
  } catch (e) {}
}

// start WS client after a short delay to allow server to be ready when running in same process
setTimeout(connectToServerWS, 500);

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // load local renderer
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// IPC handlers for copy/paste operations
ipcMain.handle('list-items', async () => {
  return store.listItems();
});

ipcMain.handle('copy-item', async (event, ids) => {
  // ids may be a single id string or an array of ids
  const idList = Array.isArray(ids) ? ids.slice() : [ids];
  const items = idList.map(id => store.getItemById(id)).filter(Boolean);
  if (items.length === 0) return { ok: false, error: 'not found' };

  // If all items are text and single, write as text
  if (items.length === 1 && items[0].type === 'text') {
    clipboard.writeText(items[0].text);
    return { ok: true };
  }

  // Collect file paths (for file items).
  // To ensure pasted files keep their original filenames in the file manager,
  // create a UUID-named temp directory for this copy operation and copy each
  // file into that directory using the original basename. This avoids naming
  // collisions while preserving the original filename for paste.
  const tmpDirForCopy = path.join(store.DATA_DIR, 'tmp');
  if (!fs.existsSync(tmpDirForCopy)) fs.mkdirSync(tmpDirForCopy, { recursive: true });
  const filePaths = [];
  const batchId = uuidv4();
  const batchDir = path.join(tmpDirForCopy, batchId);
  try { if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true }); } catch (e) { /* ignore */ }
  for (const it of items) {
    if (it.type !== 'file') continue;
    const stored = store.getItemPath(it);
    if (!stored) continue;
    // Use the original name (it.name) as the basename for the temp copy
    const safeBase = (it.name || path.basename(stored)).replace(/\"/g, '').replace(/[^\w.%+-]/g, '_');
    const tmpPath = path.join(batchDir, safeBase);
    try {
      fs.copyFileSync(stored, tmpPath);
      filePaths.push(tmpPath);
    } catch (e) {
      console.error('failed to copy file to tmp for clipboard copy:', stored, tmpPath, e && e.message);
      // fallback to original stored path if copy fails
      filePaths.push(stored);
    }
  }

  // Platform-specific behavior: on Linux/GNOME, write x-special/gnome-copied-files and text/uri-list
  if (process.platform === 'linux' && filePaths.length > 0) {
    try {
      // Build properly encoded file:// URIs
      const fileURLs = filePaths.map(p => {
        try { return pathToFileURL(p).href; } catch (e) { return 'file://' + p; }
      });
      const uris = fileURLs.join('\n');
      // NOTE: GNOME x-special/gnome-copied-files payload must exactly match the expected format
      // (no trailing newline). Use 'copy\n<file://...>' as the payload.
      const gnome = 'copy\n' + uris;
      // Try wl-copy unconditionally (user requested the exact wl-copy behavior). If it succeeds, we're done.
      try {
        try {
          const wlRes = await runWlCopy(gnome, 8000);
          if (wlRes && wlRes.status === 0) {
            console.log('wl-copy succeeded for x-special/gnome-copied-files');
            return { ok: true };
          }
          if (wlRes && wlRes.timedOut) {
            // quick check: maybe wl-copy actually populated the Wayland clipboard despite timing out
            try {
              const check = child_process.spawnSync('wl-paste', ['--list-types'], { encoding: 'utf8', timeout: 2000, env: process.env });
              if (check && check.status === 0 && check.stdout && check.stdout.includes('x-special/gnome-copied-files')) {
                // wl-paste shows the GNOME clipboard type — treat as success silently
                return { ok: true };
              } else {
                console.warn('wl-copy timed out and wl-paste did not report x-special/gnome-copied-files; falling back to clipboard.writeBuffer', wlRes.stdout || '', wlRes.stderr || '');
              }
            } catch (e) {
              console.warn('wl-copy timed out and wl-paste check failed; falling back to clipboard.writeBuffer', e && e.message, wlRes.stdout || '', wlRes.stderr || '');
            }
          } else if (wlRes && wlRes.error) {
            console.warn('wl-copy error, falling back to clipboard.writeBuffer', wlRes.error && wlRes.error.message, wlRes.stdout || '', wlRes.stderr || '');
          } else {
            console.warn('wl-copy returned non-zero, falling back to clipboard.writeBuffer', wlRes && wlRes.status, wlRes.stdout || '', wlRes.stderr || '');
          }
        } catch (e) {
          console.warn('wl-copy async call failed', e && e.message);
        }
      } catch (e) {}
      // write buffers for these MIME types (ensure utf8)
  try { clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(gnome, 'utf8')); } catch (e) { console.error('writeBuffer gnome failed', e); }
  try { clipboard.writeBuffer('text/uri-list', Buffer.from(uris + '\n', 'utf8')); } catch (e) { console.error('writeBuffer uri-list failed', e); }
  try { clipboard.writeBuffer('text/plain;charset=utf-8', Buffer.from(filePaths.join('\n'), 'utf8')); } catch (e) { /* ignore */ }
      // also set plain text of paths
      try { clipboard.writeText(filePaths.join('\n')); } catch (e) { /* ignore */ }

      // Debug: log what's written and available formats
      try {
        const formats = clipboard.availableFormats ? clipboard.availableFormats() : [];
        console.log('clipboard formats after write:', formats);
        // attempt to read back buffers for inspection
        if (formats.includes('x-special/gnome-copied-files')) {
          try {
            const buf = clipboard.readBuffer('x-special/gnome-copied-files');
            console.log('x-special/gnome-copied-files contents:\n' + buf.toString('utf8'));
          } catch (e) { console.error('readBuffer gnome failed', e); }
        }
        if (formats.includes('text/uri-list')) {
          try {
            const buf2 = clipboard.readBuffer('text/uri-list');
            console.log('text/uri-list contents:\n' + buf2.toString('utf8'));
          } catch (e) { console.error('readBuffer uri-list failed', e); }
        }
        // async: probe wl-paste --list-types to see what Wayland clipboard exposes (non-blocking)
        try {
          const probe = child_process.spawn('wl-paste', ['--list-types']);
          let out = '';
          let err = '';
          const tmo = setTimeout(() => { try { probe.kill(); } catch (e) {} }, 2000);
          if (probe.stdout) probe.stdout.on('data', (c) => { try { out += c.toString(); } catch (e) {} });
          if (probe.stderr) probe.stderr.on('data', (c) => { try { err += c.toString(); } catch (e) {} });
          probe.on('close', (code) => {
            clearTimeout(tmo);
            console.log('wl-paste --list-types exit', code, 'out:', out.trim(), 'err:', err.trim());
          });
        } catch (e) { /* ignore */ }

        // log existence of each file path
        for (const p of filePaths) {
          try { console.log('file exists?', p, fs.existsSync(p)); } catch (e) { console.log('file exists check failed for', p, e && e.message); }
        }
      } catch (e) { /* ignore debug errors */ }

      return { ok: true };
    } catch (e) {
      // fallback
    }
  }

  // For images or single file, try to set image if applicable
  if (filePaths.length === 1) {
    const p = filePaths[0];
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        clipboard.writeImage(img);
        return { ok: true };
      }
    } catch (e) {}
    // fallback to writing path as text
    clipboard.writeText(p);
    return { ok: true };
  }

  // If multiple non-file items or fallback, write their text join
  const texts = items.map(it => it.type === 'text' ? it.text : (store.getItemPath(it) || '')).filter(Boolean);
  if (texts.length) {
    clipboard.writeText(texts.join('\n'));
    return { ok: true };
  }

  return { ok: false };
});

async function postPasteAck(item) {
  if (!item || !item.cut) return null;
  const id = item.id;
  const token = item.cut.token;
  const body = JSON.stringify({ deviceId: deviceInfo.id, token });
  const options = {
    hostname: '127.0.0.1',
    port: process.env.PORT || 3000,
    path: `/api/items/${id}/paste-ack`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c.toString());
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.write(body);
    req.end();
  });
}

ipcMain.handle('paste-item', async (event, id) => {
  try {
    const it = store.getItemById(id);
    if (!it) return { ok: false, error: 'not found' };
    // file item: if local file missing, download from configured server first
    if (it.type === 'file') {
      const p = store.getItemPath(it);
      if (!p || !fs.existsSync(p)) {
        // start download from configured server
        const cfg = require('./src/device').getConfig();
        const base = (cfg && cfg.serverUrl) ? cfg.serverUrl.replace(/\/$/, '') : null;
        const port = (cfg && cfg.port) ? cfg.port : null;
        if (!base) return { ok: false, error: 'no server configured' };
        const url = `${base}:${port || ''}/api/download/${id}`.replace(/:\/\//, '://').replace(/:\/\//, '://');
        // dest path: use existing stored path location if available, else create tmp batch dir
        const tmpDir = path.join(store.DATA_DIR, 'tmp', 'download-'+id);
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
        const dest = path.join(tmpDir, it.name || `${id}${path.extname(it.name||'')}`);
        // stream download and report progress to renderer via event.sender
        (async () => {
          try {
            const parsed = new URL(url);
            const mod = parsed.protocol === 'https:' ? require('https') : require('http');
            const req = mod.get(parsed.href, (res) => {
              if (res.statusCode !== 200) {
                event.sender.send('download-error', { id, status: res.statusCode });
                return;
              }
              const total = parseInt(res.headers['content-length'] || '0', 10);
              let received = 0;
              const ws = fs.createWriteStream(dest);
              res.on('data', (chunk) => {
                received += chunk.length;
                event.sender.send('download-progress', { id, received, total, percent: total ? Math.round(received/total*100) : null });
              });
              res.pipe(ws);
              ws.on('finish', async () => {
                // add to store as file item copying into data dir
                try {
                  const added = store.addFileItem(it.name || path.basename(dest), dest, it.mimeType);
                  // notify renderer that download complete
                  event.sender.send('download-complete', { id: added.id });
                  // after download, write to clipboard (file:// URI)
                  try { clipboard.writeText(pathToFileURL(store.getItemPath(added)).href); } catch (e) {}
                } catch (e) {
                  event.sender.send('download-error', { id, error: e && e.message });
                }
              });
              ws.on('error', (err) => { event.sender.send('download-error', { id, error: err && err.message }); });
            });
            req.on('error', (err) => { event.sender.send('download-error', { id, error: err && err.message }); });
          } catch (e) { event.sender.send('download-error', { id, error: e && e.message }); }
        })();
        return { ok: true, status: 'downloading' };
      }
      // if exists, proceed to write clipboard below
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        clipboard.writeImage(img);
      } else {
        clipboard.writeText(pathToFileURL(p).href);
      }
    } else if (it.type === 'text') {
      clipboard.writeText(it.text);
    }
    // if item is cut, inform server about paste-ack
    if (it.cut && it.cut.token) {
      const result = await postPasteAck(it);
      return { ok: true, pasteAck: result };
    }
    return { ok: true };
  } catch (e) {
    console.error('paste-item: unexpected error', e && e.stack);
    return { ok: false, error: e && e.message, stack: e && e.stack };
  }
});

ipcMain.handle('get-device-id', async () => {
  return deviceInfo && deviceInfo.id;
});

// Create item(s) from system clipboard when user presses paste shortcut while app focused
ipcMain.handle('create-item-from-clipboard', async () => {
  try {
    // prefer image
    const img = clipboard.readImage();
    const formats = clipboard.availableFormats ? clipboard.availableFormats() : [];
    // ensure tmp dir exists
    const tmpDir = path.join(store.DATA_DIR, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // If image present and non-empty, save as PNG
    if (img && !img.isEmpty && !img.isEmpty()) {
      const id = (Math.random().toString(36).slice(2,9));
      const tmpPath = path.join(tmpDir, `clipboard-${Date.now()}-${id}.png`);
      fs.writeFileSync(tmpPath, img.toPNG());
      const item = store.addFileItem(`clipboard-${Date.now()}.png`, tmpPath, 'image/png');
      return { ok: true, created: [item] };
    }

    // If clipboard contains file urls or plain file paths, attempt to add them
    // Check for 'text/uri-list' or similar formats
    let text = '';
    try { text = clipboard.readText(); } catch (e) { text = ''; }
    if (text) {
      // handle file:// URLs or newline-separated paths
      const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const created = [];
      for (const line of lines) {
        let p = line;
        if (p.startsWith('file://')) {
          // convert file:// URL to path
          try { p = decodeURIComponent(p.replace('file://', '')); } catch (e) { p = p.replace('file://', ''); }
        }
        // on Windows file paths might start with /C:/
        if (process.platform === 'win32' && p.startsWith('/')) p = p.slice(1);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          // copy to tmp and add
          const tmpName = `clipboard-file-${Date.now()}-${Math.random().toString(36).slice(2,6)}${path.extname(p)}`;
          const tmpPath = path.join(tmpDir, tmpName);
          fs.copyFileSync(p, tmpPath);
          const it = store.addFileItem(path.basename(p), tmpPath, undefined);
          created.push(it);
        }
      }
      if (created.length) return { ok: true, created };
    }

    // Fallback: treat as text
    if (text && text.trim()) {
      const it = store.addTextItem(text.trim());
      return { ok: true, created: [it] };
    }

    return { ok: false, error: 'clipboard empty or unsupported format' };
  } catch (e) {
    console.error('create-item-from-clipboard: error while processing clipboard', e && e.stack);
    return { ok: false, error: e && e.message, stack: e && e.stack };
  }
});

ipcMain.handle('delete-item', async (event, id) => {
  const ok = store.deleteItem(id);
  return { ok };
});

ipcMain.handle('add-text', async (event, text) => {
  const it = store.addTextItem(text);
  return it;
});
