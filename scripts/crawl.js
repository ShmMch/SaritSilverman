const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BASE_URL = process.env.SITE_URL.replace(/\/$/, '');
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200');
const WAIT_MS = parseInt(process.env.WAIT_MS || '4000');

if (!BASE_URL) { console.error('❌ SITE_URL required'); process.exit(1); }

const baseUrl = new URL(BASE_URL);
const baseOrigin = baseUrl.origin;
const basePath = baseUrl.pathname;

function decodePath(p) { try { return decodeURIComponent(p); } catch { return p; } }

function toSitePath(urlPathname) {
  let p = decodePath(urlPathname);
  if (p.startsWith(basePath)) p = p.slice(basePath.length);
  if (!p || p === '/') return '/';
  return p.startsWith('/') ? p : '/' + p;
}

function urlToFileName(urlStr) {
  const u = new URL(urlStr);
  let sitePath = toSitePath(u.pathname);
  if (sitePath === '/') return 'index.html';
  // e.g. /צור-קשר → צור-קשר.html
  const clean = sitePath.replace(/^\//, '').replace(/\//g, '_').replace(/[?#]/g, '_');
  return clean + '.html';
}

// בנה index.html שמקשר לכל הדפים
function buildIndex(pages) {
  const links = pages.map(({ url, fileName, title }) => {
    const label = title || decodePath(new URL(url).pathname.replace(basePath, '') || '/');
    return `<li><a href="${fileName}">${label}</a></li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <title>ניווט — ${BASE_URL}</title>
  <style>
    body { font-family: sans-serif; direction: rtl; padding: 40px; max-width: 600px; margin: auto; }
    h1 { font-size: 20px; margin-bottom: 20px; }
    ul { list-style: none; padding: 0; }
    li { margin: 10px 0; }
    a { color: #0066cc; text-decoration: none; font-size: 16px; }
    a:hover { text-decoration: underline; }
    p { color: #888; font-size: 13px; }
  </style>
</head>
<body>
  <h1>עמודי האתר</h1>
  <p>גרסה לוקלית של <a href="${BASE_URL}" target="_blank">${BASE_URL}</a></p>
  <ul>${links}</ul>
</body>
</html>`;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeUrl(urlStr) {
  try { const u = new URL(urlStr); return baseOrigin + decodePath(u.pathname); } catch { return urlStr; }
}

async function waitForContent(page) {
  try { await page.waitForFunction(() => document.body.innerText.trim().length > 100, { timeout: 10000 }); } catch {}
  try { await page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }); } catch {}
}

async function smartScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 200);
        scrolled += 200;
        if (scrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          setTimeout(() => { window.scrollTo(0, document.body.scrollHeight); setTimeout(resolve, 1000); }, 500);
        }
      }, 150);
    });
  });
}

async function extractLinks(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http'))
  );
}

async function saveSingleFile(pageUrl, outputPath, chromePath) {
  // SingleFile CLI — שומר הכל inline בקובץ HTML אחד
  // קישורים חיצוניים נשארים כפי שהם
  const cmd = [
    'npx single-file',
    `"${pageUrl}"`,
    `"${outputPath}"`,
    `--browser-executable-path="${chromePath}"`,
    '--browser-args=["--no-sandbox","--disable-setuid-sandbox"]',
    '--dump-content=false',
    '--compress-HTML=false',
    '--remove-hidden-elements=false',
    '--remove-unused-styles=false',
    '--remove-scripts=false',        // שמור JS לאנימציות
    `--browser-wait-until=networkidle2`,
    `--browser-wait-delay=${WAIT_MS}`,
  ].join(' ');

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });
    if (stderr && !stderr.includes('warn')) console.log(`   SingleFile: ${stderr.trim()}`);
    return true;
  } catch (err) {
    console.log(`   ⚠️ SingleFile failed: ${err.message}`);
    return false;
  }
}

async function rewriteInternalLinks(filePath, allPages, currentFileName) {
  let html = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  for (const { url, fileName } of allPages) {
    // החלף קישורים פנימיים לקבצים המקומיים
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const decodedUrl = decodePath(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    [escapedUrl, decodedUrl].forEach(pattern => {
      const regex = new RegExp(`href="${pattern}[^"]*"`, 'g');
      if (regex.test(html)) {
        html = html.replace(regex, `href="${fileName}"`);
        changed = true;
      }
    });
  }

  if (changed) fs.writeFileSync(filePath, html, 'utf8');
}

async function crawl() {
  console.log(`🚀 Crawling: ${BASE_URL}`);
  console.log(`📁 Output: ${OUTPUT_DIR} | Max: ${MAX_PAGES}\n`);

  ensureDir(OUTPUT_DIR + '/placeholder');

  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable';

  // שלב 1 — גלה את כל הדפים עם Puppeteer
  console.log('🔍 Phase 1: Discovering all pages...\n');
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: 'new', executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--lang=he-IL']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', req => { if (req.resourceType() === 'media') req.abort(); else req.continue(); });

  const visited = new Set();
  const queue = [BASE_URL];
  const allPages = []; // { url, fileName, title }

  while (queue.length > 0 && allPages.length < MAX_PAGES) {
    const url = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;

    const u = new URL(url);
    if (u.origin !== baseOrigin || !u.pathname.startsWith(basePath)) continue;

    visited.add(normalized);
    const fileName = urlToFileName(url);
    console.log(`[${allPages.length + 1}] Discovered: ${url} → ${fileName}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForContent(page);
      await smartScroll(page);
      await new Promise(r => setTimeout(r, 1000));

      const title = await page.title();
      allPages.push({ url, fileName, title });

      const links = await extractLinks(page);
      for (const link of links) {
        try {
          const lu = new URL(link);
          if (lu.origin === baseOrigin && lu.pathname.startsWith(basePath)) {
            if (!visited.has(normalizeUrl(link))) queue.push(link);
          }
        } catch {}
      }
    } catch (err) {
      console.log(`   ⚠️ ${err.message}`);
    }
  }

  await browser.close();
  console.log(`\n✅ Found ${allPages.length} pages\n`);

  // שלב 2 — שמור כל דף עם SingleFile
  console.log('💾 Phase 2: Saving pages with SingleFile...\n');
  for (let i = 0; i < allPages.length; i++) {
    const { url, fileName } = allPages[i];
    const outputPath = path.join(OUTPUT_DIR, fileName);
    console.log(`[${i + 1}/${allPages.length}] Saving: ${url}`);
    await saveSingleFile(url, outputPath, chromePath);
  }

  // שלב 3 — שכתב קישורים פנימיים
  console.log('\n🔗 Phase 3: Rewriting internal links...\n');
  for (const { fileName } of allPages) {
    const filePath = path.join(OUTPUT_DIR, fileName);
    if (fs.existsSync(filePath)) {
      await rewriteInternalLinks(filePath, allPages, fileName);
      console.log(`   ✅ ${fileName}`);
    }
  }

  // שלב 4 — צור index
  const indexPath = path.join(OUTPUT_DIR, '_index.html');
  fs.writeFileSync(indexPath, buildIndex(allPages), 'utf8');
  console.log(`\n📋 Index → ${indexPath}`);
  console.log(`✅ Done! ${allPages.length} pages saved to ${OUTPUT_DIR}/`);
  console.log(`\n👉 פתחי את _index.html כדי לנווט באתר`);
}

crawl().catch(err => { console.error('Fatal:', err); process.exit(1); });
