// chrome API をモックして service worker の通知フローを通しで確認する。
// service_worker.js は読み込み時にリスナーを登録するので、それを捕まえて呼び出す。
import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
const calls = { toasts: [], badge: [], injected: [] };
let messageCb = null;
let tabs = [{ id: 1, url: 'https://example.com/page', active: true }];
let feedXml = '';

function noopListener() { return { addListener: () => {} }; }

globalThis.chrome = {
  runtime: {
    onInstalled: noopListener(),
    onStartup: noopListener(),
    onMessage: { addListener: (f) => { messageCb = f; } },
    lastError: null
  },
  alarms: { onAlarm: noopListener(), get: async () => undefined, create: async () => {} },
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        for (const k of (typeof keys === 'string' ? [keys] : keys)) {
          if (k in store) out[k] = structuredClone(store[k]);
        }
        return out;
      },
      set: async (obj) => { Object.assign(store, structuredClone(obj)); },
      remove: async (k) => { delete store[k]; }
    },
    onChanged: noopListener()
  },
  action: {
    setBadgeText: async ({ text }) => calls.badge.push(text),
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {}
  },
  tabs: {
    query: async (q) => tabs.filter((t) =>
      (!q.url || t.url.startsWith('https://mail.google.com')) &&
      (q.active === undefined || t.active === q.active)),
    sendMessage: async (_id, msg) => { calls.toasts.push(msg); },
    create: async () => {},
    update: async () => {}
  },
  windows: { update: async () => {} },
  scripting: { executeScript: async ({ target }) => calls.injected.push(target.tabId) }
};

globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => feedXml });

function feed(entries, unread = entries.length) {
  const body = entries.map((e) => `<entry><title>${e.subject}</title><summary>本文</summary>` +
    `<link rel="alternate" href="https://mail.google.com/mail/u/0?message_id=${e.id}"/>` +
    `<issued>2026-09-04T10:00:0${e.id}Z</issued><id>tag:gmail.google.com,2004:${e.id}</id>` +
    `<author><name>${e.from || '差出人'}</name><email>x@example.com</email></author></entry>`).join('');
  return `<feed><title>Gmail - Inbox for taro@gmail.com</title><fullcount>${unread}</fullcount>${body}</feed>`;
}

await import('../src/background/service_worker.js');

const send = (message) => new Promise((resolve) => { messageCb(message, {}, resolve); });
const check = () => send({ type: 'CHECK_NOW' });
const lastItems = () => calls.toasts.at(-1)?.items ?? [];

test('初回は既存の未読を通知しない', async () => {
  feedXml = feed([{ id: 1, subject: '既存A' }, { id: 2, subject: '既存B' }]);
  const res = await check();
  assert.equal(res.newCount, 0);
  assert.equal(calls.toasts.length, 0);
  assert.equal(calls.badge.at(-1), '2', '未読件数がバッジに出る');
});

test('2 回目以降は新着だけを通知する', async () => {
  feedXml = feed([{ id: 3, subject: '会議の日程について', from: '山田 太郎' },
                  { id: 1, subject: '既存A' }, { id: 2, subject: '既存B' }]);
  await check();
  assert.equal(calls.toasts.length, 1);
  assert.deepEqual(lastItems().map((i) => i.subject), ['会議の日程について']);
  assert.equal(lastItems()[0].sender, '山田 太郎');
  assert.equal(lastItems()[0].link, 'https://mail.google.com/mail/u/0?message_id=3');
  assert.equal(calls.injected.at(-1), 1, 'アクティブなタブに注入する');
});

test('同じメールを二度通知しない', async () => {
  const before = calls.toasts.length;
  await check();
  assert.equal(calls.toasts.length, before);
});

test('除外キーワードに一致するメールは通知しない', async () => {
  store.settings = { ...store.settings, muteKeywords: ['広告'] };
  feedXml = feed([{ id: 4, subject: '[広告] セール開催' }, { id: 5, subject: '請求書の送付' }]);
  await check();
  assert.deepEqual(lastItems().map((i) => i.subject), ['請求書の送付']);
});

test('1 回の確認で通知する件数に上限がある', async () => {
  store.settings = { ...store.settings, muteKeywords: [], maxPerCheck: 2 };
  feedXml = feed([6, 7, 8, 9].map((id) => ({ id, subject: `まとめて届いた ${id}` })));
  await check();
  assert.equal(lastItems().length, 2);
  assert.deepEqual(lastItems().map((i) => i.subject), ['まとめて届いた 8', 'まとめて届いた 9'],
    '新しい方を残す');
});

test('Gmail を見ている間はトーストを出さない', async () => {
  tabs = [{ id: 9, url: 'https://mail.google.com/mail/u/0/#inbox', active: true }];
  feedXml = feed([{ id: 10, subject: 'Gmail 表示中の新着' }]);
  const before = calls.toasts.length;
  await check();
  assert.equal(calls.toasts.length, before);
  tabs = [{ id: 1, url: 'https://example.com/page', active: true }];
});

test('ポップアップ用の一覧と状態を保存する', async () => {
  const state = await send({ type: 'GET_STATE' });
  assert.ok(state.latest.length > 0);
  assert.equal(state.latest[0].subject, 'Gmail 表示中の新着', '新しい順に並ぶ');
  assert.ok(!state.latest.some((i) => i.subject.includes('広告')), '除外分は一覧にも出ない');
  assert.equal(state.status.accounts[0].address, 'taro@gmail.com');
});

test('ログインしていないときはエラーとして扱う', async () => {
  feedXml = '<html><body>ServiceLogin</body></html>';
  const res = await check();
  assert.equal(res.accounts[0].ok, false);
  assert.equal(res.accounts[0].code, 'signed-out');
});

test('通知がオフのときは確認もしない', async () => {
  store.settings = { ...store.settings, enabled: false };
  const res = await check();
  assert.equal(res.disabled, true);
  assert.equal(calls.badge.at(-1), '');
});
