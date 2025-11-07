const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const mime = require('mime-types');
const store = require('../src/clipboard-store');

const http = require('http');
const WebSocket = require('ws');
const app = express();
const DEFAULT_PORT = process.env.PORT || 3000;

store.ensureDataDir();

// multer temp upload to data/tmp
const tmpDir = path.join(store.DATA_DIR, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir });

app.use(express.json());

// Serve web UI static file (in this repo web/index.html)
app.use('/', express.static(path.join(__dirname, 'public')));

// In-memory devices registry maintained via WebSocket connections
const devices = new Map(); // deviceId -> { id, name, ws, lastSeen, online }

function listKnownDeviceIds() {
  return Array.from(devices.keys());
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const [, d] of devices) {
    try { if (d.ws && d.ws.readyState === WebSocket.OPEN) d.ws.send(raw); } catch (e) {}
  }
}

function notifyDevice(deviceId, msg) {
  const d = devices.get(deviceId);
  if (!d || !d.ws) return;
  try { if (d.ws.readyState === WebSocket.OPEN) d.ws.send(JSON.stringify(msg)); } catch (e) {}
}

app.get('/api/items', (req, res) => {
  res.json(store.listItems());
});

app.get('/api/devices', (req, res) => {
  const arr = Array.from(devices.values()).map(d => ({ id: d.id, name: d.name, online: d.online, lastSeen: d.lastSeen }));
  res.json(arr);
});

// mark an item as cut; ownerDeviceId must be provided in body
app.post('/api/items/:id/cut', (req, res) => {
  const id = req.params.id;
  const owner = req.body && req.body.ownerDeviceId;
  const ttl = req.body && req.body.ttlSeconds ? Number(req.body.ttlSeconds) : 300;
  if (!owner) return res.status(400).json({ error: 'ownerDeviceId required' });
  const item = store.getItemById(id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  // pending devices = all known devices except owner
  const pending = listKnownDeviceIds().filter(did => did !== owner);
  const updated = store.setCut(id, owner, pending, ttl);
  // notify online devices
  broadcast({ type: 'cut-created', itemId: id, cut: updated.cut });
  res.json(updated);
});

// paste-ack endpoint (also used by clients via WebSocket if desired)
app.post('/api/items/:id/paste-ack', (req, res) => {
  const id = req.params.id;
  const deviceId = req.body && req.body.deviceId;
  const token = req.body && req.body.token;
  if (!deviceId || !token) return res.status(400).json({ error: 'deviceId and token required' });
  const item = store.getItemById(id);
  if (!item || !item.cut) return res.status(404).json({ error: 'cut not found for item' });
  if (item.cut.token !== token) return res.status(403).json({ error: 'invalid token' });
  // remove from pending
  const pending = Array.isArray(item.cut.pending) ? item.cut.pending.filter(d => d !== deviceId) : [];
  const updated = store.updateItem(id, (it) => { it.cut.pending = pending; return it; });
  // notify owner
  if (item.cut && item.cut.owner) notifyDevice(item.cut.owner, { type: 'paste-ack', itemId: id, deviceId, pending });
  // if pending empty, delete item
  if (!pending || pending.length === 0) {
    store.deleteItem(id);
    broadcast({ type: 'item-deleted', itemId: id });
    return res.json({ ok: true, deleted: true });
  }
  return res.json({ ok: true, pending });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  // if text field provided, create text item
  if (req.body && req.body.text) {
    const it = store.addTextItem(req.body.text);
    return res.json(it);
  }
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const orig = req.file.originalname || req.file.filename;
  const mimeType = req.file.mimetype || mime.lookup(orig) || 'application/octet-stream';
  const it = store.addFileItem(orig, req.file.path, mimeType);
  res.json(it);
});

app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;
  const item = store.getItemById(id);
  if (!item) return res.status(404).send('not found');
  if (item.type === 'text') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(item.text);
    if (req.query.delete === '1') store.deleteItem(id);
    return;
  }
  const p = store.getItemPath(item);
  if (!p || !fs.existsSync(p)) return res.status(404).send('file missing');
  res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${item.name.replace(/\"/g, '')}"`);
  const stream = fs.createReadStream(p);
  stream.pipe(res);
  stream.on('end', () => {
    if (req.query.delete === '1') store.deleteItem(id);
  });
});

app.delete('/api/delete/:id', (req, res) => {
  const ok = store.deleteItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// small public web UI (served from web/public)
const port = DEFAULT_PORT;

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // each ws must register by sending: { type: 'register', deviceId, name }
  let registeredId = null;
  ws.on('message', (msg) => {
    let data = null;
    try { data = JSON.parse(msg.toString()); } catch (e) { return; }
    if (data && data.type === 'register') {
      const id = data.deviceId || (`anon-${Math.random().toString(36).slice(2,9)}`);
      const name = data.name || 'unknown';
      registeredId = id;
      devices.set(id, { id, name, ws, lastSeen: Date.now(), online: true });
      // ack registration
      ws.send(JSON.stringify({ type: 'registered', deviceId: id }));
      // send current known cuts
      const items = store.listItems().filter(it => it.cut);
      for (const it of items) {
        ws.send(JSON.stringify({ type: 'cut-created', itemId: it.id, cut: it.cut }));
      }
      return;
    }
    if (data && data.type === 'paste-ack') {
      // { type:'paste-ack', itemId, token, deviceId }
      const { itemId, token, deviceId } = data;
      if (!itemId || !token || !deviceId) return;
      // reuse same logic as HTTP endpoint
      const item = store.getItemById(itemId);
      if (!item || !item.cut || item.cut.token !== token) {
        ws.send(JSON.stringify({ type: 'paste-ack-result', ok: false }));
        return;
      }
      const pending = Array.isArray(item.cut.pending) ? item.cut.pending.filter(d => d !== deviceId) : [];
      store.updateItem(itemId, (it) => { it.cut.pending = pending; return it; });
      if (item.cut && item.cut.owner) notifyDevice(item.cut.owner, { type: 'paste-ack', itemId, deviceId, pending });
      if (!pending || pending.length === 0) {
        store.deleteItem(itemId);
        broadcast({ type: 'item-deleted', itemId });
        ws.send(JSON.stringify({ type: 'paste-ack-result', ok: true, deleted: true }));
        return;
      }
      ws.send(JSON.stringify({ type: 'paste-ack-result', ok: true, pending }));
      return;
    }
    // update lastSeen for any other message
    if (registeredId && devices.has(registeredId)) {
      const d = devices.get(registeredId);
      d.lastSeen = Date.now();
      d.online = true;
    }
  });

  ws.on('close', () => {
    if (registeredId && devices.has(registeredId)) {
      const d = devices.get(registeredId);
      d.lastSeen = Date.now();
      d.online = false;
      d.ws = null;
    }
  });
});

// periodic cleanup: clear expired cuts (we choose to clear cut state, not delete item)
setInterval(() => {
  const now = Date.now();
  const items = store.listItems();
  for (const it of items) {
    if (it.cut && it.cut.expireAt && it.cut.expireAt < now) {
      // expire: clear cut state and notify
      store.clearCut(it.id);
      broadcast({ type: 'cut-expired', itemId: it.id });
    }
  }
}, 30 * 1000);

server.listen(port, '0.0.0.0', () => {
  console.log(`Web UI, API and WS available at http://0.0.0.0:${port}`);
});

module.exports = { app, server, wss };
