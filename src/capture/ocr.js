(function () {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const resultText = document.getElementById('resultText');
  const recBtn = document.getElementById('recBtn');
  const recBtn2 = document.getElementById('recBtn2');
  const copyBtn = document.getElementById('copyBtn');
  const copyBtn2 = document.getElementById('copyBtn2');
  const closeBtn = document.getElementById('closeBtn');
  const loading = document.getElementById('loading');
  const langSel = document.getElementById('langSel');
  let currentDataURL = '';

  function showLoading(on) {
    loading.style.display = on ? 'flex' : 'none';
    recBtn.disabled = on;
    recBtn2.disabled = on;
  }

  async function doRecognize() {
    if (!currentDataURL) return;
    showLoading(true);
    resultText.textContent = '识别中…';
    copyBtn.disabled = true;
    copyBtn2.disabled = true;
    try {
      const r = await window.ocrApi.recognize(currentDataURL, langSel.value);
      if (r.ok) {
        resultText.textContent = r.text || '(无识别文字)';
        copyBtn.disabled = false;
        copyBtn2.disabled = false;
      } else {
        resultText.textContent = '识别失败：' + (r.error || '未知错误');
      }
    } catch (e) {
      resultText.textContent = '异常：' + e.message;
    } finally {
      showLoading(false);
    }
  }

  recBtn.onclick = doRecognize;
  recBtn2.onclick = doRecognize;
  copyBtn.onclick = () => navigator.clipboard.writeText(resultText.textContent);
  copyBtn2.onclick = () => navigator.clipboard.writeText(resultText.textContent);
  closeBtn.onclick = () => window.close();

  window.ocrApi.onImage((dataURL) => {
    currentDataURL = dataURL;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      resultText.textContent = '点击「识别」开始 OCR 识别';
      copyBtn.disabled = true;
      copyBtn2.disabled = true;
    };
    img.src = dataURL;
  });
})();