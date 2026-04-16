import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const SITE = 'https://xn--54-1lcd3a.xn--p1ai';
const ALT_SITE = 'http://slk54.ru';
const MAX_PAGES = 150;

const INDEX_FILE = path.join(ROOT, 'index.html');

function isAssetUrl(url) {
  return /\.(css|js|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|xml|json)(?:$|\?)/i.test(url);
}

function isServiceUrl(url) {
  return /wp-json|xmlrpc|feed\/|wp-content\/plugins\/|wp-includes\/|comments\/feed|oembed/i.test(url);
}

function toCanonicalPageUrl(raw, base = `${SITE}/`) {
  try {
    const url = new URL(raw, base);
    const host = url.hostname.toLowerCase();
    if (!(host.includes('xn--54-1lcd3a.xn--p1ai') || host === 'slk54.ru')) return null;
    if (isAssetUrl(url.pathname) || isServiceUrl(url.href)) return null;

    const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/?$/, '/');
    return `${SITE}${pathname}`;
  } catch {
    return null;
  }
}

function localHrefFromCanonical(canonicalUrl) {
  const url = new URL(canonicalUrl);
  return url.pathname === '/' ? '/' : url.pathname;
}

function relativeHrefBetweenFiles(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const toDir = path.dirname(toFile);
  const relative = path.relative(fromDir, toDir).split(path.sep).join('/');
  if (!relative) return './';
  return relative.endsWith('/') ? relative : `${relative}/`;
}

function filePathFromCanonical(canonicalUrl) {
  const url = new URL(canonicalUrl);
  if (url.pathname === '/') return path.join(ROOT, 'index.html');
  const decoded = decodeURIComponent(url.pathname);
  const segments = decoded.split('/').filter(Boolean);
  return path.join(ROOT, ...segments, 'index.html');
}

function extractHrefCandidates(html, baseUrl) {
  const re = /href=(['"])(.*?)\1/gi;
  const out = [];
  let match;
  while ((match = re.exec(html))) {
    const href = match[2];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    const canon = toCanonicalPageUrl(href, baseUrl);
    if (canon) out.push(canon);
  }
  return [...new Set(out)];
}

function rewriteInternalLinks(html, baseUrl, sourceFile, routeMap) {
  const withoutBase = html.replace(/<base\b[^>]*>\s*/gi, '');
  return withoutBase.replace(/href=(['"])(.*?)\1/gi, (full, quote, href) => {
    const canon = toCanonicalPageUrl(href, baseUrl);
    if (!canon || !routeMap.has(canon)) return full;
    const targetFile = routeMap.get(canon);
    return `href=${quote}${relativeHrefBetweenFiles(sourceFile, targetFile)}${quote}`;
  });
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function main() {
  const seedHtml = await fs.readFile(INDEX_FILE, 'utf8');
  const queue = extractHrefCandidates(seedHtml, `${SITE}/`);
  const seen = new Set(queue);
  const pages = new Map();

  while (queue.length && pages.size < MAX_PAGES) {
    const url = queue.shift();
    if (pages.has(url)) continue;
    try {
      const html = await fetchHtml(url);
      pages.set(url, html);
      for (const next of extractHrefCandidates(html, url)) {
        if (!seen.has(next) && pages.size < MAX_PAGES) {
          seen.add(next);
          queue.push(next);
        }
      }
      process.stdout.write(`fetched ${pages.size}: ${url}\n`);
    } catch (err) {
      process.stderr.write(`skip ${url}: ${err.message}\n`);
    }
  }

  const routeMap = new Map();
  routeMap.set(`${SITE}/`, '/');
  routeMap.set(`${SITE}`, '/');
  routeMap.set(`${ALT_SITE}/`, '/');
  routeMap.set(`${ALT_SITE}`, '/');
  for (const url of pages.keys()) {
    routeMap.set(url, localHrefFromCanonical(url));
  }

  for (const [url, html] of pages) {
    const outFile = filePathFromCanonical(url);
    const rewritten = rewriteInternalLinks(html, url, outFile, routeMap);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, rewritten, 'utf8');
  }

  const rewrittenIndex = rewriteInternalLinks(seedHtml, `${SITE}/`, INDEX_FILE, routeMap);
  await fs.writeFile(INDEX_FILE, rewrittenIndex, 'utf8');

  process.stdout.write(`done: ${pages.size} pages mirrored\n`);
}

main().catch((err) => {
  process.stderr.write(err.stack || err.message);
  process.exit(1);
});
