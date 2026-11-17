const test = require('node:test');
const assert = require('node:assert');
const { cleanText, parseEpisode, parseFeed, mp3Key } = require('./crawl_episodes');

test('parseEpisode reads the episode out of __remixContext', () => {
  const ctx = { state: { loaderData: { 'routes/podcasts.$show.$episode': { episode: {
    date: '2013-08-21T00:00:00.000Z', title: 'Lost Letter', slug: 'lost-letter', description: '<p>Calvin</p>',
    mediaUrl: 'https://x/2_5MCH.mp3', transcript: 'A book on Calvin, <em>John Calvin</em> and *Institutes*.\n\n\n\nNext.',
  } } } } };
  const html = `<script>window.__remixContext = ${JSON.stringify(ctx)};</script>`;
  assert.deepStrictEqual(parseEpisode(html, 'u'), {
    slug: 'lost-letter', title: 'Lost Letter', date: '2013-08-21', description: 'Calvin',
    mp3: 'https://x/2_5MCH.mp3', transcript: 'A book on Calvin, John Calvin and Institutes.\n\nNext.', url: 'u',
  });
});

test('parseEpisode throws on a page without episode data', () => {
  assert.throws(() => parseEpisode('<html></html>', 'u'), /no __remixContext/);
});

test('parseFeed reads title, date, mp3 and trims the transcript link', () => {
  const xml = `<rss><item><title>Ep &amp; One</title><pubDate>Wed, 14 Aug 2013 04:01:00 +0000</pubDate>
    <description><![CDATA[<p>Intro.</p> <p>Read the transcript: <a href="x">x</a></p>]]></description>
    <enclosure url="https://t/5mch.mp3?dest-id=1" length="1" type="audio/mpeg" /></item></rss>`;
  assert.deepStrictEqual(parseFeed(xml), [{ title: 'Ep & One', date: '2013-08-14', description: 'Intro.', mp3: 'https://t/5mch.mp3?dest-id=1' }]);
});

test('mp3Key matches podtrac and direct URLs for the same file', () => {
  assert.strictEqual(mp3Key('https://dts.podtrac.com/redirect.mp3/traffic.libsyn.com/secure/a/5MCH20250813.mp3?dest-id=9'), '5mch20250813.mp3');
  assert.strictEqual(cleanText('a &amp; b'), 'a & b');
});
