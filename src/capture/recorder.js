(function () {
  const video = document.getElementById('video');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const saveBtn = document.getElementById('saveBtn');
  const closeBtn = document.getElementById('closeBtn');
  const fmtSel = document.getElementById('fmtSel');
  const info = document.getElementById('info');

  let mediaRecorder = null;
  let chunks = [];
  let stream = null;
  let startTime = 0;
  let timerId = null;
  let blob = null;

  async function start() {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 30 },
        audio: true,
      });
      video.srcObject = stream;
      chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
      mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onStop;
      mediaRecorder.start(200); // 每 200ms 一个 chunk
      startTime = Date.now();
      timerId = setInterval(() => {
        const s = Math.floor((Date.now() - startTime) / 1000);
        info.textContent = `录制中… ${Math.floor(s/60)}:${String(s%60).padStart(2,'0')} · ${fmtSel.value.toUpperCase()}`;
      }, 500);
      startBtn.style.display = 'none';
      stopBtn.style.display = 'flex';
      saveBtn.style.display = 'none';
      saveBtn.disabled = true;
    } catch (e) {
      alert('无法开始录制：' + e.message);
    }
  }

  function stop() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (timerId) clearInterval(timerId);
  }

  async function onStop() {
    blob = new Blob(chunks, { type: 'video/webm' });
    video.srcObject = null;
    video.src = URL.createObjectURL(blob);
    stopBtn.style.display = 'none';
    saveBtn.style.display = 'flex';
    saveBtn.disabled = false;
    info.textContent = `录制完成 · ${(blob.size/1024).toFixed(1)} KB · 点击保存为 ${fmtSel.value.toUpperCase()}`;
  }

  async function save() {
    if (!blob) return;
    const format = fmtSel.value;
    info.textContent = `正在转码为 ${format.toUpperCase()}…`;
    saveBtn.disabled = true;
    try {
      const dataURL = await blobToDataURL(blob);
      const r = await window.recorderApi.save(format, dataURL);
      if (r.ok) {
        info.textContent = '保存成功：' + r.path;
        saveBtn.disabled = false;
      } else {
        info.textContent = '转码失败：' + r.error;
        saveBtn.disabled = false;
      }
    } catch (e) {
      info.textContent = '异常：' + e.message;
      saveBtn.disabled = false;
    }
  }

  function blobToDataURL(b) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(b);
    });
  }

  startBtn.onclick = start;
  stopBtn.onclick = stop;
  saveBtn.onclick = save;
  closeBtn.onclick = () => { stop(); window.close(); };
  window.addEventListener('beforeunload', stop);
})();