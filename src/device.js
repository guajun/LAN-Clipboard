const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'device.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDeviceInfo() {
  ensureDataDir();
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {}
  const info = { id: uuidv4(), name: `device-${Math.random().toString(36).slice(2,6)}` };
  try { fs.writeFileSync(FILE, JSON.stringify(info, null, 2), 'utf8'); } catch (e) {}
  return info;
}

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function getConfig() {
  ensureDataDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {}
  const def = { serverUrl: 'http://127.0.0.1', port: 3000 };
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 2), 'utf8'); } catch (e) {}
  return def;
}

function setConfig(cfg) {
  ensureDataDir();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg || {}, null, 2), 'utf8'); return true; } catch (e) { return false; }
}

module.exports = { getDeviceInfo, getConfig, setConfig };
