/**
 * 胶片颗粒层：Canvas 2D 低频噪声。
 * - Canvas 不可用 → document.body 加 .no-canvas，CSS 退回纯渐变。
 * - prefers-reduced-motion → 只画一帧静态颗粒。
 */
(function () {
  'use strict';

  window.Grain = (function () {
    const reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function detectCanvas() {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext && c.getContext('2d'));
      } catch (e) {
        return false;
      }
    }

    const supported = detectCanvas();
    if (!supported) {
      document.body.classList.add('no-canvas');
    }

    /**
     * 在指定 canvas 上启动颗粒。返回 { stop() }。
     */
    function start(canvas) {
      if (!supported || !canvas) return { stop: function () {} };
      const ctx = canvas.getContext('2d');
      if (!ctx) return { stop: function () {} };

      let raf = 0;
      let running = true;
      const SCALE = 3; // 低分辨率噪声再放大，性能更好、颗粒更粗

      // 预生成几张噪声帧循环使用，避免每帧分配
      const FRAMES = 6;
      const noiseFrames = [];

      function buildFrames(w, h) {
        noiseFrames.length = 0;
        const nw = Math.max(2, Math.floor(w / SCALE));
        const nh = Math.max(2, Math.floor(h / SCALE));
        for (let f = 0; f < FRAMES; f++) {
          const off = document.createElement('canvas');
          off.width = nw; off.height = nh;
          const octx = off.getContext('2d');
          const img = octx.createImageData(nw, nh);
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            const v = (Math.random() * 255) | 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 46; // 颗粒透明度
          }
          octx.putImageData(img, 0, 0);
          noiseFrames.push(off);
        }
      }

      function resize() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(2, Math.floor(rect.width * dpr));
        canvas.height = Math.max(2, Math.floor(rect.height * dpr));
        buildFrames(canvas.width, canvas.height);
      }

      let frame = 0;
      let last = 0;
      function draw(ts) {
        if (!running) return;
        if (ts - last > 90) { // ~11fps，暗房不需要流畅
          last = ts;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(noiseFrames[frame], 0, 0, canvas.width, canvas.height);
          frame = (frame + 1) % noiseFrames.length;
        }
        if (!reduced) raf = requestAnimationFrame(draw);
      }

      try {
        resize();
      } catch (e) {
        document.body.classList.add('no-canvas');
        return { stop: function () {} };
      }

      if (reduced) {
        draw(100); // 静态一帧
      } else {
        raf = requestAnimationFrame(draw);
      }

      let resizeTimer = 0;
      function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          if (!running) return;
          try { resize(); } catch (e) { /* 忽略尺寸异常 */ }
        }, 200);
      }
      window.addEventListener('resize', onResize);

      return {
        stop: function () {
          running = false;
          cancelAnimationFrame(raf);
          clearTimeout(resizeTimer);
          window.removeEventListener('resize', onResize);
        },
      };
    }

    return { supported: supported, reduced: reduced, start: start };
  })();
})();
