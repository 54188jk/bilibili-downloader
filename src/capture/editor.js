(function () {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const colorInput = document.getElementById('colorInput');
  const widthInput = document.getElementById('widthInput');

  let baseImg = null;   // 原始 Image
  let baseW = 0, baseH = 0;
  let ops = [];         // 标注操作栈
  let undoStack = [];
  let currentTool = 'rect';
  let penDown = false;
  let startPt = null, curPt = null;
  let curText = '';
  let pickerActive = false;

  const SCALE_FIT = 0.7; // 显示缩放（相对窗口）
  let dispScale = 1;

  function fitSize() {
    const wrap = document.querySelector('.canvaswrap');
    const availW = wrap.clientWidth - 40;
    const availH = wrap.clientHeight - 40;
    dispScale = Math.min(availW / baseW, availH / baseH, 1);
    canvas.width = Math.round(baseW * dispScale);
    canvas.height = Math.round(baseH * dispScale);
  }

  function redraw() {
    if (!baseImg) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
    for (const op of ops) drawOp(op);
  }

  function drawOp(op) {
    ctx.save();
    ctx.lineWidth = op.width * dispScale;
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.font = (op.fontSize || 18) * dispScale + 'px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'top';
    const a = { x: op.x * dispScale, y: op.y * dispScale, w: op.w * dispScale, h: op.h * dispScale };
    switch (op.type) {
      case 'rect': ctx.strokeRect(a.x, a.y, a.w, a.h); break;
      case 'ellipse': ctx.beginPath(); ctx.ellipse(a.x + a.w/2, a.y + a.h/2, a.w/2, a.h/2, 0, 0, Math.PI*2); ctx.stroke(); break;
      case 'arrow':
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x+a.w, a.y+a.h); ctx.stroke();
        // 箭头头部
        const ang = Math.atan2(a.h, a.w);
        const len = Math.max(10, 6*dispScale);
        ctx.beginPath();
        ctx.moveTo(a.x+a.w, a.y+a.h);
        ctx.lineTo(a.x+a.w - len*Math.cos(ang-0.4), a.y+a.h - len*Math.sin(ang-0.4));
        ctx.moveTo(a.x+a.w, a.y+a.h);
        ctx.lineTo(a.x+a.w - len*Math.cos(ang+0.4), a.y+a.h - len*Math.sin(ang+0.4));
        ctx.stroke();
        break;
      case 'text': ctx.fillText(op.text, a.x, a.y); break;
      case 'pen':
        if (op.points && op.points.length > 1) {
          ctx.beginPath(); ctx.moveTo(op.points[0].x*dispScale, op.points[0].y*dispScale);
          for (let i=1;i<op.points.length;i++) ctx.lineTo(op.points[i].x*dispScale, op.points[i].y*dispScale);
          ctx.stroke();
        }
        break;
      case 'mosaic': applyMosaicBlur(op, true); break;
      case 'blur': applyMosaicBlur(op, false); break;
    }
    ctx.restore();
  }

  // 马赛克 / 模糊：直接在 base 的对应区域做像素处理（作用于画板，用 base 原图取像素）
  function applyMosaicBlur(op, mosaic) {
    const bx = op.x * dispScale, by = op.y * dispScale, bw = op.w * dispScale, bh = op.h * dispScale;
    if (bw < 2 || bh < 2) return;
    const imgData = ctx.getImageData(bx, by, bw, bh);
    const px = imgData.data;
    const cell = Math.max(3, Math.round(op.cell * dispScale * (mosaic ? 1 : 1)));
    if (mosaic) {
      for (let cy = 0; cy < bh; cy += cell) {
        for (let cx = 0; cx < bw; cx += cell) {
          const i = (cy * bw + cx) * 4;
          const r = px[i], g = px[i+1], b = px[i+2], a = px[i+3];
          const w = Math.min(cell, bw - cx), h = Math.min(cell, bh - cy);
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const j = ((cy+y)*bw + (cx+x)) * 4;
              px[j]=r; px[j+1]=g; px[j+2]=b; px[j+3]=a;
            }
          }
        }
      }
    } else {
      // 简单的均值模糊
      const tmp = new Uint8ClampedArray(px);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          let r=0,g=0,b=0,n=0;
          const rad = Math.max(1, Math.round(cell/2));
          for (let dy=-rad;dy<=rad;dy++) for(let dx=-rad;dx<=rad;dx++){
            const yy=y+dy, xx=x+dx;
            if (yy<0||xx<0||yy>=bh||xx>=bw) continue;
            const j=(yy*bw+xx)*4; r+=tmp[j];g+=tmp[j+1];b+=tmp[j+2];n++;
          }
          if(!n) continue;
          const j=(y*bw+x)*4; px[j]=r/n; px[j+1]=g/n; px[j+2]=b/n;
        }
      }
    }
    ctx.putImageData(imgData, bx, by);
  }

  function ensureImageReady(cb) {
    if (baseImg && baseImg.complete) return cb();
    const t = setInterval(() => { if (baseImg && baseImg.complete) { clearInterval(t); cb(); } }, 30);
  }

  function toCss(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / dispScale, y: (e.clientY - r.top) / dispScale };
  }

  canvas.addEventListener('mousedown', (e) => {
    if (pickerActive) { pickColor(e); return; }
    penDown = true;
    startPt = toCss(e);
    curPt = startPt;
    curText = '';
  });
  canvas.addEventListener('mousemove', (e) => {
    if (!penDown) return;
    curPt = toCss(e);
    if (startPt) drawPreview();
  });
  canvas.addEventListener('mouseup', (e) => {
    if (!penDown) return;
    curPt = toCss(e);
    penDown = false;
    if (!startPt) return;
    finishOp();
    startPt = null; curPt = null;
  });

  function drawPreview() {
    redraw();
    ctx.save();
    ctx.lineWidth = (+widthInput.value) * dispScale;
    ctx.strokeStyle = colorInput.value;
    ctx.fillStyle = colorInput.value;
    ctx.font = (18) * dispScale + 'px system-ui,"Microsoft YaHei",sans-serif';
    ctx.textBaseline = 'top';
    const tx = startPt.x * dispScale, ty = startPt.y * dispScale;
    const dx = (curPt.x-startPt.x) * dispScale, dy = (curPt.y-startPt.y) * dispScale;
    const w = Math.abs(dx), h = Math.abs(dy);
    const x = dx>=0?tx:tx+dx, y=dy>=0?ty:ty+dy;
    if (currentTool==='rect') ctx.strokeRect(x,y,w,h);
    else if (currentTool==='ellipse'){ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);ctx.stroke();}
    else if (currentTool==='arrow'){
      ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(tx+dx,ty+dy);ctx.stroke();
      const ang=Math.atan2(dy,dx),len=Math.max(10,8*dispScale);
      ctx.beginPath();ctx.moveTo(tx+dx,ty+dy);ctx.lineTo(tx+dx-len*Math.cos(ang-0.4),ty+dy-len*Math.sin(ang-0.4));
      ctx.moveTo(tx+dx,ty+dy);ctx.lineTo(tx+dx-len*Math.cos(ang+0.4),ty+dy-len*Math.sin(ang+0.4));ctx.stroke();
    }
    else if (currentTool==='text') ctx.fillText('Aa', tx, ty);
    else if (currentTool==='mosaic'||currentTool==='blur'){ ctx.fillStyle='rgba(80,90,110,.55)';ctx.fillRect(x,y,w,h); }
    else if (currentTool==='pen'){ ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(tx+dx,ty+dy);ctx.stroke(); }
    ctx.restore();
  }

  function finishOp() {
    const x = Math.min(startPt.x, curPt.x), y = Math.min(startPt.y, curPt.y);
    const w = Math.abs(curPt.x-startPt.x), h = Math.abs(curPt.y-startPt.y);
    if (currentTool==='mosaic'||currentTool==='blur'||currentTool==='rect'||currentTool==='ellipse'||currentTool==='arrow') {
      ops.push({ type: currentTool, x, y, w, h, color: colorInput.value, width: +widthInput.value, cell: currentTool==='mosaic'?12:9 });
    } else if (currentTool==='text') {
      const t = window.prompt('输入文字：') || '';
      if (t) ops.push({ type:'text', x, y, w:0, h:0, text:t, color:colorInput.value, width:2, fontSize:20 });
    } else if (currentTool==='pen') {
      // 收集拖拽点（简化：仅记录起止）
      ops.push({ type:'pen', points:[{x:startPt.x,y:startPt.y},{x:curPt.x,y:curPt.y}], color:colorInput.value, width:+widthInput.value });
    }
    undoStack = [];
    redraw();
  }

  function pickColor(e) {
    const p = toCss(e);
    const data = ctx.getImageData(Math.round(p.x*dispScale), Math.round(p.y*dispScale), 1, 1).data;
    const hex = '#' + [data[0],data[1],data[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
    colorInput.value = hex;
    pickerActive = false;
    document.querySelector('[data-tool=picker]').classList.remove('active');
    document.querySelector('[data-tool=rect]').classList.add('active');
    currentTool = 'rect';
    redraw();
  }

  document.querySelectorAll('.tool').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.getAttribute('data-tool');
      if (t==='undo'){ if(ops.length){ undoStack.push(ops.pop()); redraw(); } return; }
      if (t==='redo'){ if(undoStack.length){ ops.push(undoStack.pop()); redraw(); } return; }
      if (t==='clear'){ ops=[]; undoStack=[]; redraw(); return; }
      document.querySelectorAll('.tool').forEach(x=>x.classList.remove('active'));
      el.classList.add('active');
      currentTool = t;
      pickerActive = (t==='picker');
    });
  });

  function currentDataURL() {
    return canvas.toDataURL('image/png');
  }

  document.getElementById('copyBtn').onclick = () => window.editorApi.done(currentDataURL());
  document.getElementById('saveBtn').onclick = () => window.editorApi.save(currentDataURL());
  document.getElementById('pinBtn').onclick = () => window.editorApi.pin(currentDataURL());
  document.getElementById('ocrBtn').onclick = () => window.editorApi.ocr(currentDataURL());
  document.getElementById('cancelBtn').onclick = () => window.editorApi.cancel();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.editorApi.cancel();
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='c' && penDown===false){
      // 复制；这里简单处理不阻止，用户可点按钮
    }
  });

  window.editorApi.onImage((dataURL) => {
    const img = new Image();
    img.onload = () => {
      baseImg = img; baseW = img.width; baseH = img.height;
      fitSize(); redraw();
      document.querySelector('[data-tool=rect]').classList.add('active');
    };
    img.src = dataURL;
  });
})();
