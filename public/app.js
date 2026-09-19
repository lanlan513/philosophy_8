'use strict';

/**
 * 箴言显影机 · 前端
 * - 黄铜滑块选择情绪（拖动 / 点击 / 键盘），防抖后请求显影
 * - Canvas 颗粒 + 分阶段显影动画；Canvas 不可用或用户偏好减少动态时优雅退回
 * - 收藏支持离线排队；思想卡片生成带超时保护
 */

/* ---------- 常量与工具 ---------- */

const MOODS = [
  { key: 'unease', label: '不安' },
  { key: 'lucidity', label: '清醒' },
  { key: 'solitude', label: '孤独' },
  { key: 'courage', label: '勇气' },
  { key: 'calm', label: '平静' },
];

const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const DEVELOP_DEBOUNCE_MS = 380; // 拖动过快时，等手停下来再显影
const DEVELOP_MIN_INTERVAL_MS = 700; // 两次显影请求的最小间隔
const CARD_TIMEOUT_MS = 6000; // 卡片生成超时
const SAVE_TIMEOUT_MS = 8000; // 收藏请求超时
const PENDING_KEY = 'aphorism.pendingFavorites';
const CLIENT_KEY = 'aphorism.clientId';

const $ = (id) => document.getElementById(id);

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getClientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch (_) {
    // 隐私模式等场景下 localStorage 不可用，退化为会话级 id
    return `session-${uuid()}`;
  }
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/* ---------- 全局状态 ---------- */

const state = {
  moodIndex: 2,
  current: null, // 当前显影结果 { entry, contentVersion, mood }
  lastEntryId: null,
  developing: false,
  developTimer: null,
  lastRequestAt: 0,
  abortController: null,
  savedCurrent: false,
};

const clientId = getClientId();

/* ---------- Toast ---------- */

const toastEl = $('toast');
let toastTimer = null;
function toast(message, { error = false, duration = 3200 } = {}) {
  toastEl.textContent = message;
  toastEl.classList.toggle('is-error', error);
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), duration);
}

/* ---------- 黄铜滑块 ---------- */

const slider = $('slider');
const thumb = $('sliderThumb');
const fill = $('sliderFill');
const notchesEl = $('sliderNotches');
const labelsEl = $('sliderLabels');

MOODS.forEach((mood, i) => {
  const notch = document.createElement('i');
  notchesEl.appendChild(notch);

  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = mood.label;
  btn.dataset.index = String(i);
  btn.setAttribute('aria-label', `选择情绪：${mood.label}`);
  btn.addEventListener('click', () => setMoodIndex(i, { develop: true }));
  li.appendChild(btn);
  labelsEl.appendChild(li);
});

function renderSlider() {
  const pct = (state.moodIndex / (MOODS.length - 1)) * 100;
  thumb.style.left = `${pct}%`;
  fill.style.width = `calc(${pct}% - 3px)`;
  slider.setAttribute('aria-valuenow', String(state.moodIndex));
  slider.setAttribute('aria-valuetext', MOODS[state.moodIndex].label);
  labelsEl.querySelectorAll('button').forEach((btn, i) => {
    btn.classList.toggle('is-active', i === state.moodIndex);
  });
}

function indexFromPointer(clientX) {
  const rect = slider.querySelector('.slider-rail').getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(ratio * (MOODS.length - 1));
}

function setMoodIndex(index, { develop }) {
  const clamped = Math.min(MOODS.length - 1, Math.max(0, index));
  if (clamped === state.moodIndex) return;
  state.moodIndex = clamped;
  renderSlider();
  if (develop) scheduleDevelop();
}

let dragging = false;
const rail = slider.querySelector('.slider-rail');

rail.addEventListener('pointerdown', (e) => {
  dragging = true;
  slider.classList.add('is-dragging');
  rail.setPointerCapture(e.pointerId);
  setMoodIndex(indexFromPointer(e.clientX), { develop: true });
});
rail.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  setMoodIndex(indexFromPointer(e.clientX), { develop: true });
});
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  slider.classList.remove('is-dragging');
  if (e.pointerId !== undefined && rail.hasPointerCapture(e.pointerId)) {
    rail.releasePointerCapture(e.pointerId);
  }
  scheduleDevelop(); // 松手时确保最终落点被显影
}
rail.addEventListener('pointerup', endDrag);
rail.addEventListener('pointercancel', endDrag);

