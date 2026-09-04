import { getSettings, DEFAULT_SETTINGS } from './settings.js';
import { fetchFeed, FeedError } from './feed.js';

const ALARM_NAME = 'gmail-poll';
const SEEN_LIMIT = 300;   // アカウントごとに覚えておく既知メール ID の数
const LATEST_LIMIT = 30;  // ポップアップに出す一覧の件数

// ---------------------------------------------------------------- ライフサイクル

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureAlarm();
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  poll({ reason: 'installed' });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  poll({ reason: 'startup' });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) poll({ reason: 'alarm' });
});

async function ensureAlarm() {
  const settings = await getSettings();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing && existing.periodInMinutes === settings.intervalMinutes) return;
  await chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: settings.intervalMinutes,
    delayInMinutes: settings.intervalMinutes
  });
}

// ---------------------------------------------------------------- メッセージ

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'CHECK_NOW':
      poll({ reason: 'manual' }).then((r) => sendResponse(r), (e) => sendResponse({ error: String(e) }));
      return true;

    case 'GET_STATE':
      getState().then(sendResponse);
      return true;

    case 'SETTINGS_CHANGED':
      (async () => {
        await ensureAlarm();
        await refreshBadge();
        sendResponse({ ok: true });
      })();
      return true;

    case 'OPEN_MAIL':
      openMail(msg.link, msg.id).then(() => sendResponse({ ok: true }));
      return true;

    case 'MARK_ALL_SEEN':
      markAllSeen().then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});

// ---------------------------------------------------------------- ポーリング本体

let polling = false;

async function poll({ reason } = {}) {
  if (polling) return { skipped: 'すでに確認中です' };
  polling = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled) {
      await chrome.action.setBadgeText({ text: '' });
      await saveStatus({ lastCheck: Date.now(), disabled: true, accounts: [] });
      return { disabled: true };
    }

    const { seen = {} } = await chrome.storage.local.get('seen');
    const accountStatus = [];
    const fresh = [];
    let unreadTotal = 0;

    for (const account of settings.accounts) {
      try {
        const feed = await fetchFeed(account);
        unreadTotal += feed.unread;

        const key = String(account);
        const record = seen[key] || { ids: [], initialized: false };
        const knownIds = new Set(record.ids);

        const currentIds = feed.entries.map((e) => e.id);
        const newEntries = feed.entries.filter((e) => !knownIds.has(e.id));

        if (record.initialized) {
          for (const entry of newEntries) {
            fresh.push({ ...entry, address: feed.address });
          }
        }

        seen[key] = {
          initialized: true,
          // 現在の未読 + 直近に見た ID を、上限まで新しい順で保持する
          ids: dedupe([...currentIds, ...record.ids]).slice(0, SEEN_LIMIT)
        };

        accountStatus.push({ account, address: feed.address, unread: feed.unread, ok: true });
      } catch (e) {
        const code = e instanceof FeedError ? e.code : 'unknown';
        accountStatus.push({ account, ok: false, code, message: e.message });
      }
    }

    await chrome.storage.local.set({ seen });

    // 新しいものが画面の隅に近い側へ積まれるよう、古い順に並べる
    fresh.sort((a, b) => issuedAt(a) - issuedAt(b));
    const wanted = fresh.filter((e) => !isMuted(e, settings));
    // トーストは 1 回あたりの上限まで、ポップアップの一覧には除外分以外をすべて残す
    const notify = wanted.slice(-settings.maxPerCheck);

    await saveLatest(wanted, accountStatus);
    await saveStatus({
      lastCheck: Date.now(),
      accounts: accountStatus,
      unreadTotal,
      newCount: wanted.length
    });
    await refreshBadge();

    if (notify.length > 0) {
      await showToasts(notify, settings);
    }

    return { newCount: notify.length, unreadTotal, accounts: accountStatus, reason };
  } finally {
    polling = false;
  }
}

function issuedAt(entry) {
  return Date.parse(entry.issued) || 0;
}

function isMuted(entry, settings) {
  const words = (settings.muteKeywords || []).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return false;
  const haystack = `${entry.subject}\n${entry.senderName}\n${entry.senderEmail}`.toLowerCase();
  return words.some((w) => haystack.includes(w));
}

function dedupe(list) {
  return [...new Set(list)];
}

// ---------------------------------------------------------------- トースト表示

