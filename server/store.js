/**
 * JSON 文件持久化：原子写入（tmp + rename），内存索引去重。
 * 收藏以 (clientId, quoteId) 唯一；显影记录以客户端生成的 id 唯一。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    ensureDir();
    this.favFile = path.join(DATA_DIR, 'favorites.json');
    this.recFile = path.join(DATA_DIR, 'records.json');
    this.favorites = loadJson(this.favFile, []);
    this.records = loadJson(this.recFile, []);
    this.favKeys = new Set(this.favorites.map((f) => `${f.clientId}::${f.quoteId}`));
    this.recIds = new Set(this.records.map((r) => r.id));
  }

  /**
   * 保存收藏。重复 (clientId, quoteId) 返回 { ok:false, code:'DUPLICATE' }。
   */
  addFavorite({ clientId, quoteId, snapshot }) {
    const key = `${clientId}::${quoteId}`;
    if (this.favKeys.has(key)) return { ok: false, code: 'DUPLICATE' };
    const fav = {
      id: `fav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      clientId,
      quoteId,
      snapshot,
      savedAt: new Date().toISOString(),
    };
    this.favorites.push(fav);
    this.favKeys.add(key);
    atomicWrite(this.favFile, this.favorites);
    return { ok: true, favorite: fav };
  }

  listFavorites(clientId) {
    return this.favorites.filter((f) => f.clientId === clientId);
  }

  /**
   * 保存显影记录。重复 id 返回 DUPLICATE（网络重试/双击安全）。
   */
  addRecord(rec) {
    if (this.recIds.has(rec.id)) return { ok: false, code: 'DUPLICATE' };
    const record = { ...rec, receivedAt: new Date().toISOString() };
    this.records.push(record);
    this.recIds.add(rec.id);
    atomicWrite(this.recFile, this.records);
    return { ok: true, record };
  }
}

module.exports = new Store();
