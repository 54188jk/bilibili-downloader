// electron-builder afterPack 钩子
// 1) 清理 asar.unpacked 中重复的 ffmpeg.exe（extraResources 已有一份）
// 2) 补齐 tesseract OCR 运行时到 app.asar.unpacked（真实文件，worker_threads 可加载）：
//    - node_modules/tesseract.js        （主模块 + worker-script）
//    - node_modules/tesseract.js-core  （WASM 核心，顶层 hoisted）
//    - node_modules/tesseract.js/node_modules/tesseract.js-core（worker 内 require 的解析路径）
const fs = require('fs');
const path = require('path');

function copyDir(src, dst) {
  if (!fs.existsSync(src)) { console.warn('[after-pack] src missing:', src); return false; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  console.log('[after-pack] copied', src, '->', dst);
  return true;
}

exports.default = (context) => {
  const unpackedNm = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
  const devNm = path.join(__dirname, '..', 'node_modules');

  // 1) 重复 ffmpeg
  const dup = path.join(unpackedNm, 'ffmpeg-static');
  try { if (fs.existsSync(dup)) { fs.rmSync(dup, { recursive: true, force: true }); console.log('[after-pack] removed duplicate ffmpeg-static'); } } catch (e) { console.warn(e.message); }

  // 2) tesseract OCR
  copyDir(path.join(devNm, 'tesseract.js'), path.join(unpackedNm, 'tesseract.js'));
  copyDir(path.join(devNm, 'tesseract.js-core'), path.join(unpackedNm, 'tesseract.js-core'));
  copyDir(path.join(devNm, 'tesseract.js-core'),
    path.join(unpackedNm, 'tesseract.js', 'node_modules', 'tesseract.js-core'));
};
