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

module.exports = { getDeviceInfo };
