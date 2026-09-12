/* 启动 Electron（自管子进程）→ 等调试端口就绪 → CDP 截浅色/深色两张图 → 退出
   用法：node shot.cjs [port]                                              */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9470';
const OUT = 'C:/Users/Administrator/Desktop/agent/.shots';
const APP = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// 关键：清除 ELECTRON_RUN_AS_NODE，否则 electron 以纯 node 启动会报 app.getPath undefined
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
  throw new Error('target not found on port ' + PORT);
}

async function shoot(ws, file) {
  const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('saved', file, fs.statSync(file).size, 'bytes');
}

(async () => {
  const target = await findTarget();
  console.log('target:', target.title);
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise(r => setTimeout(r, 1800));

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.remove('dark')" });
  await new Promise(r => setTimeout(r, 900));
  await shoot(ws, OUT + '/app-light.png');

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.add('dark')" });
  await new Promise(r => setTimeout(r, 900));
  await shoot(ws, OUT + '/app-dark.png');

  ws.close();
  child.kill();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
