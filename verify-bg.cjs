/* 验证视频背景：启动 → 打开开关 → 确认视频播放 → 截图 → 关闭 → 确认停止
   用法：node verify-bg.cjs [port] */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9474';
const OUT = 'C:/Users/Administrator/Desktop/agent/.shots';
const APP = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(APP, ['.', '--remote-debugging-port=' + PORT], {
  cwd: __dirname, env, stdio: ['ignore', 'ignore', 'ignore'], detached: false
});

let id = 0;
function send(ws, method, params = {}) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === mid) { ws.off('message', onMsg); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('target not found');
}
async function shoot(ws, file) {
  const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('saved', file, fs.statSync(file).size, 'bytes');
}
async function evalJs(ws, expr) {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result.value;
}

(async () => {
  const target = await findTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 4000));

  // 1. 打开视频背景开关（设置页）
  const r1 = await evalJs(ws, `(function(){
    var items=document.querySelectorAll('.side-item'); for(var i=0;i<items.length;i++){ if(items[i].dataset.view==='settings'){ items[i].click(); break; } }
    var sw = document.querySelector('.switch[data-key="videoBg"]');
    if (!sw) return 'no-switch';
    if (!sw.classList.contains('on')) sw.click();
    return 'switch-on';
  })()`);
  console.log('step1:', r1);

  // 2. 等视频扫描+加载+起播
  await new Promise(r => setTimeout(r, 5000));
  const st1 = await evalJs(ws, `(function(){
    var v = document.getElementById('bgVideo');
    if (!v) return JSON.stringify({err:'no-video'});
    return JSON.stringify({ on: document.body.classList.contains('video-bg-on'),
      file: decodeURIComponent((v.currentSrc||'').split('/').pop()||''), t: v.currentTime, paused: v.paused, ready: v.readyState });
  })()`);
  console.log('BG ON :', st1);

  // 3. 截图：设置页（开启态）+ B站页（背景效果）
  await shoot(ws, OUT + '/bg-settings-on.png');
  await evalJs(ws, `(function(){ var items=document.querySelectorAll('.side-item'); for(var i=0;i<items.length;i++){ if(items[i].dataset.view==='bili'){ items[i].click(); break; } } return 'ok'; })()`);
  await new Promise(r => setTimeout(r, 1500));
  await shoot(ws, OUT + '/bg-bili-on.png');

  // 4. 关闭开关，确认视频停止
  await evalJs(ws, `(function(){
    var items=document.querySelectorAll('.side-item'); for(var i=0;i<items.length;i++){ if(items[i].dataset.view==='settings'){ items[i].click(); break; } }
    var sw = document.querySelector('.switch[data-key="videoBg"]');
    if (sw && sw.classList.contains('on')) sw.click();
    return 'off';
  })()`);
  await new Promise(r => setTimeout(r, 1500));
  const st2 = await evalJs(ws, `(function(){
    var v = document.getElementById('bgVideo');
    return JSON.stringify({ on: document.body.classList.contains('video-bg-on'),
      src: v ? (v.currentSrc||'') : null, paused: v ? v.paused : null });
  })()`);
  console.log('BG OFF:', st2);

  ws.close(); child.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
