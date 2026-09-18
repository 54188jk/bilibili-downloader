/* ==========================================================================
   Apple · UI 交互层（Apple 风格）
   · 分段控件（.platform-switch）滑块跟随激活项
   · 编排式入场（rise + d1~d6 阶梯延迟）
   · 主题切换瞬间临时启用过渡（切换完自动摘除，避免拖慢日常 hover）
   注意：页面 CSP 为 script-src 'self'，本文件必须由 index.html 以 <script src> 引入
   ========================================================================== */
(function () {
  'use strict';

  /* ── 1. 分段控件滑块 ───────────────────────────────────────────── */
  var segThumbTimer = null;

  function positionThumb() {
    var sw = document.querySelector('.platform-switch');
    var thumb = document.getElementById('segThumb');
    if (!sw || !thumb) return;

    // 激活项：优先 .platform-btn.active，回退到第一个按钮
    var active = sw.querySelector('.platform-btn.active') || sw.querySelector('.platform-btn');
    if (!active) return;

    var base = thumb.offsetLeft;               // 滑块静态位置（容器 padding）
    thumb.style.width = active.offsetWidth + 'px';
    thumb.style.transform = 'translateX(' + (active.offsetLeft - base) + 'px)';
    thumb.style.opacity = '1';
  }

  function initSeg() {
    var sw = document.querySelector('.platform-switch');
    if (!sw) return;

    // 首次定位（等字体与布局稳定）
    positionThumb();
    [80, 260, 600].forEach(function (d) { setTimeout(positionThumb, d); });
    window.addEventListener('resize', positionThumb);

    // 平台按钮点击后立即跟随
    sw.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.platform-btn') : null;
      if (!btn) return;
      positionThumb();
      [60, 200].forEach(function (d) { setTimeout(positionThumb, d); });
    });

    // renderer.js 会切换 .active 类，用 MutationObserver 兜底同步
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        clearTimeout(segThumbTimer);
        segThumbTimer = setTimeout(positionThumb, 16);
      });
      mo.observe(sw, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
  }

  /* ── 2. 编排式入场 ─────────────────────────────────────────────── */
  function initRise() {
    var seq = [
      ['.titlebar', 'd1'],
      ['.panel-input', 'd2'],
      ['.panel-output', 'd3'],
      ['.video-card', 'd4'],
      ['.qualities-box', 'd5'],
      ['.task-headbar', 'd6']
    ];
    seq.forEach(function (item) {
      var el = document.querySelector(item[0]);
      if (el && !el.classList.contains('rise')) {
        el.classList.add('rise', item[1]);
      }
    });
  }

  /* ── 3. 主题切换 ────────────────────────────────────────────────
     优先 View Transitions：以按钮为圆心圆形揭示，避免整屏瞬间突变；
     不支持时降级为 html.theming 的 450ms 色彩过渡。                  */
  var THEME_KEY = 'biligrab_theme';   // 与 renderer.js 保持一致
  var themingTimer = null;

  function armThemeTransition() {
    var root = document.documentElement;
    root.classList.add('theming');
    clearTimeout(themingTimer);
    themingTimer = setTimeout(function () {
      root.classList.remove('theming');
    }, 620);
  }

  // 仅做状态变更，供 View Transition 快照使用
  function applyThemeCore(dark) {
    document.body.classList.toggle('dark', dark);
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.classList.toggle('active', dark);
      btn.title = dark ? '切换为浅色模式' : '切换为深色模式';
    }
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (_) {}
  }

  function prefersReduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function switchTheme(btn) {
    var dark = !document.body.classList.contains('dark');

    armThemeTransition();

    // 降级：不支持 View Transitions 或用户要求减少动效 → 直接切换（有 CSS 过渡）
    if (!document.startViewTransition || prefersReduced()) {
      applyThemeCore(dark);
      return;
    }

    var x = window.innerWidth - 40, y = 34;
    if (btn && btn.getBoundingClientRect) {
      var rect = btn.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    }

    // 幂等执行：VT 回调与超时兜底二选一，确保任何环境下主题都一定会切换
    var applied = false;
    function markApplied() {
      if (applied) return;
      applied = true;
      applyThemeCore(dark);
    }

    var transition;
    try {
      transition = document.startViewTransition(function () { markApplied(); });
    } catch (e) {
      markApplied();               // 启动失败：直接切换
      return;
    }
    setTimeout(markApplied, 260);   // 兜底：渲染帧不产生时（如窗口不可见）强制切换

    transition.ready.then(function () {
      var r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      document.documentElement.animate(
        {
          clipPath: [
            'circle(0px at ' + x + 'px ' + y + 'px)',
            'circle(' + Math.round(r) + 'px at ' + x + 'px ' + y + 'px)'
          ]
        },
        {
          duration: 560,
          easing: 'cubic-bezier(.32,.72,0,1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    }).catch(function () { /* 动画失败不影响主题已切换 */ });
  }

  function initThemeHook() {
    // 在 document 捕获阶段接管：早于 renderer.js 挂在按钮上的监听器，
    // 避免两者各切一次相互抵消（此前正是此原因导致切换无效）
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('#themeToggle') : null;
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      switchTheme(btn);
    }, true);

    // 兜底：无论谁改的 dark（设置项、快捷键等），都补上过渡
    if (window.MutationObserver) {
      var last = document.body.classList.contains('dark');
      new MutationObserver(function () {
        var now = document.body.classList.contains('dark');
        if (now !== last) { last = now; armThemeTransition(); }
      }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ── 启动 ─────────────────────────────────────────────────────── */
  function boot() {
    initSeg();
    initRise();
    initThemeHook();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
