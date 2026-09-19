'use strict';

/**
 * 持久化存储：用户收藏与显影记录。
 * - 收藏按 (clientId, contentId) 去重，重复写入抛 DUPLICATE；
 * - 显影记录按客户端事件 id 幂等去重（安全重试不产生重复行）；
 * - 写入采用「临时文件 + rename」保证原子性，避免半截 JSON。
 */

const fs = require('fs');
const path = require('path');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // 文件损坏时备份坏文件而不是直接崩溃，下次写入会重建。
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch (_) {
      /* 备份失败也继续，保证服务可用 */
    }
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.favoritesFile = path.join(dataDir, 'favorites.json');
    this.generationsFile = path.join(dataDir, 'generations.json');
    this.favorites = readJsonSafe(this.favoritesFile, { items: [] });
    this.generations = readJsonSafe(this.generationsFile, { events: [] });
  }

  /**
   * 保存一次收藏。重复收藏抛 StoreError(code='DUPLICATE')。
   * snapshot 由服务端从内容库生成，不信任客户端提交的正文。
   */
  addFavorite({ clientId, contentId, snapshot }) {
    const exists = this.favorites.items.some(
      (item) => item.clientId === clientId && item.contentId === contentId
    );
    if (exists) {
      throw new StoreError('DUPLICATE', 'favorite already exists');
    }
    const item = {
      clientId,
      contentId,
      snapshot,
      savedAt: new Date().toISOString(),
    };
    this.favorites.items.push(item);
    writeJsonAtomic(this.favoritesFile, this.favorites);
    return item;
  }

  listFavorites(clientId) {
    return this.favorites.items.filter((item) => item.clientId === clientId);
  }

  /**
   * 记录一次显影事件。同一事件 id 重复提交时不重复写入，
   * 返回 { deduped: true }，让客户端重试是安全的。
   */
  addGeneration(event) {
    if (!event || typeof event.id !== 'string' || !event.id) {
      throw new StoreError('BAD_EVENT', 'event.id is required');
    }
    const exists = this.generations.events.some((e) => e.id === event.id);
    if (exists) {
      return { deduped: true, event: this.generations.events.find((e) => e.id === event.id) };
    }
    const stored = { ...event, recordedAt: new Date().toISOString() };
    this.generations.events.push(stored);
    writeJsonAtomic(this.generationsFile, this.generations);
    return { deduped: false, event: stored };
  }
}

module.exports = { Store, StoreError };