slider.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault();
    setMoodIndex(state.moodIndex - 1, { develop: true });
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault();
    setMoodIndex(state.moodIndex + 1, { develop: true });
  } else if (e.key === 'Home') {
    e.preventDefault();
    setMoodIndex(0, { develop: true });
  } else if (e.key === 'End') {
    e.preventDefault();
    setMoodIndex(MOODS.length - 1, { develop: true });
  }
});

/* ---------- 颗粒 Canvas（含退回方案） ---------- */

const grainCanvas = $('grainCanvas');
let grainCtx = null;
let grainTimer = null;

function setupGrain() {
  try {
    grainCtx = grainCanvas.getContext('2d');
    if (!grainCtx) throw new Error('no 2d context');
  } catch (_) {
    grainCtx = null;
    $('stage').classList.add('no-canvas'); // 退回纯 CSS 颗粒
  }
}

function paintGrainFrame() {
  if (!grainCtx) return;
  const plate = $('plate');
  const w = plate.clientWidth;
  const h = plate.clientHeight;
  if (!w || !h) return;
  if (grainCanvas.width !== w || grainCanvas.height !== h) {
    grainCanvas.width = w;
    grainCanvas.height = h;
  }
  const image = grainCtx.createImageData(w, h);
  const buf = new Uint32Array(image.data.buffer);
  for (let i = 0; i < buf.length; i++) {
    const v = (Math.random() * 255) | 0;
    // 低透明度单色噪点，模拟胶片颗粒
    buf[i] = (28 << 24) | (v << 16) | (v << 8) | v;
  }
  grainCtx.putImageData(image, 0, 0);
}

function startGrain() {
  paintGrainFrame();
  if (REDUCED_MOTION || !grainCtx) return; // 减少动态：只画一帧静态颗粒
  stopGrain();
  grainTimer = setInterval(paintGrainFrame, 140);
}
function stopGrain() {
  if (grainTimer) {
    clearInterval(grainTimer);
    grainTimer = null;
  }
}

/* ---------- 显影流程 ---------- */

const stage = $('stage');
const plateImg = $('plateImg');
const plateFallback = $('plateFallback');
const idleHint = $('idleHint');

plateImg.addEventListener('error', () => {
  // 图片资源损坏：隐藏 <img>，用渐变底 + 提示代替，不阻断文字显影
  plateImg.classList.add('is-broken');
  plateFallback.hidden = false;
});

function scheduleDevelop() {
  clearTimeout(state.developTimer);
  state.developTimer = setTimeout(requestDevelop, DEVELOP_DEBOUNCE_MS);
}

async function requestDevelop() {
  const now = Date.now();
  if (state.developing) return; // 上一次显影未完成，忽略
  if (now - state.lastRequestAt < DEVELOP_MIN_INTERVAL_MS) {
    // 拖动过快：稍后再试一次，而不是立即打满请求
    clearTimeout(state.developTimer);
    state.developTimer = setTimeout(requestDevelop, DEVELOP_MIN_INTERVAL_MS - (now - state.lastRequestAt));
    return;
  }
  state.lastRequestAt = now;

  if (state.abortController) state.abortController.abort();
  const controller = new AbortController();
  state.abortController = controller;
  state.developing = true;
  setActionsEnabled(false);

  const mood = MOODS[state.moodIndex].key;
  const params = new URLSearchParams({ mood });
  if (state.lastEntryId) params.set('exclude', state.lastEntryId);

  try {
    const res = await fetch(`/api/develop?${params}`, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || `显影失败（${res.status}）`);
    }
    const data = await res.json();
    if (controller.signal.aborted) return;

    $('versionTag').textContent = `内容版本 · ${data.contentVersion}`;

    if (data.empty) {
      renderEmpty();
    } else {
      state.current = data;
      state.lastEntryId = data.entry.id;
      state.savedCurrent = false;
      renderDevelop(data);
      recordGeneration(data).catch(() => {}); // 记录失败不影响体验
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (!navigator.onLine) {
      toast('网络似乎断开了，显影结果会在连接恢复后再试。', { error: true });
    } else {
      toast(err.message || '显影失败，请稍后再试。', { error: true });
    }
  } finally {
    if (state.abortController === controller) {
      state.developing = false;
      setActionsEnabled(Boolean(state.current));
    }
  }
}

