const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = process.env.SITE_URL.replace(/\/$/, '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200');
const WAIT_MS = parseInt(process.env.WAIT_MS || '2000');

if (!BASE_URL) {
  console.error('❌  SITE_URL environment variable is required');
  process.exit(1);
}

const baseUrl = new URL(BASE_URL);
const baseOrigin = baseUrl.origin;
const basePath = baseUrl.pathname; // e.g. /saritsilverman

const visited = new Set();
const queue = [BASE_URL];
let pageCount = 0;

function decodePath(p) {
  try { return decodeURIComponent(p); } catch { return p; }
}

// Strip basePath prefix and normalize to a clean URL path (not filesystem path)
// e.g. /saritsilverman/בית  →  /בית
function toSitePath(urlPathname) {
  let p = decodePath(urlPathname);
  if (p.startsWith(basePath)) p = p.slice(basePath.length);
  if (!p || p === '/') return '/';
  return p.startsWith('/') ? p : '/' + p;
}

// Convert site path to a local filename
// /בית  →  /בית/index.html
// /      →  /index.html
function sitePathToFile(sitePath) {
  if (sitePath === '/') return '/index.html';
  if (!path.extname(sitePath)) return sitePath.replace(/\/$/, '') + '/index.html';
  return sitePath;
}

// Build a relative href from one page to another — pure URL logic, no filesystem paths
// fromSitePath: /צור-קשר     targetSitePath: /בית
// result: ../בית/index.html
function relativeHref(fromSitePath, targetSitePath) {
  const fromFile = sitePathToFile(fromSitePath === '/' ? '/' : fromSitePath);
  const targetFile = sitePathToFile(targetSitePath);

  // Split into segments
  const fromParts = fromFile.split('/').filter(Boolean);
  const targetParts = targetFile.split('/').filter(Boolean);

  // Remove filename from fromParts (we want the directory)
  fromParts.pop();

  // Find common prefix length
  let common = 0;
  while (common < fromParts.length && common < targetParts.length && fromParts[common] === targetParts[common]) {
    common++;
  }

  const ups = fromParts.length - common;
  const downs = targetParts.slice(common);

  const rel = [...Array(ups).fill('..'), ...downs].join('/');
  return rel || './index.html';
}

// Convert a full URL to a local output file path
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

async function extractAssets(page) {
  return page.evaluate(() => {
    const assets = [];
    document.querySelectorAll('img[src], script[src], link[href]').forEach(el => {
      const url = el.src || el.href;
      if (url && url.startsWith('http')) assets.push(url);
    });
    document.querySelectorAll('[style]').forEach(el => {
      const m = el.style.backgroundImage.match(/url\(["']?(https?:\/\/[^"')]+)/);
      if (m) assets.push(m[1]);
    });
    return assets;
  });
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['font', 'media'].includes(req.resourceType())) req.abort();
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
    console.log(`[${pageCount}/${MAX_PAGES}] ${url}`);
    console.log(`   sitePath: "${sitePath}"`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, WAIT_MS));

      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 300);
            total += 300;
            if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
          }, 100);
        });
      });

      const html = await page.content();
      const rewritten = rewriteHtml(html, url);
      const filePath = urlToFilePath(url);
      ensureDir(filePath);
      fs.writeFileSync(filePath, rewritten, 'utf8');
      console.log(`   ✅ → ${filePath}`);

      const assets = await extractAssets(page);
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
