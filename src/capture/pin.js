(function () {
  const img = document.getElementById('img');
  const lbl = document.getElementById('lbl');
  document.getElementById('closeBtn').onclick = () => window.close();
  document.getElementById('copyBtn').onclick = () => {
    if (window._dataURL) window.pinApi.copy(window._dataURL);
  };
  window.pinApi.onImage((dataURL) => {
    window._dataURL = dataURL;
    img.src = dataURL;
    img.onload = () => { lbl.textContent = '贴图 ' + img.naturalWidth + '×' + img.naturalHeight; };
  });
})();