function renderEmpty() {
  state.current = null;
  stage.classList.remove('is-idle', 'is-developing');
  idleHint.hidden = true;
  $('stageEmpty').hidden = false;
  ['quote', 'meta', 'response'].forEach((id) => ($(id).style.visibility = 'hidden'));
  $('plate').style.visibility = 'hidden';
  setActionsEnabled(false);
}

function renderDevelop(data) {
  const { entry } = data;
  $('stageEmpty').hidden = true;
  idleHint.hidden = true;
  ['quote', 'meta', 'response', 'plate'].forEach((id) => ($(id).style.visibility = ''));

  // 重置图片状态（上一次可能损坏过）
  plateImg.classList.remove('is-broken');
  plateFallback.hidden = true;
  plateImg.src = entry.image;
  plateImg.alt = `${MOODS[state.moodIndex].label} · 暗房底片`;
  $('plateCaption').textContent = `PLATE · ${entry.id.toUpperCase()}`;

  $('quote').textContent = entry.quote;
  $('philosopher').textContent = entry.philosopher;
  $('year').textContent = entry.year;
  $('response').textContent = entry.response;

  // 重新触发分阶段显影动画
  stage.classList.remove('is-idle', 'is-developing');
  void stage.offsetWidth; // 强制回流以重启动画
  if (!REDUCED_MOTION) stage.classList.add('is-developing');
  startGrain();
}

async function recordGeneration(data) {
  await fetch('/api/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: uuid(),
      clientId,
      mood: data.mood,
      contentId: data.entry.id,
    }),
  });
}

/* ---------- 收藏（含离线排队与重复处理） ---------- */

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch (_) {
    return [];
  }
}
function writePending(list) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch (_) {
    /* 存储不可用时静默失败，UI 已给出提示 */
  }
}

async function postFavorite(contentId) {
  const res = await withTimeout(
    fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, contentId }),
    }),
    SAVE_TIMEOUT_MS,
    '保存请求超时'
  );
  if (res.status === 409) return { duplicate: true };
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `保存失败（${res.status}）`);
  }
  return { duplicate: false };
}

async function saveCurrent() {
  if (!state.current || state.savedCurrent) return;
  const contentId = state.current.entry.id;
  const btn = $('btnSave');
  btn.disabled = true;

  if (!navigator.onLine) {
    // 断网：进入本地待同步队列，联网后自动补写
    const pending = readPending();
    if (!pending.includes(contentId)) {
      pending.push(contentId);
      writePending(pending);
    }
    state.savedCurrent = true;
    toast('当前离线，这次显影已存入待同步队列。');
    return;
  }

  try {
    const { duplicate } = await postFavorite(contentId);
    state.savedCurrent = true;
    toast(duplicate ? '这次显影已在收藏中。' : '已收藏这次显影。');
  } catch (err) {
    // 网络中途断开等：同样转入离线队列
    const pending = readPending();
    if (!pending.includes(contentId)) {
      pending.push(contentId);
      writePending(pending);
      state.savedCurrent = true;
      toast('网络不稳定，已转为离线保存，联网后自动同步。');
    } else {
      toast(err.message || '保存失败，请稍后再试。', { error: true });
    }
  } finally {
    btn.disabled = !state.current || state.savedCurrent;
  }
}

async function flushPending() {
  const pending = readPending();
  if (pending.length === 0 || !navigator.onLine) return;
  const remaining = [];
  let synced = 0;
  for (const contentId of pending) {
    try {
      await postFavorite(contentId);
      synced++;
    } catch (_) {
      remaining.push(contentId);
    }
  }
  writePending(remaining);
  if (synced > 0) toast(`已同步 ${synced} 条离线收藏。`);
}

window.addEventListener('online', flushPending);

/* ---------- 思想卡片（Canvas 竖版，带超时退回） ---------- */

function wrapLines(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(text);
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) break;
    } else {
      line = next;
    }
  }
  const consumed = lines.join('').length + line.length;
  if (consumed < chars.length) {
    // 超长截断并加省略号，避免卡片文字溢出
    while (ctx.measureText(line + '…').width > maxWidth && line.length > 0) {
      line = line.slice(0, -1);
    }
    line += '…';
  }
  lines.push(line);
  return lines;
}

