'use strict';

/**
 * 内容库：加载、校验并按情绪挑选「当日可用」的箴言条目。
 * 内容文件自带版本号，API 响应会携带该版本，便于前端缓存与回溯。
 */

const fs = require('fs');
const path = require('path');

const MOODS = Object.freeze(['unease', 'lucidity', 'solitude', 'courage', 'calm']);

class ContentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function toDateStr(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new ContentError('BAD_DATE', 'invalid date');
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isAvailableOn(entry, dateStr) {
  if (entry.availableFrom && dateStr < entry.availableFrom) return false;
  if (entry.availableTo && dateStr > entry.availableTo) return false;
  return true;
}

function validate(content) {
  if (!content || typeof content !== 'object') {
    throw new ContentError('BAD_CONTENT', 'content must be an object');
  }
  if (typeof content.version !== 'string' || !content.version) {
    throw new ContentError('BAD_CONTENT', 'content.version is required');
  }
  if (!Array.isArray(content.entries)) {
    throw new ContentError('BAD_CONTENT', 'content.entries must be an array');
  }
  const seen = new Set();
  for (const entry of content.entries) {
    for (const field of ['id', 'mood', 'quote', 'philosopher', 'year', 'response', 'image']) {
      if (typeof entry[field] !== 'string' || !entry[field]) {
        throw new ContentError('BAD_CONTENT', `entry missing field: ${field}`);
      }
    }
    if (!MOODS.includes(entry.mood)) {
      throw new ContentError('BAD_CONTENT', `entry ${entry.id} has unknown mood: ${entry.mood}`);
    }
    if (seen.has(entry.id)) {
      throw new ContentError('BAD_CONTENT', `duplicate entry id: ${entry.id}`);
    }
    seen.add(entry.id);
  }
  return content;
}

function loadContent(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ContentError('BAD_CONTENT', `content file is not valid JSON: ${err.message}`);
  }
  return validate(parsed);
}

/**
 * 从内容库中按情绪随机挑选一条当日可用的内容。
 * @returns {object|null} 命中条目；当日无可用内容时返回 null。
 * @throws {ContentError} code = 'UNKNOWN_MOOD' 当情绪参数未知。
 */
function pick(content, mood, options = {}) {
  const { excludeId = null, date = new Date(), random = Math.random } = options;
  if (!MOODS.includes(mood)) {
    throw new ContentError('UNKNOWN_MOOD', `unknown mood: ${mood}`);
  }
  const dateStr = toDateStr(date);
  const pool = content.entries.filter(
    (entry) => entry.mood === mood && isAvailableOn(entry, dateStr)
  );
  if (pool.length === 0) return null;

  // 池中多于一条时，避开上一次显影结果，缓解“随机结果重复”。
  let candidates = pool;
  if (excludeId && pool.length > 1) {
    const filtered = pool.filter((entry) => entry.id !== excludeId);
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[Math.floor(random() * candidates.length)];
}

function findById(content, id) {
  return content.entries.find((entry) => entry.id === id) || null;
}

const DEFAULT_CONTENT_PATH = path.join(__dirname, '..', 'content', 'aphorisms.v1.json');

module.exports = {
  MOODS,
  ContentError,
  validate,
  loadContent,
  pick,
  findById,
  isAvailableOn,
  toDateStr,
  DEFAULT_CONTENT_PATH,
};
