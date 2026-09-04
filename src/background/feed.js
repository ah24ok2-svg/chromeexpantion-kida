// Gmail の Atom フィード（https://mail.google.com/mail/u/<N>/feed/atom）を
// ログイン済みの Cookie で取得して解析する。
//
// MV3 の service worker には DOMParser が無いため、XML は正規表現で読む。
// フィードの構造は固定（entry の中に title / summary / link / issued / author）なので
// 軽量なパーサで十分に扱える。

export class FeedError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'signed-out' | 'network' | 'http' | 'parse'
  }
}

export function feedUrl(accountIndex) {
  return `https://mail.google.com/mail/u/${accountIndex}/feed/atom`;
}

export async function fetchFeed(accountIndex, { signal } = {}) {
  let res;
  try {
    res = await fetch(feedUrl(accountIndex), {
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal
    });
  } catch (e) {
    throw new FeedError('network', `ネットワークエラー: ${e.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new FeedError('signed-out', 'Gmail にログインしていないか、このアカウント番号は使われていません。');
  }
  if (!res.ok) {
    throw new FeedError('http', `Gmail が HTTP ${res.status} を返しました。`);
  }

  const text = await res.text();
  // 未ログイン時はログインページの HTML が返る
  if (!/<feed[\s>]/i.test(text)) {
    if (/accounts\.google\.com|ServiceLogin|<html/i.test(text)) {
      throw new FeedError('signed-out', 'Gmail にログインしていないか、このアカウント番号は使われていません。');
    }
    throw new FeedError('parse', 'フィードの形式が想定と違います。');
  }
  return parseFeed(text, accountIndex);
}

export function parseFeed(xml, accountIndex) {
  const head = xml.split(/<entry[\s>]/i)[0];
  const title = tagText(head, 'title'); // 例: "Gmail - Inbox for you@gmail.com"
  const emailMatch = title.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const fullcount = Number(tagText(head, 'fullcount')) || 0;

  const entries = [];
  const re = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const author = firstTagBlock(block, 'author') || '';
    const rawId = tagText(block, 'id');
    const link = attr(block, 'link', 'href');
    entries.push({
      // フィードの id は "tag:gmail.google.com,2004:1808..." 形式。
      // 万一空でもリンクや件名から安定したキーを作れるようにしておく。
      id: rawId || link || `${tagText(block, 'issued')}|${tagText(block, 'title')}`,
      account: accountIndex,
      subject: tagText(block, 'title'),
      snippet: tagText(block, 'summary'),
      senderName: tagText(author, 'name'),
      senderEmail: tagText(author, 'email'),
      link: link || `https://mail.google.com/mail/u/${accountIndex}/`,
      issued: tagText(block, 'issued') || tagText(block, 'modified')
    });
  }

  return {
    account: accountIndex,
    address: emailMatch ? emailMatch[0] : '',
    unread: fullcount,
    entries
  };
}

function firstTagBlock(source, tag) {
  const m = source.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

function tagText(source, tag) {
  if (!source) return '';
  // <title/> のような自己完結タグは空文字として扱う
  if (new RegExp(`<${tag}\\b[^>]*/>`, 'i').test(source) && !firstTagBlock(source, tag)) return '';
  return decodeXml(firstTagBlock(source, tag)).trim();
}

function attr(source, tag, name) {
  const m = source.match(new RegExp(`<${tag}\\b[^>]*\\b${name}=["']([^"']*)["']`, 'i'));
  return m ? decodeXml(m[1]) : '';
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
};

export function decodeXml(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named === undefined ? whole : named;
    });
}

function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
