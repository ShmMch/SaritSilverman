const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = process.env.SITE_URL.replace(/\/$/, '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200');
const WAIT_MS = parseInt(process.env.WAIT_MS || '4000'); // הוגדל ל-4 שניות

if (!BASE_URL) {
  console.error('❌  SITE_URL environment variable is required');
  process.exit(1);
}

const baseUrl = new URL(BASE_URL);
const baseOrigin = baseUrl.origin;
const basePath = baseUrl.pathname;

const visited = new Set();
const queue = [BASE_URL];
let pageCount = 0;

function decodePath(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

function toSitePath(urlPathname) {
  let p = decodePath(urlPathname);
  if (p.startsWith(basePath)) p = p.slice(basePath.length);
  if (!p || p === '/') return '/';
  return p.startsWith('/') ? p : '/' + p;
}

function sitePathToFile(sitePath) {
  if (sitePath === '/') return '/index.html';
  if (!path.extname(sitePath)) return sitePath.replace(/\/$/, '') + '/index.html';
  return sitePath;
}

function relativeHref(fromSitePath, targetSitePath) {
  const fromFile = sitePathToFile(fromSitePath === '/' ? '/' : fromSitePath);
  const targetFile = sitePathToFile(targetSitePath);
  const fromParts = fromFile.split('/').filter(Boolean);
  const targetParts = targetFile.split('/').filter(Boolean);
  fromParts.pop();
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) common++;
  const ups = fromParts.length - common;
  const downs = targetParts.slice(common);
  const rel = [...Array(ups).fill('..'), ...downs].join('/');
  return rel || './index.html';
}

function urlToFilePath(urlStr) {
  const u = new URL(urlStr);
  const sitePath = toSitePath(u.pathname);
  const filePart = sitePathToFile(sitePath);
  const safe = filePart.replace(/[?#]/g, '_');
  return path.join(OUTPUT_DIR, safe);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve) => {
    if (fs.existsSync(destPath)) return resolve();
    ensureDir(destPath);
    const proto = fileUrl.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, destPath).then(resolve);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', () => { file.close(); resolve(); });
  });
}

function rewriteHtml(html, pageUrl) {
  const fromSitePath = toSitePath(new URL(pageUrl).pathname);
  return html.replace(
    /(href|src|action)="(https?:\/\/[^"]+)"/g,
    (match, attr, url) => {
      try {
        const u = new URL(url);
        if (u.origin === baseOrigin && u.pathname.startsWith(basePath)) {
          const targetSitePath = toSitePath(u.pathname);
          const rel = relativeHref(fromSitePath, targetSitePath);
          return `${attr}="${rel}"`;
        }
      } catch {}
      return match;
    }
  );
}

// המתן עד שרכיב ספציפי מופיע ב-DOM
async function waitForContent(page) {
  try {
    // המתן שה-body יתמלא בתוכן אמיתי
    await page.waitForFunction(() => {
      const body = document.body.innerText.trim();
      return body.length > 100;
    }, { timeout: 10000 });
  } catch {}

  try {
    // המתן שאין יותר בקשות רשת פעילות
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 });
  } catch {}
}

// גלילה חכמה — גולל לאט ומחכה לכל lazy-load
async function smartScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const distance = 200;
      const delay = 150;
      let scrolled = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        scrolled += distance;

        if (scrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          // גלול חזרה לראש ואז שוב לתחתית לוודא הכל נטען
          window.scrollTo(0, 0);
          setTimeout(() => {
            window.scrollTo(0, document.body.scrollHeight);
            setTimeout(resolve, 1000);
          }, 500);
        }
      }, delay);
    });
  });
}

