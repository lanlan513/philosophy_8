/**
 * 思想卡片生成器：竖版 900×1350 Canvas → PNG。
 * - 图片加载失败 → 退回情绪渐变背景；
 * - 整体 8 秒超时 → reject('CARD_TIMEOUT')；
 * - 长文本自动换行 + 逐级缩字号，防止溢出。
 */
(function () {
  'use strict';

  window.CardMaker = (function () {
    const W = 900;
    const H = 1350;
    const TIMEOUT_MS = 8000;

    const PALETTES = {
      anxious: ['#262a42', '#161221', '#8a7fb0'],
      lucid:   ['#3a5460', '#101a22', '#9fc0c8'],
      lonely:  ['#22284e', '#0a0c1a', '#7f88c0'],
      brave:   ['#6e3a28', '#221410', '#d8a05f'],
      calm:    ['#54685c', '#1e2824', '#b8cbb8'],
      default: ['#3a3226', '#141008', '#c9b48a'],
    };

    function withTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        const t = setTimeout(function () { reject(new Error('CARD_TIMEOUT')); }, ms);
        promise.then(
          function (v) { clearTimeout(t); resolve(v); },
          function (e) { clearTimeout(t); reject(e); }
        );
      });
    }

    function loadImage(src) {
      return new Promise(function (resolve) {
        if (!src) return resolve(null);
        const img = new Image();
        let done = false;
        const finish = function (val) {
          if (!done) { done = true; resolve(val); }
        };
        img.onload = function () { finish(img); };
        img.onerror = function () { finish(null); }; // 损坏 → null，走渐变
        const timer = setTimeout(function () { finish(null); }, 5000);
        img.src = src;
        // decode() 可用时优先，但仍受 onerror/超时兜底
        if (img.decode) {
          img.decode().then(function () {
            clearTimeout(timer);
            finish(img);
          }).catch(function () { /* 交给 onerror/超时 */ });
        }
      });
    }

    /** 逐字测量换行（中文按字断），返回行数组 */
    function wrapText(ctx, text, maxWidth) {
      const lines = [];
      let line = '';
      for (const ch of String(text)) {
        if (ch === '\n') { lines.push(line); line = ''; continue; }
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
      return lines;
    }

    function drawGrain(ctx, amount) {
      const g = Math.max(2, Math.floor(W / 160));
      ctx.save();
      for (let i = 0; i < amount; i++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        const a = Math.random() * 0.08;
        ctx.fillStyle = Math.random() > 0.5
          ? 'rgba(255,240,210,' + a + ')'
          : 'rgba(0,0,0,' + a + ')';
        ctx.fillRect(x, y, g, g);
      }
      ctx.restore();
    }

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    /**
     * 生成卡片。
     * @param {{quote:string, philosopher:string, era:string, response:string,
     *          image:string, emotion:string}} item
     * @returns {Promise<Blob>} PNG blob
     */
    function generate(item) {
      const job = (async function () {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('NO_CANVAS');

        const pal = PALETTES[item.emotion] || PALETTES.default;

        // 背景：渐变打底
        const bg = ctx.createLinearGradient(0, 0, W * 0.3, H);
        bg.addColorStop(0, pal[0]);
        bg.addColorStop(1, pal[1]);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);

        // 图像（可缺失）
        const img = await loadImage(item.image);
        if (img) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          // cover 裁切
          const ir = img.width / img.height;
          const cr = W / H;
          let dw = W, dh = H;
          if (ir > cr) { dw = H * ir; } else { dh = W / ir; }
          ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
          ctx.restore();
          // 压暗保证文字可读
          const shade = ctx.createLinearGradient(0, H * 0.25, 0, H);
          shade.addColorStop(0, 'rgba(8,6,4,0.15)');
          shade.addColorStop(1, 'rgba(8,6,4,0.88)');
          ctx.fillStyle = shade;
          ctx.fillRect(0, 0, W, H);
        }

        drawGrain(ctx, 2600);

        // 边框
        ctx.strokeStyle = 'rgba(216,180,110,0.55)';
        ctx.lineWidth = 2;
        roundRect(ctx, 36, 36, W - 72, H - 72, 6);
        ctx.stroke();

        const MX = 96;           // 左右边距
        const maxW = W - MX * 2;
        const serif = '"Songti SC","Noto Serif CJK SC","STSong",serif';

        // 引文：从 54px 起逐级缩小，直到高度放得下
        let fontSize = 54;
        let lines = [];
        const lineHeight = function () { return Math.round(fontSize * 1.85); };
        const maxQuoteH = H * 0.42;
        while (fontSize > 26) {
          ctx.font = fontSize + 'px ' + serif;
          lines = wrapText(ctx, item.quote, maxW);
          if (lines.length * lineHeight() <= maxQuoteH) break;
          fontSize -= 4;
        }
        // 仍超长 → 截断加省略号
        const maxLines = Math.floor(maxQuoteH / lineHeight());
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines);
          lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1,2}$/, '……');
        }

        const quoteH = lines.length * lineHeight();
        const quoteTop = H * 0.5 - quoteH / 2;

        ctx.fillStyle = '#efe4cb';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.font = fontSize + 'px ' + serif;
        lines.forEach(function (line, i) {
          ctx.fillText(line, MX, quoteTop + i * lineHeight());
        });

        // 引号装饰
        ctx.fillStyle = 'rgba(216,180,110,0.35)';
        ctx.font = '120px ' + serif;
        ctx.fillText('「', MX - 20, quoteTop - 150);

        // 人物与年代
        let y = quoteTop + quoteH + 56;
        ctx.fillStyle = '#e6c078';
        ctx.font = '600 34px ' + serif;
        ctx.fillText(item.philosopher, MX, y);
        const whoW = ctx.measureText(item.philosopher).width;
        ctx.fillStyle = 'rgba(200,180,140,0.75)';
        ctx.font = '24px ' + serif;
        ctx.fillText(item.era, MX + whoW + 24, y + 8);

        // 回应
        y += 84;
        ctx.strokeStyle = 'rgba(185,138,62,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(MX, y + 6);
        ctx.lineTo(MX, y + 88);
        ctx.stroke();
        ctx.fillStyle = 'rgba(232,220,195,0.85)';
        ctx.font = '26px ' + serif;
        const respLines = wrapText(ctx, item.response, maxW - 36).slice(0, 3);
        respLines.forEach(function (line, i) {
          ctx.fillText(line, MX + 36, y + i * 46);
        });

        // 页脚
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(200,180,140,0.6)';
        ctx.font = '22px ' + serif;
        const date = new Date();
        const dateStr = date.getFullYear() + ' 年 ' + (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日';
        ctx.fillText(dateStr + ' · 箴言显影机', W / 2, H - 108);
        ctx.textAlign = 'left';

        return await new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            blob ? resolve(blob) : reject(new Error('TO_BLOB_FAILED'));
          }, 'image/png');
        });
      })();

      return withTimeout(job, TIMEOUT_MS);
    }

    return { generate: generate, TIMEOUT_MS: TIMEOUT_MS };
  })();
})();
