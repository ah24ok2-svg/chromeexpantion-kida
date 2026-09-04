import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, decodeXml, feedUrl } from '../src/background/feed.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for taro@gmail.com</title>
<tagline>New messages in your Gmail Inbox</tagline><fullcount>3</fullcount>
<link rel="alternate" href="https://mail.google.com/mail/u/0" type="text/html" />
<modified>2026-09-04T11:00:00Z</modified>
<entry><title>会議の日程について &amp; 資料</title><summary>来週の&lt;会議&gt;の件で...</summary>
<link rel="alternate" href="https://mail.google.com/mail/u/0?message_id=18f1&amp;view=conv" type="text/html" />
<issued>2026-09-04T10:59:00Z</issued>
<id>tag:gmail.google.com,2004:1001</id>
<author><name>山田 太郎</name><email>yamada@example.com</email></author></entry>
<entry><title/><summary>件名なし</summary>
<link rel="alternate" href="https://mail.google.com/mail/u/0?message_id=18f2" type="text/html" />
<issued>2026-09-04T10:30:00Z</issued><id>tag:gmail.google.com,2004:1002</id>
<author><name></name><email>noreply@example.com</email></author></entry>
</feed>`;

test('フィードのヘッダを読む', () => {
  const feed = parseFeed(SAMPLE, 0);
  assert.equal(feed.address, 'taro@gmail.com');
  assert.equal(feed.unread, 3);
  assert.equal(feed.account, 0);
  assert.equal(feed.entries.length, 2);
});

test('entry の各項目を読む', () => {
  const [first] = parseFeed(SAMPLE, 0).entries;
  assert.equal(first.subject, '会議の日程について & 資料');
  assert.equal(first.snippet, '来週の<会議>の件で...');
  assert.equal(first.senderName, '山田 太郎');
  assert.equal(first.senderEmail, 'yamada@example.com');
  assert.equal(first.id, 'tag:gmail.google.com,2004:1001');
  assert.equal(first.link, 'https://mail.google.com/mail/u/0?message_id=18f1&view=conv');
  assert.equal(first.issued, '2026-09-04T10:59:00Z');
});

test('自己完結タグの件名は空文字になる', () => {
  const second = parseFeed(SAMPLE, 0).entries[1];
  assert.equal(second.subject, '');
  assert.equal(second.senderName, '');
  assert.equal(second.senderEmail, 'noreply@example.com');
});

test('entry が無いフィードも壊れない', () => {
  const feed = parseFeed('<feed><title>Gmail - Inbox for a@b.com</title><fullcount>0</fullcount></feed>', 1);
  assert.equal(feed.unread, 0);
  assert.equal(feed.entries.length, 0);
  assert.equal(feed.address, 'a@b.com');
});

test('id が無い entry でも安定したキーを作る', () => {
  const xml = '<feed><fullcount>1</fullcount><entry><title>件名</title>' +
    '<link rel="alternate" href="https://mail.google.com/mail/u/0?message_id=zz"/>' +
    '<issued>2026-09-04T10:00:00Z</issued></entry></feed>';
  const [entry] = parseFeed(xml, 0).entries;
  assert.equal(entry.id, 'https://mail.google.com/mail/u/0?message_id=zz');
});

test('XML エンティティを復元する', () => {
  assert.equal(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;'), `a & b <c> "d" 'e'`);
  assert.equal(decodeXml('&#x5E83;&#x544A;'), '広告');
  assert.equal(decodeXml('&unknown;'), '&unknown;', '知らない実体はそのまま残す');
  assert.equal(decodeXml(''), '');
});

test('アカウント番号ごとの URL', () => {
  assert.equal(feedUrl(0), 'https://mail.google.com/mail/u/0/feed/atom');
  assert.equal(feedUrl(2), 'https://mail.google.com/mail/u/2/feed/atom');
});
