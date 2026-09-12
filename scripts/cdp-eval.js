// CDP driver for BiliGrab — evaluate JS in the renderer via WebSocket.
// Usage: node scripts/cdp-eval.js "<js-expr>"
const WebSocket = require('ws');
const http = require('http');

const PORT = 9334;
const expr = process.argv[2];

function getJsonList() {
  return new Promise((res, rej) => {
    http.get(`http://127.0.0.1:${PORT}/json`, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

function sendCmd(ws, id, method, params) {
  return new Promise((res, rej) => {
    const h = {};
    h[id] = (msg) => {
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    };
    ws._pending = ws._pending || {};
    ws._pending[id] = h[id];
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  const pages = await getJsonList();
  const page = pages.find(p => p.type === 'page');
  if (!page) { console.error('no page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.once('open', r));

  let id = 0;
  const nextId = () => ++id;
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const cb = ws._pending && ws._pending[msg.id];
    if (cb) { delete ws._pending[msg.id]; cb(msg); }
  });

  const evalJs = async (js, awaitPromise = true) => {
    const r = await sendCmd(ws, nextId(), 'Runtime.evaluate', {
      expression: js, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' };
    return r.result ? r.result.value : undefined;
  };

  try {
    const res = await evalJs(expr);
    console.log(JSON.stringify(res, null, 2));
  } finally {
    ws.close();
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
