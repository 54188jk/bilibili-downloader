/* 验证脚本：启动应用 → 触发 B 站登录窗口 → 检查 passport 页的 navigator.userAgent
   用法：node verify-login.cjs [port] */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9473';
const APP = require('path').join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

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
async function listTargets() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch (_) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('devtools not reachable');
}

(async () => {
  // 1. 等主窗口就绪
  let mainPage = null;
  for (let i = 0; i < 30; i++) {
    const list = await listTargets();
    mainPage = list.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (mainPage) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!mainPage) throw new Error('main window not found');
  const ws = await connect(mainPage.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await new Promise(r => setTimeout(r, 2000));

  // 2. 触发登录窗口
  await send(ws, 'Runtime.evaluate', { expression: "document.getElementById('userBox').click()" });
  console.log('login window triggered');

  // 3. 等 passport 页出现并加载
  let passport = null;
  for (let i = 0; i < 30; i++) {
    const list = await listTargets();
    passport = list.find(t => t.type === 'page' && t.url.includes('passport.bilibili.com'));
    if (passport) {
      // 再等页面 JS 执行稳定
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!passport) throw new Error('passport window not found');
  const pws = await connect(passport.webSocketDebuggerUrl);
  await send(pws, 'Runtime.enable');

  // 4. 读 navigator.userAgent 和 webdriver 标志
  const r = await send(pws, 'Runtime.evaluate', {
    expression: "JSON.stringify({ ua: navigator.userAgent, webdriver: navigator.webdriver })",
    returnByValue: true
  });
  const info = JSON.parse(r.result.value);
  console.log('UA     :', info.ua);
  console.log('webdriver:', info.webdriver);
  const hasElectron = /electron/i.test(info.ua);
  console.log(hasElectron ? 'FAIL: UA 仍含 Electron 特征' : 'PASS: UA 已无 Electron 特征');

  pws.close(); ws.close(); child.kill(); process.exit(hasElectron ? 1 : 0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
