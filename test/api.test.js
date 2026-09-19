'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createServer } = require('../server/index');
const { pick, ContentError } = require('../server/content');

/* ---------- 测试夹具 ---------- */

function makeContent(overrides = {}) {
  return {
    version: 'v-test',
    entries: [
      {
        id: 'calm-a',
        mood: 'calm',
        quote: '静。',
        philosopher: '甲',
        year: '1900',
        response: '回应甲。',
        image: 'images/calm.svg',
        availableFrom: '2020-01-01',
      },
      {
        id: 'calm-b',
        mood: 'calm',
        quote: '再静。',
        philosopher: '乙',
        year: '1910',
        response: '回应乙。',
        image: 'images/calm.svg',
        availableFrom: '2020-01-01',
      },
      {
        id: 'calm-expired',
        mood: 'calm',
        quote: '过期的静。',
        philosopher: '丙',
        year: '1920',
        response: '回应丙。',
        image: 'images/calm.svg',
        availableFrom: '2020-01-01',
        availableTo: '2020-12-31', // 已过期：当天不可用
      },
      {
        id: 'unease-a',
        mood: 'unease',
        quote: '不安。',
        philosopher: '丁',
        year: '1930',
        response: '回应丁。',
        image: 'images/unease.svg',
        availableFrom: '2020-01-01',
      },
    ],
    ...overrides,
  };
}

let server;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aphorism-test-'));
  const app = createServer({ content: makeContent(), dataDir });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ---------- 显影 ---------- */

test('未知情绪参数被拒绝（400 UNKNOWN_MOOD）', async () => {
  const res = await fetch(`${base}/api/develop?mood=ecstatic`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'UNKNOWN_MOOD');
});

test('缺失情绪参数同样被拒绝', async () => {
  const res = await fetch(`${base}/api/develop`);
  assert.equal(res.status, 400);
});

test('正常显影返回内容、版本号与完整字段', async () => {
  const res = await fetch(`${base}/api/develop?mood=calm`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.empty, false);
  assert.equal(body.contentVersion, 'v-test');
  assert.ok(['calm-a', 'calm-b'].includes(body.entry.id), '不应返回已过期条目');
  for (const field of ['quote', 'philosopher', 'year', 'response', 'image']) {
    assert.ok(body.entry[field], `缺少字段 ${field}`);
  }
});

test('exclude 参数避免随机结果重复', async () => {
  const res = await fetch(`${base}/api/develop?mood=calm&exclude=calm-a`);
  const body = await res.json();
  assert.equal(body.entry.id, 'calm-b');
});

test('当天没有可用内容时返回 empty 标记而非报错', async () => {
  const content = makeContent({
    entries: makeContent().entries.map((e) => ({ ...e, availableTo: '2020-01-01' })),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aphorism-empty-'));
  const app = createServer({ content, dataDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/develop?mood=calm`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.empty, true);
    assert.ok(body.message);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pick 单元层：未知情绪抛出 UNKNOWN_MOOD', () => {
  assert.throws(() => pick(makeContent(), 'rage'), (err) => {
    assert.ok(err instanceof ContentError);
    assert.equal(err.code, 'UNKNOWN_MOOD');
    return true;
  });
});

/* ---------- 收藏 ---------- */

test('收藏可保存，重复写入被拒绝（409 DUPLICATE）', async () => {
  const payload = { clientId: 'client-1', contentId: 'calm-a' };
  const first = await fetch(`${base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.error.code, 'DUPLICATE');

  const list = await fetch(`${base}/api/favorites?clientId=client-1`);
  const items = (await list.json()).items;
  assert.equal(items.length, 1, '重复写入不应产生第二条记录');
  assert.equal(items[0].snapshot.contentVersion, 'v-test', '快照应携带内容版本');
});

test('收藏不存在的内容返回 404', async () => {
  const res = await fetch(`${base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'client-1', contentId: 'ghost' }),
  });
  assert.equal(res.status, 404);
});

test('收藏缺少必填字段返回 400', async () => {
  const res = await fetch(`${base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: 'client-1' }),
  });
  assert.equal(res.status, 400);
});

/* ---------- 显影记录（幂等） ---------- */

test('显影事件按 id 幂等去重，安全重试不重复写入', async () => {
  const event = { id: 'evt-1', clientId: 'client-1', mood: 'calm', contentId: 'calm-a' };
  const first = await fetch(`${base}/api/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  assert.equal(first.status, 201);
  assert.equal((await first.json()).deduped, false);

  const retry = await fetch(`${base}/api/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).deduped, true);
});

test('显影事件中的未知情绪被拒绝', async () => {
  const res = await fetch(`${base}/api/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'evt-2', clientId: 'c', mood: 'rage' }),
  });
  assert.equal(res.status, 400);
});

/* ---------- 静态资源与健壮性 ---------- */

test('首页与静态资源可访问，且拒绝路径穿越', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /箴言显影机/);

  const traversal = await fetch(`${base}/../server/index.js`);
  assert.ok([403, 404].includes(traversal.status));
});

test('非法 JSON 请求体返回 400 而不是崩溃', async () => {
  const res = await fetch(`${base}/api/favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'BAD_JSON');
});
