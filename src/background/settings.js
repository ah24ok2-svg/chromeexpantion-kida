// 設定の既定値と読み書き。MV3 の service worker は随時停止するため、
// 状態はすべて chrome.storage.local に置く。

export const DEFAULT_SETTINGS = {
  enabled: true,
  // 監視する Gmail アカウントの番号（mail.google.com/mail/u/<N> の N）
  accounts: [0],
  // ポーリング間隔（分）。chrome.alarms の最小値は 1 分。
  intervalMinutes: 1,
  // トーストの表示位置
  position: 'bottom-right', // top-left | top-right | bottom-left | bottom-right
  // 自動で消えるまでの秒数（0 で手動で閉じるまで残す）
  durationSec: 8,
  // 同時に画面に出すトーストの最大数
  maxToasts: 3,
  // 1 回のチェックで通知する最大件数（大量受信時の画面占有を防ぐ）
  maxPerCheck: 5,
  // 表示項目
  showSender: true,
  showSnippet: false,
  showAccount: 'auto', // auto（複数アカウント時のみ） | always | never
  // 件名・差出人にこれらの語を含むメールは通知しない（1 行 1 語）
  muteKeywords: [],
  // 通知時に短いビープを鳴らす
  sound: false,
  // Gmail のタブを開いているときは通知しない
  skipWhenGmailActive: true,
  // 未読件数をツールバーのバッジに表示する
  badge: true
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // 壊れた値が入っていても動くように最低限の正規化をする
  if (!Array.isArray(merged.accounts) || merged.accounts.length === 0) {
    merged.accounts = [0];
  }
  merged.accounts = [...new Set(merged.accounts.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 20))];
  if (merged.accounts.length === 0) merged.accounts = [0];
  merged.intervalMinutes = clamp(Number(merged.intervalMinutes) || 1, 1, 60);
  merged.durationSec = clamp(Number(merged.durationSec) || 0, 0, 120);
  merged.maxToasts = clamp(Number(merged.maxToasts) || 3, 1, 10);
  merged.maxPerCheck = clamp(Number(merged.maxPerCheck) || 5, 1, 20);
  if (!Array.isArray(merged.muteKeywords)) merged.muteKeywords = [];
  return merged;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
