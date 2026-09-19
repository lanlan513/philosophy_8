/**
 * 版本化内容加载与按日过滤。
 * - 内容目录 content/<version>/quotes.json，ACTIVE 版本由环境变量 CONTENT_VERSION 指定（默认 v1）。
 * - 条目可带 notBefore / notAfter（ISO 日期），仅在当天可用。
 */
const fs = require('fs');
const path = require('path');

const CONTENT_ROOT = path.join(__dirname, '..', 'content');

function loadContent(version) {
  const file = path.join(CONTENT_ROOT, version, 'quotes.json');
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data.items) || !Array.isArray(data.emotions)) {
    throw new Error(`内容文件格式非法: ${file}`);
  }
  return data;
}

const activeVersion = process.env.CONTENT_VERSION || 'v1';
const content = loadContent(activeVersion);
const EMOTIONS = new Set(content.emotions);

function isValidEmotion(emotion) {
  return EMOTIONS.has(emotion);
}

/** 条目在指定日期是否可用 */
function isAvailableOn(item, date) {
  const day = toDay(date);
  if (item.notBefore && day < item.notBefore) return false;
  if (item.notAfter && day > item.notAfter) return false;
  return true;
}

function toDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

/**
 * 按情绪抽取一条当日可用内容。
 * @param {string} emotion
 * @param {string[]} excludeIds 需要避开的条目 id（避免连续重复）
 * @param {Date} [now]
 * @returns {{item: object|null, poolSize: number}}
 */
function pick(emotion, excludeIds = [], now = new Date()) {
  if (!isValidEmotion(emotion)) return { item: null, poolSize: -1 };
  const pool = content.items.filter(
    (it) => it.emotion === emotion && isAvailableOn(it, now)
  );
  if (pool.length === 0) return { item: null, poolSize: 0 };

  const excluded = new Set(excludeIds);
  let candidates = pool.filter((it) => !excluded.has(it.id));
  if (candidates.length === 0) candidates = pool; // 全部都被排除时退回全池

  const item = candidates[Math.floor(Math.random() * candidates.length)];
  return { item, poolSize: pool.length };
}

module.exports = {
  activeVersion,
  isValidEmotion,
  isAvailableOn,
  pick,
  emotions: [...EMOTIONS],
};
