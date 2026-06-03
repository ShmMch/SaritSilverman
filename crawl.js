const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE_URL = process.env.SITE_URL;
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200');
const WAIT_MS = parseInt(process.env.WAIT_MS || '2000');

if (!BASE_URL) {
  console.error('❌  SITE_URL environment variable is required');
  process.exit(1);
}

const baseOrigin = new URL(BASE_URL).origin;
const visited = new Set();
const queue = [BASE_URL];
let pageCount = 0;

function sanitizePath(urlStr) {
  const u = new URL(urlStr);
  let p = u.pathname;
  if (p.endsWith('/') || p === '') p += 'index.html';
  else if (!path.extname(p)) p += '/index.html';
  return path.join(OUTPUT_DIR, p);
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
  // Rewrite absolute URLs to relative paths so the static site works offline
  const pageBase = new URL(pageUrl);

  return html.replace(
    /(href|src|action)="(https?:\/\/[^"]+)"/g,
    (match, attr, url) => {
      try {
        const u = new URL(url);
        if (u.origin === baseOrigin) {
          let rel = path.relative(path.dirname(pageBase.pathname), u.pathname);
          if (!rel) rel = './index.html';
          if (!path.extname(rel)) rel = rel + '/index.html';
          return `${attr}="${rel}"`;
        }
      } catch {}
      return match;
    }
  );
}

async function extractAssets(page, pageUrl) {
  return page.evaluate(() => {
    const assets = [];
    document.querySelectorAll('img[src], script[src], link[href]').forEach(el => {
      const url = el.src || el.href;
      if (url && url.startsWith('http')) assets.push(url);
    });
    // Also grab CSS background-image urls
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

async function crawl() {
  console.log(`🚀 Starting crawl of ${BASE_URL}`);
  console.log(`📁 Output: ${OUTPUT_DIR}  |  Max pages: ${MAX_PAGES}\n`);

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  await page.setViewport({ width: 1280, height: 900 });

  // Intercept and block unnecessary heavy resources to speed up crawl
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (['font', 'media'].includes(type)) req.abort();
    else req.continue();
  });

  while (queue.length > 0 && pageCount < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;

    const u = new URL(url);
    if (u.origin !== baseOrigin) continue; // stay on same domain

    visited.add(url);
    pageCount++;

    console.log(`[${pageCount}/${MAX_PAGES}] Crawling: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, WAIT_MS)); // extra wait for Wix JS

      // Scroll to trigger lazy-loaded content
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
      const filePath = sanitizePath(url);
      ensureDir(filePath);
      fs.writeFileSync(filePath, rewritten, 'utf8');
      console.log(`   ✅ Saved → ${filePath}`);

      // Download static assets
      const assets = await extractAssets(page, url);
      for (const assetUrl of assets) {
        try {
          const au = new URL(assetUrl);
          if (au.origin === baseOrigin && au.pathname !== '/') {
            const destPath = path.join(OUTPUT_DIR, au.pathname);
            await downloadFile(assetUrl, destPath);
          }
        } catch {}
      }

      // Enqueue new internal links
      const links = await extractLinks(page);
      for (const link of links) {
        try {
          const lu = new URL(link);
          const clean = lu.origin + lu.pathname; // strip query & hash
          if (lu.origin === baseOrigin && !visited.has(clean)) {
            queue.push(clean);
          }
        } catch {}
      }

    } catch (err) {
      console.log(`   ⚠️  Failed: ${err.message}`);
    }
  }

  await browser.close();

  // Write a simple sitemap
  const sitemap = [...visited].map(u => `<url><loc>${u}</loc></url>`).join('\n');
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>`
  );

  console.log(`\n✅ Done! ${pageCount} pages saved to ${OUTPUT_DIR}/`);
  console.log(`📄 Sitemap written to ${OUTPUT_DIR}/sitemap.xml`);
}

crawl().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
