/**
 * 冒烟测试：直接调用模块 + 打 API。
 * 运行前先启动服务（node server/index.js），或让本脚本自行拉起。
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function api(p, opts) {
  const res = await fetch(BASE + p, opts);
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  /* ---- 单元级：日期过滤 ---- */
  console.log('\n[内容过滤]');
  const content = require('../server/content');
  check('v1 内容加载，情绪数=5', content.emotions.length === 5);
  const expired = { notAfter: '2020-01-01' };
  const future = { notBefore: '2999-01-01' };
  const ok = {};
  check('过期条目当日不可用', !content.isAvailableOn(expired, new Date('2026-09-19')));
  check('未来条目当日不可用', !content.isAvailableOn(future, new Date('2026-09-19')));
  check('普通条目当日可用', content.isAvailableOn(ok, new Date('2026-09-19')));
  const calmPick = content.pick('calm', [], new Date('2026-09-19'));
  check('calm 池过滤掉过期条目（剩 3 条）', calmPick.poolSize === 3, `实际 ${calmPick.poolSize}`);
  const emptyPick = content.pick('anxious', [], new Date('1990-01-01'));
  // 1990 年：带 notBefore 的条目不可用，但无日期条目仍在 → 只验证不崩溃
  check('历史日期查询不崩溃', emptyPick !== null);
  const excl = content.pick('calm', ['v1-calm-01', 'v1-calm-02', 'v1-calm-03'], new Date('2026-09-19'));
  check('全部排除时退回全池', excl.item !== null);

  /* ---- 启动服务 ---- */
  console.log('\n[启动服务]');
  const server = spawn('node', [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  await new Promise((r) => setTimeout(r, 800));

  try {
    /* ---- API ---- */
    console.log('\n[API]');
    const health = await api('/api/health');
    check('健康检查 200', health.status === 200);

    const dev = await api('/api/develop?emotion=calm');
    check('显影 calm 返回 200 + 条目', dev.status === 200 && !!dev.body.item);
    check('响应带内容版本', dev.headers.get('x-content-version') === 'v1');
    const item = dev.body.item;
    check('条目字段完整', ['id', 'quote', 'philosopher', 'era', 'response', 'image'].every((k) => item[k]));

    const bad = await api('/api/develop?emotion=ecstatic');
    check('未知情绪 → 400 UNKNOWN_EMOTION', bad.status === 400 && bad.body.error === 'UNKNOWN_EMOTION');

    const empty = await api('/api/develop?emotion=');
    check('空情绪 → 400', empty.status === 400);

    // exclude 生效（calm 池 3 条，排除 2 条后必得第 3 条）
    const ex = await api('/api/develop?emotion=calm&exclude=v1-calm-01,v1-calm-02');
    check('exclude 生效', ex.status === 200 && ex.body.item.id === 'v1-calm-03', ex.body.item && ex.body.item.id);

    // 收藏：重复拒绝
    const favPayload = JSON.stringify({ clientId: 'smoke-test', quoteId: item.id, snapshot: { quote: item.quote } });
    const fav1 = await api('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: favPayload });
    check('首次收藏 201', fav1.status === 201);
    const fav2 = await api('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: favPayload });
    check('重复收藏 → 409 DUPLICATE', fav2.status === 409 && fav2.body.error === 'DUPLICATE');
    const favBad = await api('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('缺字段收藏 → 400', favBad.status === 400);

    const favList = await api('/api/favorites?clientId=smoke-test');
    check('收藏列表可读', favList.status === 200 && favList.body.favorites.length >= 1);

    // 记录：幂等
    const recPayload = JSON.stringify({ id: 'smoke-rec-1', clientId: 'smoke-test', quoteId: item.id, emotion: 'calm' });
    const rec1 = await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: recPayload });
    check('首次记录 201', rec1.status === 201);
    const rec2 = await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: recPayload });
    check('重复记录 → 409 DUPLICATE', rec2.status === 409 && rec2.body.error === 'DUPLICATE');
    const recBad = await api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x', clientId: 'y', quoteId: 'z', emotion: 'nope' }) });
    check('记录含未知情绪 → 400', recBad.status === 400);

    // 静态资源
    const home = await fetch(BASE + '/');
    check('首页 200', home.status === 200);
    const img = await fetch(BASE + '/assets/moods/calm.png');
    check('情绪图片 200 且为 PNG', img.status === 200 && img.headers.get('content-type') === 'image/png');
    const traversal = await fetch(BASE + '/../package.json');
    check('路径穿越被拒绝', traversal.status === 403 || traversal.status === 404);
    const badJson = await api('/api/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    check('坏 JSON → 400', badJson.status === 400);
  } finally {
    server.kill();
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
