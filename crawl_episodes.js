// Polite crawler for "5 Minutes in Church History" with Stephen Nichols (Ligonier Ministries).
// 1. Episode pages from Ligonier's sitemap -> title, date, MP3 URL, full transcript.
// 2. Libsyn RSS feed -> any audio-only episodes missing from the sitemap.
// 3. Saves transcripts (.txt) and MP3s to archive/, then builds a searchable episodes.html.
// Usage: node crawl_episodes.js [--no-audio]
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const SITEMAP = 'https://learn.ligonier.org/sitemap-podcasts.xml';
const SHOW_PATH = '/podcasts/5-minutes-in-church-history-with-stephen-nichols/';
const FEED = 'https://5minutesinchurchhistory.libsyn.com/rss';
const CACHE_FILE = path.join(__dirname, 'episodes_cache.json');
const OUTPUT_HTML = path.join(__dirname, 'episodes.html'); // local copy, plays downloaded MP3s
const OUTPUT_SITE = path.join(__dirname, 'episodes_site.html'); // publishable copy, streams MP3s from Libsyn
const ARCHIVE = path.join(__dirname, 'archive');
const AUDIO_DIR = path.join(ARCHIVE, 'audio');
const TRANSCRIPT_DIR = path.join(ARCHIVE, 'transcripts');
const DELAY_MS = 1000; // polite delay between requests
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) 5mch-episode-archiver/1.0' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Transcripts mix HTML tags and markdown emphasis; reduce to plain text.
function cleanText(s) {
  return (s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*+([^*\n]+)\*+/g, '$1')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Episode pages are Remix apps; the episode record sits in window.__remixContext.
function parseEpisode(html, url) {
  const m = html.match(/window\.__remixContext = (\{.*?\});\s*<\/script>/s);
  if (!m) throw new Error('no __remixContext');
  const ep = JSON.parse(m[1]).state?.loaderData?.['routes/podcasts.$show.$episode']?.episode;
  if (!ep || !ep.slug || !ep.date) throw new Error('no episode data');
  return {
    slug: ep.slug,
    title: cleanText(ep.title),
    date: ep.date.slice(0, 10),
    description: cleanText(ep.description),
    mp3: ep.mediaUrl || '',
    transcript: cleanText(ep.transcript),
    url,
  };
}

function parseFeed(xml) {
  return xml.split('<item>').slice(1).map((item) => {
    const tag = (t) => (item.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)) || [])[1] || '';
    const mp3 = (item.match(/<enclosure[^>]*url="([^"]+)"/) || [])[1] || '';
    return {
      title: cleanText(tag('title')),
      date: new Date(tag('pubDate')).toISOString().slice(0, 10),
      description: cleanText(tag('description')).replace(/\s*Read the transcript:[\s\S]*$/, ''),
      mp3,
    };
  });
}

const mp3Key = (u) => (u || '').split('?')[0].split('/').pop().toLowerCase();
const baseName = (e) => `${e.date}-${e.slug}`;

async function crawlPages(cache) {
  const xml = await get(SITEMAP);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter((u) => u.includes(SHOW_PATH));
  const todo = urls.filter((u) => !cache[u.split('/').pop()]);
  console.log(`Sitemap: ${urls.length} episode pages, ${todo.length} not cached yet.`);
  let failed = 0;
  for (const [i, url] of todo.entries()) {
    try {
      const ep = parseEpisode(await get(url), url);
      cache[ep.slug] = ep;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      console.log(`[${i + 1}/${todo.length}] ${ep.date} ${ep.title}`);
    } catch (err) {
      failed++;
      console.error(`[${i + 1}/${todo.length}] FAILED ${url}: ${err.message}`); // retried on next run
    }
    await sleep(DELAY_MS);
  }
  if (failed) console.log(`${failed} pages failed; re-run to retry them.`);
}

// Feed items whose MP3 is not on any episode page become audio-only episodes.
async function addFeedOnly(episodes) {
  const known = new Set(episodes.map((e) => mp3Key(e.mp3)));
  const extras = parseFeed(await get(FEED))
    .filter((f) => f.mp3 && !known.has(mp3Key(f.mp3)))
    .map((f) => ({ ...f, slug: mp3Key(f.mp3).replace(/\.mp3$/, ''), transcript: '', url: '' }));
  console.log(`Feed: ${extras.length} audio-only episodes not on Ligonier's site.`);
  return episodes.concat(extras);
}

function writeTranscripts(episodes) {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  for (const e of episodes) {
    if (!e.transcript) continue;
    const header = `${e.title}\n${e.date}\nAudio: ${e.mp3}\nSource: ${e.url}\n\n`;
    fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${baseName(e)}.txt`), header + e.transcript + '\n');
  }
}

async function downloadAudio(episodes) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const todo = episodes.filter((e) => e.mp3 && !fs.existsSync(path.join(AUDIO_DIR, `${baseName(e)}.mp3`)));
  console.log(`Audio: ${todo.length} MP3s to download.`);
  for (const [i, e] of todo.entries()) {
    const file = path.join(AUDIO_DIR, `${baseName(e)}.mp3`);
    try {
      const res = await fetch(e.mp3, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file + '.part'));
      fs.renameSync(file + '.part', file); // only complete files get the .mp3 name
      console.log(`[${i + 1}/${todo.length}] ${path.basename(file)}`);
    } catch (err) {
      fs.rmSync(file + '.part', { force: true });
      console.error(`[${i + 1}/${todo.length}] FAILED ${e.mp3}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
}

function generateHtml(episodes) {
  const data = episodes.map((e) => {
    const b = baseName(e);
    return {
      d: e.date, t: e.title, s: e.description, x: e.transcript, m: e.mp3, u: e.url,
      a: fs.existsSync(path.join(AUDIO_DIR, `${b}.mp3`)) ? `archive/audio/${b}.mp3` : '',
      f: e.transcript ? `archive/transcripts/${b}.txt` : '',
    };
  });
  const page = PAGE_TEMPLATE.replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
  fs.writeFileSync(OUTPUT_SITE, page);
  fs.writeFileSync(OUTPUT_HTML, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${page}\n</body></html>\n`);
  console.log(`Wrote ${path.basename(OUTPUT_HTML)} and ${path.basename(OUTPUT_SITE)} (${data.length} episodes).`);
}

async function main() {
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
  await crawlPages(cache);
  let episodes = await addFeedOnly(Object.values(cache));
  episodes.sort((a, b) => b.date.localeCompare(a.date));
  writeTranscripts(episodes);
  generateHtml(episodes);
  if (process.argv.includes('--no-audio')) return;
  await downloadAudio(episodes);
  generateHtml(episodes); // again, so the local page points at the new MP3s
}

const PAGE_TEMPLATE = fs.readFileSync(path.join(__dirname, 'episodes_template.html'), 'utf8');

module.exports = { cleanText, parseEpisode, parseFeed, mp3Key };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