// חלץ את כל ה-inline styles עם background-image
async function extractBackgroundImages(page) {
  return page.evaluate(() => {
    const urls = [];
    document.querySelectorAll('*').forEach(el => {
      const style = window.getComputedStyle(el);
      const bg = style.backgroundImage;
      if (bg && bg !== 'none') {
        const match = bg.match(/url\(["']?(https?:\/\/[^"')]+)/);
        if (match) urls.push(match[1]);
      }
    });
    return [...new Set(urls)];
  });
}

async function extractAssets(page) {
  const domAssets = await page.evaluate(() => {
    const assets = [];
    document.querySelectorAll('img[src], script[src], link[href], source[src], video[src]').forEach(el => {
      const url = el.src || el.href;
      if (url && url.startsWith('http')) assets.push(url);
    });
    // data-src לתמונות עם lazy loading
    document.querySelectorAll('[data-src]').forEach(el => {
      if (el.dataset.src && el.dataset.src.startsWith('http')) assets.push(el.dataset.src);
    });
    return assets;
  });
  const bgAssets = await extractBackgroundImages(page);
  return [...new Set([...domAssets, ...bgAssets])];
}

async function extractLinks(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => h.startsWith('http'))
  );
}

function normalizeUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return baseOrigin + decodePath(u.pathname);
  } catch { return urlStr; }
}

async function crawl() {
  console.log(`🚀 Starting crawl of ${BASE_URL}`);
  console.log(`📁 Output: ${OUTPUT_DIR}  |  Base path: "${basePath}"  |  Max pages: ${MAX_PAGES}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',        // מונע חסימות CORS
      '--disable-features=IsolateOrigins',
      '--lang=he-IL'                   // עברית כשפת ממשק
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  // הגדר שפה עברית
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });

  // אל תחסום כלום — Wix צריך את כל הבקשות
  // רק מדיה כבדה נחסמת
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (type === 'media') req.abort();
    else req.continue();
  });

  while (queue.length > 0 && pageCount < MAX_PAGES) {
    const url = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;

    const u = new URL(url);
    if (u.origin !== baseOrigin || !u.pathname.startsWith(basePath)) continue;

    visited.add(normalized);
    pageCount++;

    const sitePath = toSitePath(u.pathname);
    console.log(`\n[${pageCount}/${MAX_PAGES}] ${url}`);
    console.log(`   sitePath: "${sitePath}"`);

    try {
      // טען את הדף
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // המתן לתוכן אמיתי
      await waitForContent(page);

      // גלול לאט לטעינת lazy content
      await smartScroll(page);

      // המתנה סופית לרכיבים אחרונים
      await new Promise(r => setTimeout(r, WAIT_MS));

      const html = await page.content();
      console.log(`   HTML size: ${Math.round(html.length / 1024)}KB`);

      const rewritten = rewriteHtml(html, url);
      const filePath = urlToFilePath(url);
      ensureDir(filePath);
      fs.writeFileSync(filePath, rewritten, 'utf8');
      console.log(`   ✅ → ${filePath}`);

      const assets = await extractAssets(page);
      console.log(`   Assets found: ${assets.length}`);
      for (const assetUrl of assets) {
        try {
          const au = new URL(assetUrl);
          if (au.origin === baseOrigin) {
            const assetSitePath = toSitePath(au.pathname);
            const destPath = path.join(OUTPUT_DIR, assetSitePath);
            await downloadFile(assetUrl, destPath);
          }
        } catch {}
      }

      const links = await extractLinks(page);
      console.log(`   Links found: ${links.length}`);
      for (const link of links) {
        try {
          const lu = new URL(link);
          if (lu.origin === baseOrigin && lu.pathname.startsWith(basePath)) {
            const normLink = normalizeUrl(link);
            if (!visited.has(normLink)) queue.push(link);
          }
        } catch {}
      }

    } catch (err) {
      console.log(`   ⚠️  Failed: ${err.message}`);
    }
  }

  await browser.close();

  const sitemap = [...visited].map(u => `<url><loc>${u}</loc></url>`).join('\n');
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>`
  );

  console.log(`\n✅ Done! ${pageCount} pages saved to ${OUTPUT_DIR}/`);
}

crawl().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
