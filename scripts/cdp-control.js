#!/usr/bin/env node
/**
 * CDP 远程控制 BiliGrab — 不需要前端界面
 * 用法：
 *   node scripts/cdp-control.js eval "document.title"
 *   node scripts/cdp-control.js eval "document.querySelector('#searchInput').value = '庆余年'"
 *   node scripts/cdp-control.js screenshot
 *   node scripts/cdp-control.js click "#movie-btn"
 *   node scripts/cdp-control.js test-parsers
 */
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.env.CDP_PORT || 9334;
const CDP_HOST = '127.0.0.1';

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://${CDP_HOST}:${CDP_PORT}${urlPath}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function connectPage() {
  const targets = await httpGet('/json');
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.on('open', () => {
      const send = (method, params = {}) => {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      };
      resolve({ ws, send });
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    });
    ws.on('error', reject);
  });
}

async function main() {
  const [,, cmd, ...args] = process.argv;
  if (!cmd) {
    console.log('用法: node cdp-control.js <command> [args]');
    console.log('  eval <js>        - 执行JS并返回结果');
    console.log('  screenshot       - 截图保存到 screenshot.png');
    console.log('  click <selector> - 点击元素');
    console.log('  set <sel> <val>  - 设置输入框值');
    console.log('  test-parsers     - 测试所有解析器');
    console.log('  movie-search <q> - 影视搜索');
    console.log('  movie-status     - 查看影视面板状态');
    process.exit(0);
  }

  const { ws, send } = await connectPage();

  try {
    switch (cmd) {
      case 'eval': {
        const js = args.join(' ');
        const result = await send('Runtime.evaluate', {
          expression: js,
          returnByValue: true,
          awaitPromise: true,
        });
        console.log(JSON.stringify(result.result?.value ?? result, null, 2));
        break;
      }
      case 'screenshot': {
        const res = await send('Page.captureScreenshot', { format: 'png', quality: 100 });
        const buf = Buffer.from(res.data, 'base64');
        const outPath = args[0] || 'screenshot.png';
        fs.writeFileSync(outPath, buf);
        console.log(`Screenshot saved: ${outPath} (${buf.length} bytes)`);
        break;
      }
      case 'click': {
        const sel = args[0];
        // 用 JSON.stringify 转义，避免选择器中的引号破坏 JS 字符串
        const js = `document.querySelector(${JSON.stringify(sel)})?.click(); 'clicked'`;
        const result = await send('Runtime.evaluate', { expression: js, returnByValue: true });
        console.log(result.result?.value);
        break;
      }
      case 'set': {
        const [sel, val] = args;
        const js = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if(el) { el.value = ${JSON.stringify(val)}; el.dispatchEvent(new Event('input',{bubbles:true})); return 'set'; } return 'not found'; })()`;
        const result = await send('Runtime.evaluate', { expression: js, returnByValue: true });
        console.log(result.result?.value);
        break;
      }
      case 'movie-search': {
        const q = args.join(' ');
        const js = `(() => {
          const input = document.querySelector('#movieSearchInput');
          const btn = document.querySelector('#movieSearchBtn');
          if (!input || !btn) return 'movie panel not found';
          input.value = ${JSON.stringify(q)};
          input.dispatchEvent(new Event('input', {bubbles:true}));
          btn.click();
          return 'searching: ' + ${JSON.stringify(q)};
        })()`;
        const result = await send('Runtime.evaluate', { expression: js, returnByValue: true });
        console.log(result.result?.value);
        break;
      }
      case 'movie-status': {
        const js = `(() => {
          const els = {
            detail: document.querySelector('#movieDetail'),
            player: document.querySelector('#moviePlayerSection'),
            results: document.querySelector('#movieResults'),
            search: document.querySelector('#movieSearchSection'),
          };
          return JSON.stringify({
            detailVisible: els.detail ? !els.detail.classList.contains('hidden') : null,
            playerVisible: els.player ? !els.player.classList.contains('hidden') : null,
            resultsVisible: els.results ? !els.results.classList.contains('hidden') : null,
            searchVisible: els.search ? !els.search.classList.contains('hidden') : null,
          });
        })()`;
        const result = await send('Runtime.evaluate', { expression: js, returnByValue: true });
        console.log(result.result?.value);
        break;
      }
      case 'test-parsers': {
        console.log('Testing parsers via Electron iframe...');
        // renderer 模块依赖 DOM/electron，不能在 Node 中 require；CDP eval 也取不到模块变量
        const js = `(() => {
          return 'Use movie panel UI to test parsers. Or run: node scripts/test-parsers.js';
        })()`;
        const result = await send('Runtime.evaluate', { expression: js, returnByValue: true });
        console.log(result.result?.value);
        break;
      }
      default:
        console.log(`Unknown command: ${cmd}`);
    }
  } finally {
    ws.close();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
