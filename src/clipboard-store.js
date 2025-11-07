const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const META_FILE = path.join(DATA_DIR, 'items.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(META_FILE)) fs.writeFileSync(META_FILE, JSON.stringify([]), 'utf8');
}

function readMeta() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

function writeMeta(items) {
  ensureDataDir();
  fs.writeFileSync(META_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function listItems() {
  const items = readMeta();
  // sort by timestamp descending
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function addFileItem(originalName, tmpPath, mimeType) {
  ensureDataDir();
  const id = uuidv4();
  const ext = path.extname(originalName) || '';
  const storedName = id + ext;
  const dest = path.join(DATA_DIR, storedName);
  fs.renameSync(tmpPath, dest);
  const item = {
    id,
    type: 'file',
    name: originalName,
    storedName,
    mimeType: mimeType || 'application/octet-stream',
    size: fs.statSync(dest).size,
    timestamp: Date.now()
  };
  const items = readMeta();
  items.push(item);
  writeMeta(items);
  return item;
}

function addTextItem(text) {
  const id = uuidv4();
  const item = {
    id,
    type: 'text',
    text: String(text),
    timestamp: Date.now()
  };
  const items = readMeta();
  items.push(item);
  writeMeta(items);
  return item;
}

function getItemPath(item) {
  if (item.type !== 'file') return null;
  return path.join(DATA_DIR, item.storedName);
}

function getItemById(id) {
  const items = readMeta();
  return items.find(i => i.id === id) || null;
}

function deleteItem(id) {
  const items = readMeta();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return false;
  const [item] = items.splice(idx, 1);
  writeMeta(items);
  if (item.type === 'file') {
    const p = getItemPath(item);
    try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  return true;
}

function updateItem(id, updater) {
  const items = readMeta();
  const idx = items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const item = items[idx];
  const updated = typeof updater === 'function' ? updater(Object.assign({}, item)) : Object.assign({}, item, updater || {});
  items[idx] = updated;
  writeMeta(items);
  return updated;
}

function setCut(id, ownerDeviceId, pendingDeviceIds, ttlSeconds = 300) {
  const token = uuidv4();
  const expireAt = Date.now() + ttlSeconds * 1000;
  const updated = updateItem(id, (it) => {
    it.cut = {
      token,
      owner: ownerDeviceId,
      pending: Array.isArray(pendingDeviceIds) ? pendingDeviceIds.slice() : [],
      expireAt
    };
    return it;
  });
  return updated;
}

function clearCut(id) {
  return updateItem(id, (it) => { if (it && it.cut) delete it.cut; return it; });
}

module.exports = {
  ensureDataDir,
  listItems,
  addFileItem,
  addTextItem,
  getItemPath,
  getItemById,
  deleteItem,
  updateItem,
  setCut,
  clearCut,
  DATA_DIR
};
