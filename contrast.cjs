/* 主题体检：扫描浅色/深色下的「隐身元素」（前景色与有效背景色对比度过低）
   用法：node contrast.cjs [port]                                            */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.argv[2] || '9490';
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

const SCAN = `(() => {
  const parse = (s) => {
    const m = s && s.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  // 有效背景：向上找第一个不透明度足够的祖先背景（近似，忽略渐变）
  const effBg = (el) => {
    let n = el, acc = null;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const out = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.15) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // 只看直接含文本的元素
    const txt = Array.from(el.childNodes).filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join('');
    if (!txt) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a < 0.2) continue;
    const bg = effBg(el);
    const cr = ratio(fg, bg);
    if (cr < 2.2) {
      out.push({
        text: txt.slice(0, 22),
        cls: (el.className && el.className.toString().slice(0, 46)) || el.tagName,
        id: el.id || '',
        color: cs.color,
        bg: 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ',' + bg.a + ')',
        ratio: Math.round(cr * 100) / 100
      });
    }
  }
  return JSON.stringify(out, null, 1);
})()`;

(async () => {
  const t = await findTarget();
  const ws = await connect(t.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await new Promise(r => setTimeout(r, 1500));

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.remove('dark')" });
  await new Promise(r => setTimeout(r, 900));
  const light = await send(ws, 'Runtime.evaluate', { expression: SCAN, returnByValue: true });
  console.log('===== LIGHT 低对比度元素 (' + JSON.parse(light.result.value).length + ') =====');
  console.log(light.result.value);

  await send(ws, 'Runtime.evaluate', { expression: "document.body.classList.add('dark')" });
  await new Promise(r => setTimeout(r, 900));
  const dark = await send(ws, 'Runtime.evaluate', { expression: SCAN, returnByValue: true });
  console.log('===== DARK 低对比度元素 (' + JSON.parse(dark.result.value).length + ') =====');
  console.log(dark.result.value);

  ws.close(); child.kill(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch (_) {} process.exit(1); });