async function showToasts(entries, settings) {
  const tab = await pickTargetTab(settings);
  if (!tab) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/toast.js']
    });
  } catch (e) {
    // chrome:// や Chrome ウェブストアなど注入できないページ
    console.warn('[Gmail 新着トースト] 注入できませんでした:', e.message);
    return false;
  }

  const showAccount = settings.showAccount === 'always'
    || (settings.showAccount === 'auto' && settings.accounts.length > 1);

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'GMAIL_TOAST',
      items: entries.map((e) => ({
        id: e.id,
        subject: e.subject || '(件名なし)',
        sender: settings.showSender ? (e.senderName || e.senderEmail || '') : '',
        snippet: settings.showSnippet ? e.snippet : '',
        account: showAccount ? (e.address || `アカウント ${e.account}`) : '',
        link: e.link
      })),
      options: {
        position: settings.position,
        durationMs: settings.durationSec * 1000,
        maxToasts: settings.maxToasts,
        sound: settings.sound
      }
    });
    return true;
  } catch (e) {
    console.warn('[Gmail 新着トースト] タブに送れませんでした:', e.message);
    return false;
  }
}

async function pickTargetTab(settings) {
  const candidates = [];
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  candidates.push(...focused);
  const others = await chrome.tabs.query({ active: true });
  candidates.push(...others);

  for (const tab of candidates) {
    if (!tab || !tab.id || !tab.url) continue;
    if (!/^https?:\/\//i.test(tab.url)) continue;
    if (/^https:\/\/chromewebstore\.google\.com/i.test(tab.url)) continue;
    if (settings.skipWhenGmailActive && /^https:\/\/mail\.google\.com\//i.test(tab.url)) {
      // Gmail を見ている最中は Gmail 自身の表示に任せる
      return null;
    }
    return tab;
  }
  return null;
}

// ---------------------------------------------------------------- 状態の保存

async function saveLatest(fresh, accountStatus) {
  const { latest = [] } = await chrome.storage.local.get('latest');
  const addressOf = new Map(accountStatus.map((a) => [a.account, a.address]));
  const incoming = fresh.map((e) => ({
    id: e.id,
    subject: e.subject || '(件名なし)',
    sender: e.senderName || e.senderEmail || '',
    snippet: e.snippet || '',
    account: e.account,
    address: e.address || addressOf.get(e.account) || '',
    link: e.link,
    issued: e.issued,
    receivedAt: Date.now()
  }));
  if (incoming.length === 0) return;
  const merged = [...incoming.reverse(), ...latest];
  const seenIds = new Set();
  const unique = merged.filter((item) => {
    if (seenIds.has(item.id)) return false;
    seenIds.add(item.id);
    return true;
  });
  await chrome.storage.local.set({ latest: unique.slice(0, LATEST_LIMIT) });
}

async function saveStatus(status) {
  const { status: prev = {} } = await chrome.storage.local.get('status');
  await chrome.storage.local.set({ status: { ...prev, ...status } });
}

async function getState() {
  const [settings, stored] = await Promise.all([
    getSettings(),
    chrome.storage.local.get(['status', 'latest'])
  ]);
  return {
    settings,
    status: stored.status || {},
    latest: stored.latest || []
  };
}

async function refreshBadge() {
  const settings = await getSettings();
  const { status = {} } = await chrome.storage.local.get('status');
  if (!settings.enabled || !settings.badge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const total = Number(status.unreadTotal) || 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: total > 0 ? (total > 99 ? '99+' : String(total)) : '' });
  const failed = (status.accounts || []).filter((a) => !a.ok);
  await chrome.action.setTitle({
    title: failed.length > 0
      ? `Gmail 新着トースト — ${failed.length} 件のアカウントを確認できません`
      : `Gmail 新着トースト — 未読 ${total} 件`
  });
}

async function openMail(link, id) {
  const url = typeof link === 'string' && /^https:\/\/mail\.google\.com\//.test(link)
    ? link
    : 'https://mail.google.com/mail/u/0/';
  const existing = await chrome.tabs.query({ url: 'https://mail.google.com/*' });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { url, active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  if (id) {
    const { latest = [] } = await chrome.storage.local.get('latest');
    await chrome.storage.local.set({ latest: latest.filter((item) => item.id !== id) });
  }
}

async function markAllSeen() {
  await chrome.storage.local.set({ latest: [] });
}

// 設定変更時にアラーム間隔とバッジを追従させる
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  ensureAlarm();
  refreshBadge();
});
