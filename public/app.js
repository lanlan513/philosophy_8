/**
 * 箴言显影机 · 前端主逻辑
 */
(function () {
  'use strict';

  /* ---------- 常量与状态 ---------- */
  const EMOTIONS = [
    { key: 'anxious', label: '不安' },
    { key: 'lucid',   label: '清醒' },
    { key: 'lonely',  label: '孤独' },
    { key: 'brave',   label: '勇气' },
    { key: 'calm',    label: '平静' },
  ];
  const SETTLE_MS = 380;        // 拖动停稳多久后才请求
  const REDUCED = window.Grain ? window.Grain.reduced : false;

  const $ = function (id) { return document.getElementById(id); };
  const stage = $('stage');
  const stageImg = $('stageImg');
  const slider = $('slider');
  const knob = $('knob');
  const stopsBox = $('sliderStops');
  const labelsBox = $('sliderLabels');
  const paperEmpty = $('paperEmpty');
  const quoteEl = $('quote');
  const attribEl = $('attrib');
  const philosopherEl = $('philosopher');
  const eraEl = $('era');
  const responseEl = $('response');
  const developingHint = $('developingHint');
  const actionsEl = $('actions');
  const toastEl = $('toast');

  const state = {
    index: 2,              // 当前滑块位置（默认：孤独）
    currentItem: null,     // 当前显影结果
    lastByEmotion: {},     // 每种情绪上一次的条目 id（避免连续重复）
    developing: false,
    abort: null,           // 进行中的 fetch
    settleTimer: 0,
    toastTimer: 0,
  };

  const clientId = getClientId();

  function getClientId() {
    try {
      let id = localStorage.getItem('darkroom.clientId');
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) ||
          'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('darkroom.clientId', id);
      }
      return id;
    } catch (e) {
      return 'c-anonymous';
    }
  }

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  /* ---------- 提示 ---------- */
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2600);
  }

  /* ---------- 滑块 ---------- */
  function buildSlider() {
    EMOTIONS.forEach(function (emo, i) {
      const stop = document.createElement('div');
      stop.className = 'stop';
      stop.style.left = posFor(i) + '%';
      stop.dataset.index = i;
      stopsBox.appendChild(stop);

      const label = document.createElement('span');
      label.textContent = emo.label;
      label.addEventListener('click', function () { commitIndex(i, true); });
      labelsBox.appendChild(label);
    });
    moveKnob(state.index, false);
    markActive();
  }

  function posFor(i) {
    // 两端各留 6% 边距，避免滑块贴边
    return 6 + (i / (EMOTIONS.length - 1)) * 88;
  }

  function moveKnob(i, animate) {
    if (!animate) knob.classList.add('dragging');
    knob.style.left = posFor(i) + '%';
    if (!animate) {
      // 强制 reflow 后恢复过渡
      void knob.offsetWidth;
      knob.classList.remove('dragging');
    }
  }

  function markActive() {
    const stops = stopsBox.children;
    const labels = labelsBox.children;
    for (let i = 0; i < EMOTIONS.length; i++) {
      stops[i].classList.toggle('active', i === state.index);
      labels[i].classList.toggle('active', i === state.index);
    }
    slider.setAttribute('aria-valuenow', String(state.index));
    slider.setAttribute('aria-valuetext', EMOTIONS[state.index].label);
  }

  function indexFromClientX(clientX) {
    const rect = slider.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const raw = (t * 100 - 6) / 88;
    return Math.min(EMOTIONS.length - 1, Math.max(0, Math.round(raw * (EMOTIONS.length - 1))));
  }

  /** 落定到某一刻度；fromUser 时延迟触发显影（拖动过快只取最后一次） */
  function commitIndex(i, immediate) {
    if (i !== state.index) {
      state.index = i;
      moveKnob(i, true);
      markActive();
    }
    clearTimeout(state.settleTimer);
    if (immediate) {
      state.settleTimer = setTimeout(function () { develop(EMOTIONS[state.index].key); }, SETTLE_MS);
    }
  }

  function bindSlider() {
    let dragging = false;

    knob.addEventListener('pointerdown', function (e) {
      dragging = true;
      knob.classList.add('dragging');
      knob.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    knob.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const rect = slider.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      knob.style.left = (t * 100) + '%';
      const i = indexFromClientX(e.clientX);
      if (i !== state.index) {
        state.index = i;
        markActive();
      }
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove('dragging');
      moveKnob(state.index, true);
      // 松手后稍等再显影，连拖只触发一次
      clearTimeout(state.settleTimer);
      state.settleTimer = setTimeout(function () {
        develop(EMOTIONS[state.index].key);
      }, SETTLE_MS);
    }
    knob.addEventListener('pointerup', endDrag);
    knob.addEventListener('pointercancel', endDrag);

    // 点击轨道直接跳转
    slider.addEventListener('pointerdown', function (e) {
      if (e.target === knob || knob.contains(e.target)) return;
      commitIndex(indexFromClientX(e.clientX), true);
    });

    // 键盘可达性
    slider.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        commitIndex(Math.max(0, state.index - 1), true);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        commitIndex(Math.min(EMOTIONS.length - 1, state.index + 1), true);
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === ' ') {
        develop(EMOTIONS[state.index].key, { reshuffle: true });
        e.preventDefault();
      }
    });
  }

  /* ---------- 显影流程 ---------- */
  function setStageEmotion(key) {
    stage.dataset.emotion = key;
  }

  function resetPaper() {
    quoteEl.hidden = true;
    quoteEl.innerHTML = '';
    attribEl.hidden = true;
    attribEl.classList.remove('arrived');
    responseEl.hidden = true;
    responseEl.classList.remove('arrived');
    paperEmpty.hidden = true;
  }

  function showEmptyMessage(text) {
    resetPaper();
    paperEmpty.innerHTML = '';
    paperEmpty.textContent = text;
    paperEmpty.hidden = false;
    actionsEl.hidden = true;
  }

  /** 逐字浮现引文 */
  function revealQuote(text, done) {
    quoteEl.hidden = false;
    quoteEl.innerHTML = '';
    if (REDUCED) {
      quoteEl.textContent = text;
      if (done) done();
      return;
    }
    const frag = document.createDocumentFragment();
    const chars = [];
    for (const ch of text) {
      const span = document.createElement('span');
      span.className = 'ch';
      span.textContent = ch;
      frag.appendChild(span);
      chars.push(span);
    }
    quoteEl.appendChild(frag);
    const step = Math.min(70, Math.max(24, 1800 / chars.length));
    chars.forEach(function (span, i) {
      span.style.animationDelay = (i * step) + 'ms';
    });
    const total = chars.length * step + 900;
    setTimeout(function () { if (done) done(); }, REDUCED ? 0 : total);
  }

  function arriveLater(el, delay) {
    el.hidden = false;
    if (REDUCED) {
      el.classList.add('arrived');
      return;
    }
    setTimeout(function () { el.classList.add('arrived'); }, delay);
  }

  /** 主显影：文字先到，人物与年代随后，图像最后 */
  function develop(emotionKey, opts) {
    opts = opts || {};
    if (state.developing) {
      // 正在显影时的新请求：取消旧请求，以最新情绪为准
      if (state.abort) state.abort.abort();
    }
    state.developing = true;
    setStageEmotion(emotionKey);
    stage.classList.remove('developed', 'img-broken');
    developingHint.hidden = false;
    resetPaper();
    actionsEl.hidden = true;

    const exclude = [];
    const lastId = state.lastByEmotion[emotionKey];
    if (lastId) exclude.push(lastId);
    if (opts.reshuffle && state.currentItem) exclude.push(state.currentItem.id);

    const controller = new AbortController();
    state.abort = controller;
    const url = '/api/develop?emotion=' + encodeURIComponent(emotionKey) +
      (exclude.length ? '&exclude=' + exclude.join(',') : '');

    fetch(url, { signal: controller.signal })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.status === 404 && r.body.error === 'NO_CONTENT_TODAY') {
          showEmptyMessage('今日「' + labelOf(emotionKey) + '」的底片尚未送到暗房。换一种情绪，或改日再来。');
          return;
        }
        if (r.status !== 200 || !r.body.item) {
          showEmptyMessage('暗房灯忽明忽暗，这次显影失败了。请再试一次。');
          return;
        }
        const item = r.body.item;
        item.emotion = emotionKey;
        state.currentItem = item;
        state.lastByEmotion[emotionKey] = item.id;
        runDevelopSequence(item, r.body.poolSize);
        postRecord(item, emotionKey);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return; // 被更新的请求取代，静默
        showEmptyMessage('显影液似乎没有反应——网络中断了。检查连接后再摇动滑块。');
      })
      .finally(function () {
        if (state.abort === controller) {
          state.developing = false;
          developingHint.hidden = true;
          state.abort = null;
        }
      });
  }

  function runDevelopSequence(item, poolSize) {
    // 图像：先加载，再显影
    stageImg.alt = item.alt || '';
    stageImg.onerror = function () {
      stage.classList.add('img-broken'); // 图片损坏 → 退回纯渐变
    };
    stageImg.src = item.image;

    revealQuote(item.quote, function () {
      philosopherEl.textContent = item.philosopher;
      eraEl.textContent = item.era;
      arriveLater(attribEl, REDUCED ? 0 : 350);
      responseEl.textContent = item.response;
      arriveLater(responseEl, REDUCED ? 0 : 900);
      stage.classList.add('developed');
      actionsEl.hidden = false;
      if (poolSize === 1) {
        toast('今日此情绪只有这一条箴言，显影多少次都是它。', 3200);
      }
    });
  }

  function labelOf(key) {
    const emo = EMOTIONS.find(function (e) { return e.key === key; });
    return emo ? emo.label : key;
  }

  /* ---------- 显影记录（幂等，失败静默） ---------- */
  function postRecord(item, emotionKey) {
    fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uuid(),
        clientId: clientId,
        quoteId: item.id,
        emotion: emotionKey,
        createdAt: new Date().toISOString(),
      }),
    }).catch(function () { /* 记录失败不影响体验 */ });
  }

  /* ---------- 收藏（断网暂存 + 恢复同步） ---------- */
  const PENDING_KEY = 'darkroom.pendingFavorites';

  function loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; }
    catch (e) { return []; }
  }
  function savePending(list) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (e) { /* 存储满则放弃 */ }
  }

  function saveFavorite() {
    const item = state.currentItem;
    if (!item) return;
    const payload = {
      clientId: clientId,
      quoteId: item.id,
      snapshot: {
        quote: item.quote,
        philosopher: item.philosopher,
        era: item.era,
        response: item.response,
        emotion: item.emotion,
      },
    };
    fetch('/api/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json().then(function (b) { return { status: res.status, body: b }; }); })
      .then(function (r) {
        if (r.status === 201) toast('已收藏。');
        else if (r.status === 409) toast('这条箴言已在收藏夹里。');
        else toast('收藏失败：' + (r.body.message || '未知错误'));
      })
      .catch(function () {
        // 断网：暂存本地，恢复后自动同步
        const list = loadPending();
        if (!list.some(function (p) { return p.quoteId === payload.quoteId; })) {
          list.push(payload);
          savePending(list);
        }
        toast('网络不佳，已暂存本地，联网后自动同步。', 3200);
      });
  }

  function flushPending() {
    const list = loadPending();
    if (!list.length) return;
    const rest = [];
    let chain = Promise.resolve();
    list.forEach(function (p) {
      chain = chain.then(function () {
        return fetch('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p),
        }).then(function (res) {
          if (res.status >= 500) rest.push(p); // 服务器故障才重试，409 视为已同步
        }).catch(function () { rest.push(p); });
      });
    });
    chain.then(function () {
      savePending(rest);
      if (rest.length < list.length) toast('离线暂存的收藏已同步。');
    });
  }

  /* ---------- 收藏夹抽屉 ---------- */
  function toggleDrawer(force) {
    const drawer = $('drawer');
    const btn = $('btnFavs');
    const show = force !== undefined ? force : drawer.hidden;
    drawer.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    if (show) loadFavorites();
  }

  function loadFavorites() {
    const listEl = $('favList');
    const emptyEl = $('favEmpty');
    listEl.innerHTML = '';
    fetch('/api/favorites?clientId=' + encodeURIComponent(clientId))
      .then(function (res) { return res.json(); })
      .then(function (body) {
        const favs = body.favorites || [];
        emptyEl.hidden = favs.length > 0;
        favs.slice().reverse().forEach(function (f) {
          const li = document.createElement('li');
          const snap = f.snapshot || {};
          const who = document.createElement('span');
          who.className = 'fav-who';
          who.textContent = snap.philosopher || f.quoteId;
          const text = document.createElement('span');
          text.textContent = snap.quote || '';
          li.appendChild(who);
          li.appendChild(text);
          listEl.appendChild(li);
        });
      })
      .catch(function () {
        emptyEl.hidden = false;
        emptyEl.textContent = '收藏夹暂时打不开——网络似乎不在场。';
      });
  }

  /* ---------- 思想卡片 ---------- */
  function saveCard() {
    const item = state.currentItem;
    if (!item) return;
    const btn = $('btnCard');
    btn.disabled = true;
    btn.textContent = '生成中…';
    window.CardMaker.generate(item)
      .then(function (blob) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = '箴言显影-' + item.emotion + '-' + Date.now() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        toast('卡片已显影完成，开始下载。');
      })
      .catch(function (err) {
        if (err && err.message === 'CARD_TIMEOUT') {
          toast('生成超时了——暗房今天有点慢，请再试一次。', 3200);
        } else if (err && err.message === 'NO_CANVAS') {
          toast('此浏览器不支持画布，无法生成卡片。');
        } else {
          toast('卡片生成失败，请再试一次。');
        }
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = '存为思想卡片';
      });
  }

  /* ---------- 启动 ---------- */
  function init() {
    buildSlider();
    bindSlider();

    if (window.Grain && window.Grain.supported) {
      window.Grain.start($('grainCanvas'));
    }

    $('btnReshuffle').addEventListener('click', function () {
      develop(EMOTIONS[state.index].key, { reshuffle: true });
    });
    $('btnSave').addEventListener('click', saveFavorite);
    $('btnCard').addEventListener('click', saveCard);
    $('btnFavs').addEventListener('click', function () { toggleDrawer(); });
    $('btnCloseDrawer').addEventListener('click', function () { toggleDrawer(false); });

    window.addEventListener('online', flushPending);
    flushPending(); // 启动时先尝试同步一次
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
