/* 临时验证脚本：通过 CDP 截取渲染进程界面（浅色 / 深色各一张） */
const fs = require('fs');
const WebSocket = require('ws');

const OUT = 'C:/Users/Administrator/Desktop/agent/.shots';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function list() {
  const r = await fetch('http://127.0.0.1:9456/json');
  return r.json();
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}

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

async function shoot(ws, file) {
  const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('saved', file, fs.statSync(file).size, 'bytes');
}

(async () => {
  let targets;
  for (let i = 0; i < 30; i++) {
    try { targets = await list(); if (targets.length) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  const page = targets.filter(t => t.type === 'page' && t.url.includes('index.html'))[0] || targets[0];
  console.log('target:', page && page.title, '|', page && page.url.slice(0, 80));

  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 1200));

  // 深色（应用默认）
  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.add('dark')" });
  await new Promise(r => setTimeout(r, 700));
  await shoot(ws, OUT + '/app-dark.png');

  // 浅色
  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.remove('dark')" });
  await new Promise(r => setTimeout(r, 700));
  await shoot(ws, OUT + '/app-light.png');

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
