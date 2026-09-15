/* 诊断脚本：启动 Electron → CDP 收集 console/异常/网络错误 → 输出报告
   用法：node diagnose.cjs [port] */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9471';
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
  throw new Error('target not found on port ' + PORT);
}

(async () => {
  const target = await findTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Log.enable');
  await send(ws, 'Network.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });

  const errors = [];
  const warnings = [];
  const logs = [];
  const exceptions = [];
  const failedRequests = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Runtime.consoleAPICalled') {
      const t = msg.params.type;
      const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
      const line = `[console.${t}] ${text}`;
      if (t === 'error') errors.push(line);
      else if (t === 'warning') warnings.push(line);
      else logs.push(line);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const det = msg.params.exceptionDetails;
      exceptions.push(`[EXCEPTION] ${det.text} ${det.exception && det.exception.description ? det.exception.description : ''} @ ${det.url}:${det.lineNumber}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push(`[log.error] ${e.text}`);
      else if (e.level === 'warning') warnings.push(`[log.warning] ${e.text}`);
    } else if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(`[net-fail] ${msg.params.url} type=${msg.params.type} err=${msg.params.errorText}`);
    } else if (msg.method === 'Network.responseReceived') {
      const r = msg.params.response;
      if (r.status >= 400) failedRequests.push(`[net-${r.status}] ${r.url}`);
    }
  });

  // 等待应用初始化（renderer.js 启动逻辑）
  await new Promise(r => setTimeout(r, 6000));

  // 尝试切换各 view，触发各自初始化逻辑，捕获错误
  const views = ['bili','douyin','kuaishou','music','movie','uc','history','settings','ai','models','messages'];
  const viewErrors = {};
  for (const v of views) {
    try {
      await send(ws, 'Runtime.evaluate', { expression: `
        (function(){
          var before = document.querySelectorAll('.view.active').length;
          var el = document.getElementById('view-${v}');
          if(!el) return 'no-view:'+v;
          el.click ? el.click() : null;
          // 模拟侧边栏切换：点击对应侧边栏项
          var items = document.querySelectorAll('.side-item');
          for(var i=0;i<items.length;i++){ if(items[i].dataset.view==='${v}'){ items[i].click(); break; } }
          return 'switched:'+v;
        })()
      ` });
      await new Promise(r => setTimeout(r, 1200));
    } catch (e) {
      viewErrors[v] = e.message;
    }
  }

  await new Promise(r => setTimeout(r, 1000));
  ws.close();
  child.kill();

  // 输出报告
  const report = [];
  report.push('========== BiliGrab 诊断报告 ==========');
  report.push('');
  report.push(`【未捕获异常】${exceptions.length} 个`);
  exceptions.forEach(e => report.push('  ' + e));
  report.push('');
  report.push(`【console.error】${errors.length} 个`);
  errors.forEach(e => report.push('  ' + e));
  report.push('');
  report.push(`【console.warning】${warnings.length} 个`);
  warnings.forEach(w => report.push('  ' + w));
  report.push('');
  report.push(`【网络失败/4xx】${failedRequests.length} 个`);
  failedRequests.forEach(f => report.push('  ' + f));
  report.push('');
  report.push(`【View 切换错误】`);
  Object.keys(viewErrors).forEach(v => report.push('  ' + v + ': ' + viewErrors[v]));
  report.push('');
  report.push('【console.log (前20条)】');
  logs.slice(0, 20).forEach(l => report.push('  ' + l));

  const text = report.join('\n');
  console.log(text);
  fs.writeFileSync(OUT + '/diagnose.txt', text);
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
