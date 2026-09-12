(function () {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const selEl = document.getElementById('sel');
  const sizeEl = document.getElementById('size');

  let snap = null;        // 整屏 {dataURL,imageWidth,imageHeight,displayWidth,displayHeight,scaleFactor}
  let start = null;       // 按下起点（CSS 像素）
  let cur = null;         // 当前拖拽点

  function toCss(mx, my) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(mx - r.left), y: Math.round(my - r.top) };
  }

  function scale() {
    // 需要把整屏物理像素图贴合到 CSS 像素窗口：CSS 宽高 = displayWidth/Height
    if (!snap) return 1;
    return snap.imageWidth / snap.displayWidth; // 每 CSS px 对应多少物理 px
  }

  function draw() {
    if (!snap) return;
    const sc = scale();
    const w = snap.displayWidth, h = snap.displayHeight;
    canvas.width = snap.imageWidth;
    canvas.height = snap.imageHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 底图
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // 半透明遮罩
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      const sel = currentSel();
      if (sel && sel.w > 0 && sel.h > 0) {
        // 在选中区域外填充
        const sx = sel.x * sc, sy = sel.y * sc, sw = sel.w * sc, sh = sel.h * sc;
        ctx.fillRect(0, 0, canvas.width, sy);
        ctx.fillRect(0, sy + sh, canvas.width, canvas.height - sy - sh);
        ctx.fillRect(0, sy, sx, sh);
        ctx.fillRect(sx + sw, sy, canvas.width - sx - sw, sh);
        // 选中框
        ctx.strokeStyle = '#2fa89e';
        ctx.lineWidth = 2;
        ctx.strokeRect(sx, sy, sw, sh);
        // 高亮内部
        ctx.clearRect(sx, sy, sw, sh);
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    };
    img.src = snap.dataURL;
    void w; void h;
  }

  function currentSel() {
    if (!start) return null;
    const x = Math.min(start.x, cur ? cur.x : start.x);
    const y = Math.min(start.y, cur ? cur.y : start.y);
    const w = Math.abs((cur ? cur.x : start.x) - start.x);
    const h = Math.abs((cur ? cur.y : start.y) - start.y);
    return { x, y, w, h };
  }

  function updateSelUI() {
    const s = currentSel();
    if (!s || s.w < 2 || s.h < 2) {
      selEl.style.display = 'none';
      sizeEl.style.display = 'none';
      return;
    }
    selEl.style.left = s.x + 'px';
    selEl.style.top = s.y + 'px';
    selEl.style.width = s.w + 'px';
    selEl.style.height = s.h + 'px';
    selEl.style.display = 'block';
    sizeEl.style.left = (s.x + s.w / 2 - 30) + 'px';
    sizeEl.style.top = (s.y - 26 < 0 ? s.y + 6 : s.y - 26) + 'px';
    sizeEl.textContent = s.w + ' × ' + s.h + 'px';
    sizeEl.style.display = 'block';
    draw();
  }

  window.addEventListener('mousedown', (e) => {
    start = toCss(e.clientX, e.clientY);
    cur = start;
    updateSelUI();
  });
  window.addEventListener('mousemove', (e) => {
    if (!start) { return; }
    cur = toCss(e.clientX, e.clientY);
    updateSelUI();
  });
  window.addEventListener('mouseup', (e) => {
    if (!start) return;
    cur = toCss(e.clientX, e.clientY);
    const s = currentSel();
    if (s.w >= 5 && s.h >= 5) { commit(s); }
    start = null; cur = null;
  });

  function commit(selCss) {
    if (!snap) return;
    const sc = scale();
    const sx = Math.max(0, Math.round(selCss.x * sc));
    const sy = Math.max(0, Math.round(selCss.y * sc));
    const sw = Math.min(snap.imageWidth - sx, Math.round(selCss.w * sc));
    const sh = Math.min(snap.imageHeight - sy, Math.round(selCss.h * sc));
    if (sw < 4 || sh < 4) return;
    const c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    const cx = c.getContext('2d');
    const img = new Image();
    img.onload = () => {
      cx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      window.captureApi.selected({ dataURL: c.toDataURL('image/png'), w: sw, h: sh });
    };
    img.src = snap.dataURL;
  }

  document.addEventListener('dblclick', (e) => {
    if (start) {
      cur = toCss(e.clientX, e.clientY);
      const s = currentSel();
      if (s.w >= 5 && s.h >= 5) commit(s);
    } else {
      // 双击未选中时，截全屏
      if (snap) {
        window.captureApi.selected({ dataURL: snap.dataURL, w: snap.imageWidth, h: snap.imageHeight });
      }
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { window.captureApi.cancel(); }
    if (e.key === 'Enter' && start) {
      const s = currentSel();
      if (s.w >= 5 && s.h >= 5) commit(s);
    }
  });

  window.captureApi.onSnapshot((s) => {
    snap = s;
    if (snap.displayWidth && snap.displayHeight) {
      canvas.style.width = snap.displayWidth + 'px';
      canvas.style.height = snap.displayHeight + 'px';
    }
    draw();
  });
})();
