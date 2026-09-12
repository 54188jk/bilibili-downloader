/* 启动 Electron（自管子进程）→ 分两次独立求值读浅色/深色计算样式 → 退出
   用法：node audit.cjs [port]                                               */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9480';
const APP = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(APP, ['.', '--remote-debugging-port=' + PORT], {
  cwd: __dirname, env, stdio: ['ignore', 'ignore', 'ignore']
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
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    ws.on('open', () => res(ws)); ws.on('error', rej);
  });
}
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('target not found');
}

// 每轮：先切主题，再等一帧后读取（避免同步读取拿到旧值）
function probeExpr() {
  return `(() => {
    const g = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const c = getComputedStyle(el);
      const o = { sel };
      props.forEach(p => o[p] = c[p]);
      const r = el.getBoundingClientRect();
      o._w = Math.round(r.width); o._h = Math.round(r.height);
      return o;
    };
    return JSON.stringify({
      theme: document.body.className,
      body: g('body', ['backgroundColor','color']),
      titlebar: g('.titlebar', ['backgroundColor']),
      panel: g('.panel', ['backgroundColor','borderRadius','backdropFilter']),
      seg: g('.platform-switch', ['backgroundColor']),
      segThumb: g('.seg-thumb', ['backgroundColor']),
      card: g('.video-card', ['backgroundColor','borderRadius']),
      inputWrap: g('.input-wrap', ['backgroundColor']),
      stepNum: g('.step-num', ['color','backgroundColor']),
      primary: g('.btn-primary', ['backgroundColor']),
      dirbox: g('.savedir-trigger', ['backgroundColor'])
    }, null, 1);
  })()`;
}

(async () => {
  const target = await findTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await new Promise(r => setTimeout(r, 1500));

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.remove('dark')" });
  await new Promise(r => setTimeout(r, 1000));
  const light = await send(ws, 'Runtime.evaluate', { expression: probeExpr(), returnByValue: true });
  console.log('===== LIGHT =====');
  console.log(light.result.value);

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.add('dark')" });
  await new Promise(r => setTimeout(r, 1000));
  const dark = await send(ws, 'Runtime.evaluate', { expression: probeExpr(), returnByValue: true });
  console.log('===== DARK =====');
  console.log(dark.result.value);

  ws.close(); child.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
