/* 主题切换验证：支持 View Transitions？点击后 body.dark 与 localStorage 是否正确同步、有无报错
   用法：node verify-theme.cjs [port]                                        */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9495';
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
function connect(u) { return new Promise((res, rej) => { const ws = new WebSocket(u, { perMessageDeflate: false }); ws.on('open', () => res(ws)); ws.on('error', rej); }); }
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find(t => t.type === 'page' && t.url.includes('index.html'));
      if (p) return p;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('target not found');
}

const state = `JSON.stringify({
  cls: document.body.className,
  dark: document.body.classList.contains('dark'),
  stored: localStorage.getItem('biligrab_theme'),
  btnActive: (document.getElementById('themeToggle')||{}).classList ? document.getElementById('themeToggle').classList.contains('active') : null,
  btnTitle: (document.getElementById('themeToggle')||{}).title || '',
  vt: typeof document.startViewTransition
})`;

(async () => {
  const t = await findTarget();
  const ws = await connect(t.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Log.enable').catch(() => {});

  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(JSON.stringify(m.params.exceptionDetails.text || '') + ' ' + (m.params.exceptionDetails.exception || {}).description || '');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push('console.error: ' + JSON.stringify(m.params.args.map(a => a.value)));
    }
  });

  await new Promise(r => setTimeout(r, 1800));

  // 探针：document 级 capture 监听，记录点击是否真的到达按钮
  await send(ws, 'Runtime.evaluate', { expression: `
    window.__log = [];
    document.addEventListener('click', function(e){
      window.__log.push('doc-capture:' + (e.target.id||e.target.className||e.target.tagName));
    }, true);
    document.addEventListener('click', function(e){
      window.__log.push('doc-bubble-theming:' + document.documentElement.classList.contains('theming'));
    }, false);
  ` });
  const s0 = await send(ws, 'Runtime.evaluate', { expression: state, returnByValue: true });
  console.log('初始      :', s0.result.value);

  await send(ws, 'Runtime.evaluate', { expression: "document.getElementById('themeToggle').click()" });
  await new Promise(r => setTimeout(r, 1400));
  const s1 = await send(ws, 'Runtime.evaluate', { expression: state, returnByValue: true });
  console.log('点击一次  :', s1.result.value);

  await send(ws, 'Runtime.evaluate', { expression: "document.getElementById('themeToggle').click()" });
  await new Promise(r => setTimeout(r, 1400));
  const s2 = await send(ws, 'Runtime.evaluate', { expression: state, returnByValue: true });
  console.log('再点一次  :', s2.result.value);

  const log = await send(ws, 'Runtime.evaluate', { expression: "JSON.stringify(window.__log||[])", returnByValue: true });
  console.log('点击日志  :', log.result.value);
  console.log('报错      :', errors.length ? errors.slice(0, 6) : '无');

  ws.close(); child.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
