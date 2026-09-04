const FIELDS = {
  enabled: 'checkbox',
  intervalMinutes: 'number',
  accounts: 'accounts',
  position: 'text',
  durationSec: 'number',
  maxToasts: 'number',
  maxPerCheck: 'number',
  showSender: 'checkbox',
  showSnippet: 'checkbox',
  showAccount: 'text',
  sound: 'checkbox',
  skipWhenGmailActive: 'checkbox',
  muteKeywords: 'lines',
  badge: 'checkbox'
};

const saved = document.getElementById('saved');
let settings = null;

init();

async function init() {
  const state = await send({ type: 'GET_STATE' });
  settings = state.settings;
  fill(settings);

  for (const id of Object.keys(FIELDS)) {
    const node = document.getElementById(id);
    if (!node) continue;
    node.addEventListener('change', save);
    if (node.tagName === 'TEXTAREA' || node.type === 'text' || node.type === 'number') {
      node.addEventListener('blur', save);
    }
  }

  document.getElementById('test').addEventListener('click', showTestToast);

  document.getElementById('check').addEventListener('click', async () => {
    flash('確認中…', 0);
    const res = await send({ type: 'CHECK_NOW' });
    if (res.disabled) flash('通知がオフになっています');
    else flash(`確認しました（未読 ${res.unreadTotal ?? 0} 件）`);
  });

  document.getElementById('reset').addEventListener('click', async () => {
    await chrome.storage.local.remove('settings');
    const fresh = await send({ type: 'GET_STATE' });
    settings = fresh.settings;
    fill(settings);
    await send({ type: 'SETTINGS_CHANGED' });
    flash('既定に戻しました');
  });
}

function fill(s) {
  for (const [id, kind] of Object.entries(FIELDS)) {
    const node = document.getElementById(id);
    if (!node) continue;
    switch (kind) {
      case 'checkbox': node.checked = Boolean(s[id]); break;
      case 'accounts': node.value = (s.accounts || [0]).join(','); break;
      case 'lines': node.value = (s.muteKeywords || []).join('\n'); break;
      default: node.value = String(s[id]);
    }
  }
}

async function save() {
  const patch = {};
  for (const [id, kind] of Object.entries(FIELDS)) {
    const node = document.getElementById(id);
    if (!node) continue;
    switch (kind) {
      case 'checkbox':
        patch[id] = node.checked;
        break;
      case 'number':
        patch[id] = Number(node.value);
        break;
      case 'accounts':
        patch.accounts = node.value
          .split(/[,\s]+/)
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < 20);
        if (patch.accounts.length === 0) patch.accounts = [0];
        break;
      case 'lines':
        patch.muteKeywords = node.value.split('\n').map((v) => v.trim()).filter(Boolean);
        break;
      default:
        patch[id] = node.value;
    }
  }
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  const state = await send({ type: 'GET_STATE' });
  settings = state.settings;
  fill(settings); // 範囲外の値が丸められた結果を画面に反映する
  await send({ type: 'SETTINGS_CHANGED' });
  flash('保存しました');
}

// テスト表示はこの設定ページ自身に描画する。実際の新着トーストは
// 見ているウェブページに出るが、設定ページは chrome-extension:// のため
// スクリプトを注入できず、押しても何も出ないように見えてしまう。
function showTestToast() {
  const item = {
    id: 'test',
    subject: 'テスト表示：件名はこのように出ます',
    sender: settings.showSender ? 'Gmail 新着トースト' : '',
    snippet: settings.showSnippet ? 'これは設定確認用のテスト表示です。実際の新着では本文の冒頭が入ります。' : '',
    account: settings.showAccount === 'always' ? 'you@example.com' : '',
    link: null // クリックしても Gmail は開かない
  };
  window.__gmailAtomToast.show([item], {
    position: settings.position,
    durationMs: settings.durationSec * 1000,
    maxToasts: settings.maxToasts,
    sound: settings.sound
  });
}

let flashTimer = null;
function flash(text, hideAfter = 2000) {
  saved.textContent = text;
  clearTimeout(flashTimer);
  if (hideAfter > 0) {
    flashTimer = setTimeout(() => { saved.textContent = ''; }, hideAfter);
  }
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      void chrome.runtime.lastError;
      resolve(res || {});
    });
  });
}
