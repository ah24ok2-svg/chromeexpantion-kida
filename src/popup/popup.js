const el = {
  status: document.getElementById('status'),
  enabled: document.getElementById('enabled'),
  accounts: document.getElementById('accounts'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  check: document.getElementById('check'),
  options: document.getElementById('options'),
  clear: document.getElementById('clear')
};

let state = { settings: null, status: {}, latest: [] };

init();

async function init() {
  state = await send({ type: 'GET_STATE' });
  render();

  el.enabled.addEventListener('change', async () => {
    const settings = { ...state.settings, enabled: el.enabled.checked };
    await chrome.storage.local.set({ settings });
    state.settings = settings;
    await send({ type: 'SETTINGS_CHANGED' });
    if (settings.enabled) check();
    else render();
  });

  el.check.addEventListener('click', check);
  el.clear.addEventListener('click', async () => {
    await send({ type: 'MARK_ALL_SEEN' });
    state.latest = [];
    renderList();
  });
  el.options.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function check() {
  el.check.disabled = true;
  el.check.textContent = '確認中…';
  try {
    await send({ type: 'CHECK_NOW' });
    state = await send({ type: 'GET_STATE' });
    render();
  } finally {
    el.check.disabled = false;
    el.check.textContent = '今すぐ確認';
  }
}

function render() {
  el.enabled.checked = Boolean(state.settings?.enabled);
  renderStatus();
  renderAccounts();
  renderList();
}

function renderStatus() {
  const { status, settings } = state;
  if (!settings?.enabled) {
    el.status.textContent = '通知はオフです';
    el.status.classList.remove('warn');
    return;
  }
  const accounts = status.accounts || [];
  const failed = accounts.filter((a) => !a.ok);
  if (failed.length > 0 && failed.length === accounts.length) {
    el.status.textContent = failed[0].code === 'signed-out'
      ? 'Gmail にログインしてください'
      : `確認できません（${failed[0].message || 'エラー'}）`;
    el.status.classList.add('warn');
    return;
  }
  el.status.classList.remove('warn');
  const unread = Number(status.unreadTotal) || 0;
  const when = status.lastCheck ? `・${relativeTime(status.lastCheck)}に確認` : '';
  el.status.textContent = `未読 ${unread} 件${when}`;
}

function renderAccounts() {
  const accounts = state.status?.accounts || [];
  if (accounts.length <= 1) {
    el.accounts.hidden = true;
    el.accounts.textContent = '';
    return;
  }
  el.accounts.hidden = false;
  el.accounts.textContent = '';
  for (const a of accounts) {
    const row = document.createElement('div');
    row.className = `account-row${a.ok ? '' : ' error'}`;
    const addr = document.createElement('span');
    addr.className = 'addr';
    addr.textContent = a.address || `アカウント ${a.account}`;
    const right = document.createElement('span');
    right.textContent = a.ok ? `${a.unread}` : (a.code === 'signed-out' ? '未ログイン' : 'エラー');
    row.append(addr, right);
    el.accounts.appendChild(row);
  }
}

function renderList() {
  const items = state.latest || [];
  el.list.textContent = '';
  el.empty.hidden = items.length > 0;
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'item';
    const button = document.createElement('button');
    button.type = 'button';

    const subject = document.createElement('p');
    subject.className = 'subject';
    subject.textContent = item.subject || '(件名なし)';

    const meta = document.createElement('p');
    meta.className = 'meta';
    const sender = document.createElement('span');
    sender.className = 'sender';
    sender.textContent = item.sender || item.address || '';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = relativeTime(Date.parse(item.issued) || item.receivedAt);
    meta.append(sender, time);

    button.append(subject, meta);
    button.addEventListener('click', async () => {
      await send({ type: 'OPEN_MAIL', link: item.link, id: item.id });
      window.close();
    });
    li.appendChild(button);
    el.list.appendChild(li);
  }
}

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min} 分前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 時間前`;
  return `${Math.round(hour / 24)} 日前`;
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      void chrome.runtime.lastError;
      resolve(res || {});
    });
  });
}