function drawCard(data) {
  return new Promise((resolve, reject) => {
    const W = 640;
    const H = 1008;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('当前浏览器不支持卡片绘制'));

    const { entry, contentVersion } = data;
    const moodLabel = MOODS[state.moodIndex].label;

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#241a0e');
    bg.addColorStop(0.55, '#171008');
    bg.addColorStop(1, '#0e0906');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 颗粒
    ctx.fillStyle = 'rgba(232, 201, 138, 0.05)';
    for (let i = 0; i < 2600; i++) {
      ctx.fillRect(Math.random() * W, Math.random() * H, 1.2, 1.2);
    }

    // 边框
    ctx.strokeStyle = 'rgba(200, 163, 95, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(28, 28, W - 56, H - 56);

    // 刊头
    ctx.fillStyle = '#c8a35f';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('箴 言 显 影 机', W / 2, 92);
    ctx.fillStyle = 'rgba(233, 220, 195, 0.5)';
    ctx.font = '13px sans-serif';
    ctx.fillText(`THE APHORISM DARKROOM · ${moodLabel}`, W / 2, 120);

    // 引文
    ctx.fillStyle = '#e9dcc3';
    ctx.font = '34px "Songti SC", "Noto Serif CJK SC", serif';
    const lines = wrapLines(ctx, `「${entry.quote}」`, W - 160, 8);
    let y = 320 - (lines.length - 1) * 28;
    for (const line of lines) {
      ctx.fillText(line, W / 2, y);
      y += 56;
    }

    // 人物与年代
    ctx.fillStyle = '#c8a35f';
    ctx.font = '26px "Songti SC", "Noto Serif CJK SC", serif';
    ctx.fillText(entry.philosopher, W / 2, y + 60);
    ctx.fillStyle = 'rgba(233, 220, 195, 0.6)';
    ctx.font = '18px sans-serif';
    ctx.fillText(entry.year, W / 2, y + 98);

    // 回应
    ctx.fillStyle = 'rgba(184, 169, 140, 0.9)';
    ctx.font = '20px "Songti SC", "Noto Serif CJK SC", serif';
    const respLines = wrapLines(ctx, entry.response, W - 200, 3);
    let ry = H - 220;
    for (const line of respLines) {
      ctx.fillText(line, W / 2, ry);
      ry += 34;
    }

    // 页脚
    ctx.fillStyle = 'rgba(233, 220, 195, 0.4)';
    ctx.font = '13px sans-serif';
    const date = new Date().toISOString().slice(0, 10);
    ctx.fillText(`${date} · 内容版本 ${contentVersion}`, W / 2, H - 56);

    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('卡片导出失败'));
    }, 'image/png');
  });
}

function downloadTextFallback(data) {
  const { entry } = data;
  const text = [
    '箴言显影机 · 思想卡片',
    '',
    `「${entry.quote}」`,
    `—— ${entry.philosopher}，${entry.year}`,
    '',
    entry.response,
    '',
    `内容版本 ${data.contentVersion}`,
  ].join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  triggerDownload(blob, 'aphorism-card.txt');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function generateCard() {
  if (!state.current) return;
  const btn = $('btnCard');
  btn.disabled = true;
  toast('正在暗房里冲洗卡片…');
  try {
    const blob = await withTimeout(drawCard(state.current), CARD_TIMEOUT_MS, '卡片生成超时');
    triggerDownload(blob, `aphorism-${state.current.entry.id}.png`);
    toast('思想卡片已保存。');
  } catch (err) {
    // 超时或 Canvas 不可用：退回纯文本卡片
    downloadTextFallback(state.current);
    toast(`${err.message || '卡片生成失败'}，已改为保存文字版。`, { error: true });
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 装配 ---------- */

function setActionsEnabled(enabled) {
  $('btnSave').disabled = !enabled || state.savedCurrent;
  $('btnCard').disabled = !enabled;
  $('btnAgain').disabled = !enabled && !state.current;
}

$('btnSave').addEventListener('click', saveCurrent);
$('btnCard').addEventListener('click', generateCard);
$('btnAgain').addEventListener('click', () => {
  if (state.developing) return;
  requestDevelop();
});

renderSlider();
setupGrain();
if (REDUCED_MOTION) stage.classList.add('no-motion');
flushPending(); // 启动时尝试同步离线队列
