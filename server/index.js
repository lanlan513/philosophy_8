/**
 * 箴言显影机 · 后端
 * 零依赖 Node HTTP 服务：
 *   GET  /api/develop?emotion=<e>&exclude=<id,id>  按情绪显影一条内容
 *   POST /api/favorites                            保存收藏（重复拒绝）
 *   GET  /api/favorites?clientId=<id>              读取收藏
 *   POST /api/records                              保存显影记录（幂等）
 *   GET  /api/health                               健康检查
 *   静态资源：public/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const content = require('./content');
const store = require('./store');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Version': content.activeVersion,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('BAD_JSON');
  }
}

const isNonEmptyString = (v, max = 200) =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/* ---------- API 处理 ---------- */

function handleDevelop(req, res, url) {
  const emotion = url.searchParams.get('emotion') || '';
  if (!content.isValidEmotion(emotion)) {
    return sendJson(res, 400, {
      error: 'UNKNOWN_EMOTION',
      message: `未知情绪参数：${emotion || '(空)'}`,
      allowed: content.emotions,
    });
  }
  const exclude = (url.searchParams.get('exclude') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);

  const { item, poolSize } = content.pick(emotion, exclude);
  if (!item) {
    return sendJson(res, 404, {
      error: 'NO_CONTENT_TODAY',
      message: '今日该情绪暂无可显影的内容，改日再来，或换一种情绪。',
      emotion,
    });
  }
  sendJson(res, 200, {
    version: content.activeVersion,
    emotion,
    poolSize,
    item: {
      id: item.id,
      quote: item.quote,
      philosopher: item.philosopher,
      era: item.era,
      response: item.response,
      image: item.image,
      alt: item.alt,
    },
  });
}

async function handleAddFavorite(req, res) {
  const body = await parseJsonBody(req);
  const { clientId, quoteId, snapshot } = body;
  if (!isNonEmptyString(clientId, 64) || !isNonEmptyString(quoteId, 64)) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'clientId 与 quoteId 必填。' });
  }
  if (snapshot !== undefined && (typeof snapshot !== 'object' || snapshot === null)) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'snapshot 须为对象。' });
  }
  const result = store.addFavorite({ clientId, quoteId, snapshot: snapshot || null });
  if (!result.ok) {
    return sendJson(res, 409, { error: 'DUPLICATE', message: '这条箴言已在你的收藏中。' });
  }
  sendJson(res, 201, { ok: true, id: result.favorite.id, savedAt: result.favorite.savedAt });
}

function handleListFavorites(req, res, url) {
  const clientId = url.searchParams.get('clientId') || '';
  if (!isNonEmptyString(clientId, 64)) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: '缺少 clientId。' });
  }
  sendJson(res, 200, { favorites: store.listFavorites(clientId) });
}

async function handleAddRecord(req, res) {
  const body = await parseJsonBody(req);
  const { id, clientId, quoteId, emotion } = body;
  if (
    !isNonEmptyString(id, 64) ||
    !isNonEmptyString(clientId, 64) ||
    !isNonEmptyString(quoteId, 64) ||
    !content.isValidEmotion(emotion)
  ) {
    return sendJson(res, 400, {
      error: 'BAD_REQUEST',
      message: 'id / clientId / quoteId / emotion 缺失或情绪未知。',
    });
  }
  const result = store.addRecord({
    id,
    clientId,
    quoteId,
    emotion,
    contentVersion: content.activeVersion,
    clientTime: isNonEmptyString(body.createdAt, 40) ? body.createdAt : null,
  });
  if (!result.ok) {
    return sendJson(res, 409, { error: 'DUPLICATE', message: '该显影记录已写入。' });
  }
  sendJson(res, 201, { ok: true });
}

/* ---------- 静态资源 ---------- */

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

/* ---------- 路由 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: content.activeVersion });
    }
    if (url.pathname === '/api/develop' && req.method === 'GET') {
      return handleDevelop(req, res, url);
    }
    if (url.pathname === '/api/favorites' && req.method === 'POST') {
      return await handleAddFavorite(req, res);
    }
    if (url.pathname === '/api/favorites' && req.method === 'GET') {
      return handleListFavorites(req, res, url);
    }
    if (url.pathname === '/api/records' && req.method === 'POST') {
      return await handleAddRecord(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'NOT_FOUND', message: '未知接口。' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    serveStatic(req, res, url);
  } catch (err) {
    const known = ['BAD_JSON', 'BODY_TOO_LARGE'];
    const status = known.includes(err.message) ? 400 : 500;
    if (status === 500) console.error('[server]', err);
    sendJson(res, status, { error: err.message || 'INTERNAL_ERROR' });
  }
});

server.listen(PORT, () => {
  console.log(`箴言显影机  http://localhost:${PORT}  (内容版本: ${content.activeVersion})`);
});
