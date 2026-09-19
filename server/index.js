'use strict';

/**
 * 箴言显影机 · HTTP 服务
 * 零依赖（Node 原生 http），同时提供 REST API 与前端静态资源。
 *
 * API:
 *   GET  /api/health
 *   GET  /api/moods                      可用情绪列表（含内容版本）
 *   GET  /api/develop?mood=&exclude=     按情绪显影一条内容（当日可用、避免重复）
 *   POST /api/favorites                  保存收藏（重复写入返回 409）
 *   GET  /api/favorites?clientId=        读取某客户端的收藏
 *   POST /api/generations                记录显影事件（按事件 id 幂等去重）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { MOODS, ContentError, loadContent, pick, findById, DEFAULT_CONTENT_PATH } = require('./content');
const { Store, StoreError } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return sendError(res, 403, 'FORBIDDEN', 'path not allowed');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendError(res, 404, 'NOT_FOUND', 'resource not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

function createServer(options = {}) {
  const contentPath = options.contentPath || DEFAULT_CONTENT_PATH;
  const content = options.content || loadContent(contentPath);
  const store = options.store || new Store(options.dataDir || path.join(__dirname, '..', 'data'));
  const now = options.now || (() => new Date());

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/health') {
      return sendJson(res, 200, { ok: true, contentVersion: content.version });
    }

    if (route === 'GET /api/moods') {
      return sendJson(res, 200, { contentVersion: content.version, moods: MOODS });
    }

    if (route === 'GET /api/develop') {
      const mood = url.searchParams.get('mood') || '';
      const exclude = url.searchParams.get('exclude') || null;
      let entry;
      try {
        entry = pick(content, mood, { excludeId: exclude, date: now() });
      } catch (err) {
        if (err instanceof ContentError && err.code === 'UNKNOWN_MOOD') {
          return sendError(res, 400, 'UNKNOWN_MOOD', `未知情绪参数: ${mood || '(空)'}`);
        }
        throw err;
      }
      if (!entry) {
        // 当天没有可用内容：正常 200 + empty 标记，交给前端呈现温和空态。
        return sendJson(res, 200, {
          empty: true,
          mood,
          contentVersion: content.version,
          message: '今日暗房暂时没有这种情绪的底片。',
        });
      }
      return sendJson(res, 200, {
        empty: false,
        mood,
        contentVersion: content.version,
        entry,
      });
    }

    if (route === 'POST /api/favorites') {
      const body = await readBody(req);
      const { clientId, contentId } = body || {};
      if (typeof clientId !== 'string' || !clientId || typeof contentId !== 'string' || !contentId) {
        return sendError(res, 400, 'BAD_REQUEST', 'clientId 与 contentId 均为必填');
      }
      const entry = findById(content, contentId);
      if (!entry) {
        return sendError(res, 404, 'CONTENT_NOT_FOUND', `内容不存在: ${contentId}`);
      }
      try {
        const item = store.addFavorite({
          clientId,
          contentId,
          snapshot: { ...entry, contentVersion: content.version },
        });
        return sendJson(res, 201, { ok: true, favorite: item });
      } catch (err) {
        if (err instanceof StoreError && err.code === 'DUPLICATE') {
          return sendError(res, 409, 'DUPLICATE', '这次显影已在收藏中');
        }
        throw err;
      }
    }

    if (route === 'GET /api/favorites') {
      const clientId = url.searchParams.get('clientId') || '';
      if (!clientId) return sendError(res, 400, 'BAD_REQUEST', '缺少 clientId');
      return sendJson(res, 200, { items: store.listFavorites(clientId) });
    }

    if (route === 'POST /api/generations') {
      const body = await readBody(req);
      const { id, clientId, mood, contentId } = body || {};
      if (typeof id !== 'string' || !id || typeof clientId !== 'string' || !clientId) {
        return sendError(res, 400, 'BAD_REQUEST', 'id 与 clientId 均为必填');
      }
      if (!MOODS.includes(mood)) {
        return sendError(res, 400, 'UNKNOWN_MOOD', `未知情绪参数: ${mood || '(空)'}`);
      }
      const result = store.addGeneration({ id, clientId, mood, contentId: contentId || null });
      return sendJson(res, result.deduped ? 200 : 201, { ok: true, ...result });
    }

    return sendError(res, 404, 'NOT_FOUND', 'unknown endpoint');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(res, url.pathname);
      } else {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'method not allowed');
      }
    } catch (err) {
      const code = err && err.code;
      if (code === 'BAD_JSON') return sendError(res, 400, 'BAD_JSON', err.message);
      if (code === 'BODY_TOO_LARGE') return sendError(res, 413, 'BODY_TOO_LARGE', err.message);
      // 兜底：不让任何异常打垮进程。
      console.error('[server] unexpected error:', err);
      if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务器开小差了');
      else res.end();
    }
  });

  return { server, store, content };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  const { server, content } = createServer();
  server.listen(port, () => {
    console.log(`箴言显影机已开灯 → http://localhost:${port}  (内容版本 ${content.version})`);
  });
}

module.exports = { createServer };
