/**
 * 本地音乐 API 服务（NeteaseCloudMusicApi 内嵌）
 * - 应用启动时自动启动（端口 3927，仅绑定本机）
 * - 提供：搜索 / 播放地址 / 登录(二维码) / 歌单 / 下载等接口代理
 */
'use strict';

// 确保 anonymous_token 存在（必须在 require NeteaseCloudMusicApi 之前，
// 因为它在模块加载时就读取该文件，不存在则抛出 ENOENT 导致整个主进程崩溃）
(function ensureTokenSync() {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const p = path.resolve(os.tmpdir(), './anonymous_token');
    if (!fs.existsSync(p)) {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let tok = '';
      for (let i = 0; i < 32; i++) tok += chars[Math.floor(Math.random() * chars.length)];
      fs.writeFileSync(p, tok, 'ascii');
    }
  } catch (_) {}
})();

const { serveNcmApi } = require('NeteaseCloudMusicApi/server.js');
const http = require('http');

const PORT = 3927;
let server = null;      // 内部 express server 实例
let started = false;

// 确保 anonymous_token 存在（API 启动必需）
function ensureToken() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const p = path.resolve(os.tmpdir(), './anonymous_token');
  try {
    if (!fs.existsSync(p)) {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let tok = '';
      for (let i = 0; i < 32; i++) tok += chars[Math.floor(Math.random() * chars.length)];
      fs.writeFileSync(p, tok, 'ascii');
    }
  } catch (_) {}
}

// 启动本地音乐 API（幂等），端口被占用时自动向上重试
const MAX_PORT_RETRY = 20;
async function ensureServer() {
  if (started && server && server.listening) return { ok: true, port: PORT };
  ensureToken();
  for (let attempt = 0; attempt <= MAX_PORT_RETRY; attempt++) {
    const tryPort = PORT + attempt;
    try {
      const app = await serveNcmApi({ port: tryPort, host: '127.0.0.1', checkVersion: false });
      server = app.server;
      // 监听 server error 防止 EADDRINUSE 变成 uncaughtException
      server.on('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          console.warn('[music] 端口', tryPort, '被占用，尝试下个端口');
        }
      });
      started = true;
      currentPort = tryPort;
      return { ok: true, port: tryPort };
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && attempt < MAX_PORT_RETRY) continue;
      started = false;
      return { ok: false, error: e.message };
    }
  }
  started = false;
  return { ok: false, error: '所有备选端口均被占用' };
}
let currentPort = PORT;

// 代理请求本地 API
function apiGet(path, query) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = `http://127.0.0.1:${currentPort}${path}${qs ? '?' + qs : ''}`;
  return new Promise((resolve, reject) => {
    http.get(url, { timeout: 20000 }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data: { code: -1, raw: data.slice(0, 200) } }); }
      });
    }).on('error', err => reject(new Error('音乐API请求失败：' + err.message)));
  });
}

// 停止服务
function stopServer() {
  try { if (server) server.close(); } catch (_) {}
  started = false;
  server = null;
}

module.exports = { ensureServer, apiGet, stopServer, PORT };