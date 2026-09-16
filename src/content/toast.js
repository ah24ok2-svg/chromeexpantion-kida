// 新着メールをページ内トーストで表示する。service worker から
// chrome.scripting.executeScript で必要になったときだけ注入される。
// 二重注入されても最初の 1 回だけが有効になるようガードしている。

(() => {
  if (window.__gmailAtomToast) return;

  const HOST_ID = '__gmail-atom-toast-host';
  const state = {
    host: null,
    root: null,
    stack: null,
    position: 'bottom-right',
    toasts: new Set()
  };

  const CSS = `
    :host { all: initial; }
    .stack {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: min(360px, calc(100vw - 32px));
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN",
                   "Hiragino Sans", Meiryo, "Noto Sans JP", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    /* 新しいトーストが常に画面の隅に近い側へ積まれるようにする */
    .stack[data-pos="top-right"]    { top: 16px; right: 16px; align-items: flex-end;   flex-direction: column-reverse; }
    .stack[data-pos="top-left"]     { top: 16px; left: 16px;  align-items: flex-start; flex-direction: column-reverse; }
    .stack[data-pos="bottom-right"] { bottom: 16px; right: 16px; align-items: flex-end; }
    .stack[data-pos="bottom-left"]  { bottom: 16px; left: 16px;  align-items: flex-start; }

    .toast {
      pointer-events: auto;
      position: relative;
      box-sizing: border-box;
      width: min(340px, calc(100vw - 32px));
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 10px;
      padding: 11px 44px 12px 12px;
      border-radius: 12px;
      border: 1px solid rgba(0, 0, 0, 0.08);
      background: #ffffff;
      color: #1f1f1f;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.08);
      cursor: pointer;
      overflow: hidden;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .toast.in { opacity: 1; transform: none; }
    .toast.out { opacity: 0; transform: translateY(4px) scale(0.98); }
    .toast:hover { box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.1); }

    .icon {
      width: 22px; height: 22px;
      border-radius: 50%;
      background: #ea4335;
      display: flex; align-items: center; justify-content: center;
      flex: none;
      margin-top: 1px;
    }
    .icon svg { width: 12px; height: 12px; display: block; }

    .body { min-width: 0; }
    .subject {
      font-size: 13.5px;
      font-weight: 600;
      letter-spacing: 0.01em;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      margin: 0;
    }
    .meta {
      margin: 3px 0 0;
      font-size: 11.5px;
      color: #5f6368;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .snippet {
      margin: 4px 0 0;
      font-size: 11.5px;
      color: #5f6368;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }
    .account {
      margin: 5px 0 0;
      font-size: 10.5px;
      color: #80868b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* 閉じるボタンは常に見えていないと狙えないので、透明にはしない */
    .close {
      position: absolute;
      top: 7px; right: 7px;
      width: 30px; height: 30px;
      border: 0; padding: 0; margin: 0;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.06);
      color: #5f6368;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease, transform 100ms ease;
    }
    .close svg { width: 15px; height: 15px; display: block; }
    /* 見た目より一回り広い当たり判定 */
    .close::after { content: ""; position: absolute; inset: -5px; border-radius: 50%; }
    .close:hover { background: rgba(0, 0, 0, 0.13); color: #202124; }
    .close:active { transform: scale(0.92); }
    .close:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }

    .progress {
      position: absolute;
      left: 0; bottom: 0;
      height: 2px;
      width: 100%;
      transform-origin: left center;
      background: #ea4335;
      opacity: 0.55;
    }
    .progress.run { animation: drain linear forwards; }
    .toast:hover .progress.run { animation-play-state: paused; }
    @keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }

    @media (prefers-color-scheme: dark) {
      .toast {
        background: #202124;
        color: #e8eaed;
        border-color: rgba(255, 255, 255, 0.12);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.4);
      }
      .meta, .snippet { color: #9aa0a6; }
      .account { color: #80868b; }
      .close { background: rgba(255, 255, 255, 0.1); color: #9aa0a6; }
      .close:hover { background: rgba(255, 255, 255, 0.2); color: #e8eaed; }
    }
    @media (prefers-reduced-motion: reduce) {
      .toast { transition: none; }
      .progress.run { animation: none; }
    }
  `;

  const CLOSE_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
      stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  const ENVELOPE = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#fff"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3 7l9 6.5L21 7"/></svg>`;

  function ensureHost() {
    if (state.host && state.host.isConnected) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: static;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const stack = document.createElement('div');
    stack.className = 'stack';
    stack.dataset.pos = state.position;
    root.append(style, stack);
    (document.body || document.documentElement).appendChild(host);
    state.host = host;
    state.root = root;
    state.stack = stack;
  }

  function show(items, options = {}) {
    if (!Array.isArray(items) || items.length === 0) return;
    state.position = options.position || state.position;
    ensureHost();
    state.stack.dataset.pos = state.position;

    const max = Math.max(1, Number(options.maxToasts) || 3);
    for (const item of items) {
      addToast(item, options);
      while (state.toasts.size > max) {
        const oldest = state.toasts.values().next().value;
        dismiss(oldest, true);
      }
    }
    if (options.sound) beep();
  }

  function addToast(item, options) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'alert');

    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.innerHTML = ENVELOPE;

    const body = document.createElement('div');
    body.className = 'body';

    const subject = document.createElement('p');
    subject.className = 'subject';
    subject.textContent = item.subject || '(件名なし)';
    body.appendChild(subject);

    if (item.sender) {
      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = item.sender;
      body.appendChild(meta);
    }
    if (item.snippet) {
      const snippet = document.createElement('p');
      snippet.className = 'snippet';
      snippet.textContent = item.snippet;
      body.appendChild(snippet);
    }
    if (item.account) {
      const account = document.createElement('p');
      account.className = 'account';
      account.textContent = item.account;
      body.appendChild(account);
    }

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.innerHTML = CLOSE_MARK;
    close.setAttribute('aria-label', '閉じる');
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(toast);
    });

    toast.append(icon, body, close);

    const duration = Number(options.durationMs) || 0;
    if (duration > 0) {
      const progress = document.createElement('div');
      progress.className = 'progress run';
      progress.style.animationDuration = `${duration}ms`;
      progress.addEventListener('animationend', () => dismiss(toast));
      toast.appendChild(progress);
      // アニメーションが動かない環境向けの保険
      toast.__fallbackTimer = setTimeout(() => dismiss(toast), duration + 1500);
    }

    // link の無い項目（設定画面のテスト表示）は閉じるだけにする
    if (!item.link) toast.style.cursor = 'default';
    toast.addEventListener('click', () => {
      if (item.link) {
        try {
          chrome.runtime.sendMessage({ type: 'OPEN_MAIL', link: item.link, id: item.id });
        } catch {
          /* 拡張機能が更新された直後などは無視してよい */
        }
      }
      dismiss(toast);
    });

    state.stack.appendChild(toast);
    state.toasts.add(toast);
    requestAnimationFrame(() => toast.classList.add('in'));
  }

  function dismiss(toast, immediate = false) {
    if (!toast || !state.toasts.has(toast)) return;
    state.toasts.delete(toast);
    clearTimeout(toast.__fallbackTimer);
    if (immediate) {
      toast.remove();
    } else {
      toast.classList.add('out');
      setTimeout(() => toast.remove(), 200);
    }
    setTimeout(() => {
      if (state.toasts.size === 0 && state.host) {
        state.host.remove();
        state.host = null;
      }
    }, 260);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch {
      /* 自動再生が禁止されている場合は鳴らさない */
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'GMAIL_TOAST') show(msg.items, msg.options);
    return false;
  });

  window.__gmailAtomToast = { show };
})();
