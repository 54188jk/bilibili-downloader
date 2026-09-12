/* 临时自检脚本：读取关键元素计算样式，逐项对照设计稿 v2 期望值 */
const WebSocket = require('ws');
async function main() {
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise(r => ws.on('open', r));
  let id = 0;
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id;
    const h = raw => { const m = JSON.parse(raw.toString()); if (m.id === mid) { ws.off('message', h); res(m.result); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Runtime.enable');
  await send('Runtime.evaluate', { expression: "document.body.classList.remove('dark')" });

  const expr = `(() => {
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
    return JSON.stringify([
      g('body', ['backgroundColor','fontFamily','color']),
      g('.titlebar', ['padding','borderRadius','backgroundColor','boxShadow','backdropFilter']),
      g('.brand-mark', ['width','height','borderRadius','backgroundImage']),
      g('.platform-row', ['margin','gap']),
      g('.platform-btn', ['padding','borderRadius','fontSize','backgroundColor','color']),
      g('.platform-btn.active', ['backgroundColor','color','boxShadow']),
      g('.layout', ['gap','padding','display','gridTemplateColumns']),
      g('.panel', ['padding','borderRadius','backgroundColor','border','boxShadow']),
      g('.step-num', ['fontSize','fontWeight','color','backgroundColor','padding','borderRadius']),
      g('.input-wrap', ['borderRadius','border','backgroundColor']),
      g('.url-input', ['fontSize','lineHeight','padding']),
      g('.btn-primary', ['padding','borderRadius','backgroundImage','fontSize','fontWeight','color']),
      g('.savedir-display', ['borderRadius','minHeight','fontSize','backgroundColor']),
      g('.btn-secondary', ['padding','borderRadius','fontSize']),
      g('.ffmpeg-status', ['fontSize','color','marginLeft']),
      g('.task-headbar', ['margin','gap']),
      g('.empty-state', ['padding'])
    ], null, 1);
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(r.result.value);
  ws.close(); process.exit(0);
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
