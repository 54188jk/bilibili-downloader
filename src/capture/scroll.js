(function () {
  const fill = document.getElementById('fill');
  const text = document.getElementById('text');
  window.scrollApi.onProgress((d) => {
    if (d.percent !== undefined) fill.style.width = Math.max(0, Math.min(100, d.percent)) + '%';
    if (d.text) text.textContent = d.text;
  });
})();