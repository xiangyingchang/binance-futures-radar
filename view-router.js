'use strict';

(() => {
  const radarPanel = document.querySelector('[data-view-panel="radar"]');
  const v3Panel = document.querySelector('[data-view-panel="v3"]');
  const radarStyles = document.getElementById('radar-styles');
  const v3Styles = document.getElementById('v3-styles');
  const buttons = [...document.querySelectorAll('[data-view-target]')];
  const originalTitle = document.title;
  let currentView = null;
  let v3Loaded = false;
  let v3LoadPromise = null;

  if (!radarPanel || !v3Panel || !radarStyles || !v3Styles || !buttons.length) return;

  function hashView() {
    return window.location.hash.toLowerCase() === '#v3' ? 'v3' : 'radar';
  }

  function updateNavigation(view) {
    for (const button of buttons) {
      const active = button.dataset.viewTarget === view;
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function updateStyles(view) {
    radarStyles.disabled = view !== 'radar';
    v3Styles.disabled = view !== 'v3';
  }

  function appendScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.dataset.embeddedV3 = 'true';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`脚本加载失败：${src}`)), { once: true });
      v3Panel.appendChild(script);
    });
  }

  async function loadV3() {
    if (v3Loaded) return;
    if (v3LoadPromise) return v3LoadPromise;

    v3LoadPromise = (async () => {
      const response = await fetch('btc-v3.html', { cache: 'no-store' });
      if (!response.ok) throw new Error(`BTC V3 页面加载失败：HTTP ${response.status}`);
      const html = await response.text();
      const documentFragment = new DOMParser().parseFromString(html, 'text/html');
      const source = documentFragment.querySelector('main.shell');
      if (!source) throw new Error('BTC V3 页面结构不可用');

      v3Panel.replaceChildren();
      const shell = document.createElement('div');
      shell.className = 'shell';
      shell.innerHTML = source.innerHTML;
      v3Panel.appendChild(shell);

      const baseUrl = new URL('btc-v3.html', document.baseURI);
      const scripts = [...documentFragment.querySelectorAll('script[src]')]
        .map((script) => new URL(script.getAttribute('src'), baseUrl).href);
      for (const src of scripts) await appendScript(src);
      v3Loaded = true;
    })();

    try {
      await v3LoadPromise;
    } catch (error) {
      v3LoadPromise = null;
      v3Panel.innerHTML = `<p class="view-loading" role="alert">${error.message || 'BTC V3 暂时无法加载。'}</p>`;
      throw error;
    }
  }

  async function setView(view, pushState = false) {
    const nextView = view === 'v3' ? 'v3' : 'radar';
    if (pushState && window.location.hash !== `#${nextView}`) {
      window.history.pushState({ view: nextView }, '', `#${nextView}`);
    }

    if (currentView === nextView && (nextView !== 'v3' || v3Loaded)) return;
    currentView = nextView;
    updateNavigation(nextView);
    updateStyles(nextView);
    radarPanel.hidden = nextView !== 'radar';
    v3Panel.hidden = nextView !== 'v3';
    document.title = nextView === 'v3' ? 'BTC V3 · Dynamic Exposure' : originalTitle;

    if (nextView === 'v3') {
      try {
        await loadV3();
      } catch (_) {
        // The view already contains a user-facing error state.
      }
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', () => setView(button.dataset.viewTarget, true));
  }

  window.addEventListener('hashchange', () => setView(hashView()));
  window.addEventListener('popstate', () => setView(hashView()));
  setView(hashView());
})();
