const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const PORT = process.argv[2] || '9499';
const APP = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(APP, ['.', '--remote-debugging-port=' + PORT], { cwd: __dirname, env, stdio: ['ignore','ignore','ignore'] });
let id = 0;
const send = (ws, m, p={}) => new Promise(res => { const mid=++id; const h=r=>{const o=JSON.parse(r.toString()); if(o.id===mid){ws.off('message',h); res(o.result);} }; ws.on('message',h); ws.send(JSON.stringify({id:mid,method:m,params:p})); });
const connect = u => new Promise((res,rej)=>{const ws=new WebSocket(u,{perMessageDeflate:false}); ws.on('open',()=>res(ws)); ws.on('error',rej);});
(async () => {
  let t;
  for (let i=0;i<60;i++){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); t=l.find(x=>x.type==='page'&&x.url.includes('index.html')); if(t)break; }catch(_){} await new Promise(r=>setTimeout(r,1000)); }
  const ws = await connect(t.webSocketDebuggerUrl);
  await send(ws,'Runtime.enable');
  await new Promise(r=>setTimeout(r,1800));
  // 注入探针：包装 click，记录 handler 是否运行
  await send(ws,'Runtime.evaluate',{expression:`
    window.__p = {themingAt30:null, htmlCls0:document.documentElement.className};
    document.getElementById('themeToggle').addEventListener('click', function(){ window.__p.myAfter = document.documentElement.className; }, false);
  `});
  await send(ws,'Runtime.evaluate',{expression:"document.getElementById('themeToggle').click()"});
  await new Promise(r=>setTimeout(r,40));
  const a = await send(ws,'Runtime.evaluate',{expression:`JSON.stringify({htmlCls:document.documentElement.className, bodyCls:document.body.className, probe:window.__p})`,returnByValue:true});
  console.log('点击后 40ms:', a.result.value);
  await new Promise(r=>setTimeout(r,1500));
  const b = await send(ws,'Runtime.evaluate',{expression:`JSON.stringify({htmlCls:document.documentElement.className, bodyCls:document.body.className, stored:localStorage.getItem('biligrab_theme')})`,returnByValue:true});
  console.log('点击后 1.5s:', b.result.value);
  ws.close(); child.kill(); process.exit(0);
})().catch(e=>{console.error('ERR',e.message); try{child.kill();}catch(_){} process.exit(1);});
