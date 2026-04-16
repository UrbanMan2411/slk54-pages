import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const PRIMARY_SITE = '../';
const ALT_SITE = '../';
const MAX_PAGES = 1000;
const PAGE_CONCURRENCY = 6;
const ASSET_CONCURRENCY = 8;
const INDEX_FILE = path.join(ROOT, 'index.html');
const existingAssetCache = new Map();

const TEXT_CONTENT_TYPES = [
  'text/',
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/xml',
  'application/rss+xml',
  'image/svg+xml',
];

function shortHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#038;|&#38;|&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSkippableValue(value) {
  return /^(?:mailto:|tel:|javascript:|data:|#)/i.test(value.trim());
}

function isInternalHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'xn--54-1lcd3a.xn--p1ai' || host.endsWith('.xn--54-1lcd3a.xn--p1ai') || host === 'slk54.ru';
}

function isAssetPathname(pathname) {
  return /\.(css|js|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|xml|json|map|mp4|webm|avif)(?:$|\?)/i.test(pathname);
}

function isServiceUrl(url) {
  return /wp-json|xmlrpc|feed\/|comments\/feed|oembed/i.test(url.href);
}

function normalizeUrl(raw, baseUrl) {
  try {
    const decoded = decodeHtmlEntities(raw.trim());
    const url = new URL(decoded, baseUrl);
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function toCanonicalPageUrl(raw, baseUrl = `${PRIMARY_SITE}/`) {
  const url = normalizeUrl(raw, baseUrl);
  if (!url || !isInternalHost(url.hostname)) return null;
  if (isAssetPathname(url.pathname) || isServiceUrl(url)) return null;
  const pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/?$/, '/');
  return `${PRIMARY_SITE}${pathname}`;
}

function canonicalPagePath(canonicalUrl) {
  const url = new URL(canonicalUrl);
  return url.pathname === '/' ? '/' : url.pathname;
}

function pageUrlFromFile(filePath) {
  const rel = path.relative(ROOT, filePath).split(path.sep).join('/');
  if (rel === 'index.html') return `${PRIMARY_SITE}/`;
  if (!rel.endsWith('/index.html')) return null;
  const dir = rel.slice(0, -'index.html'.length);
  return `${PRIMARY_SITE}/${dir}`;
}

function assetUrlFromFile(filePath) {
  const assetsRoot = path.join(ROOT, 'assets');
  const rel = path.relative(assetsRoot, filePath).split(path.sep).join('/');
  if (rel.startsWith('..')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;
  const host = parts.shift();
  const fileName = parts.pop();
  if (!fileName) return null;
  const stripped = fileName.replace(/__q-[a-f0-9]{12}(?=\.[^.]+$|$)/i, '');
  if (/^index\.[^.]+$/i.test(stripped)) {
    return `https://${host}/${parts.join('/')}${parts.length ? '/' : ''}`;
  }
  const urlPath = [...parts, stripped].join('/');
  return `https://${host}/${urlPath}`;
}

const TEXT_FILE_RE = /\.(html?|css|mjs|cjs|js|xml|json|txt|svg)$/i;

async function buildDiskMaps() {
  const routeMap = new Map();
  const assetMap = new Map();

  async function walkPages(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'assets' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkPages(full);
        continue;
      }
      if (entry.isFile() && entry.name === 'index.html') {
        const url = pageUrlFromFile(full);
        if (url) routeMap.set(url, full);
      }
    }
  }

  async function walkAssets(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAssets(full);
        continue;
      }
      if (entry.isFile()) {
        const url = assetUrlFromFile(full);
        if (url) assetMap.set(url, { filePath: full, contentType: contentTypeFromPath(full) });
      }
    }
  }

  await walkPages(ROOT);
  await walkAssets(path.join(ROOT, 'assets'));

  routeMap.set(`${PRIMARY_SITE}/`, INDEX_FILE);
  routeMap.set(PRIMARY_SITE, INDEX_FILE);
  routeMap.set(`${ALT_SITE}/`, INDEX_FILE);
  routeMap.set(ALT_SITE, INDEX_FILE);

  return { routeMap, assetMap };
}

async function rewriteDiskFile(filePath, routeMap, assetMap) {
  const ext = path.extname(filePath).toLowerCase();
  const text = await fs.readFile(filePath, 'utf8');
  const sourceUrl = filePath.startsWith(path.join(ROOT, 'assets'))
    ? assetUrlFromFile(filePath)
    : pageUrlFromFile(filePath) || `${PRIMARY_SITE}/`;

  if (!sourceUrl) return;

  const rewritten = ext === '.html' || ext === '.htm'
    ? rewriteHtml(text, sourceUrl, filePath, routeMap, assetMap)
    : rewriteTextAsset(text, sourceUrl, filePath, routeMap, assetMap);

  if (rewritten !== text) {
    await fs.writeFile(filePath, rewritten, 'utf8');
  }
}

async function rewriteLocalMirror() {
  const { routeMap, assetMap } = await buildDiskMaps();

  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && TEXT_FILE_RE.test(entry.name)) {
        await rewriteDiskFile(full, routeMap, assetMap);
      }
    }
  }

  await walk(ROOT);
  process.stdout.write(`done: rewrote local mirror using ${routeMap.size} pages and ${assetMap.size} assets\n`);
}

function filePathFromCanonical(canonicalUrl) {
  const url = new URL(canonicalUrl);
  if (url.pathname === '/') return path.join(ROOT, 'index.html');
  const decoded = decodeURIComponent(url.pathname);
  const segments = decoded.split('/').filter(Boolean);
  return path.join(ROOT, ...segments, 'index.html');
}

function relativeHrefBetweenFiles(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const toDir = path.dirname(toFile);
  const relative = path.relative(fromDir, toDir).split(path.sep).join('/');
  if (!relative) return './';
  return relative.endsWith('/') ? relative : `${relative}/`;
}

function safeHost(hostname) {
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/gi, '_');
}

function inferExtension(url, contentType = '') {
  const type = contentType.toLowerCase();
  if (type.includes('text/css')) return '.css';
  if (type.includes('javascript')) return '.js';
  if (type.includes('image/svg+xml')) return '.svg';
  if (type.includes('application/json')) return '.json';
  if (type.includes('application/rss+xml') || type.includes('application/xml') || type.includes('text/xml')) return '.xml';
  if (type.includes('text/html')) return '.html';
  if (type.startsWith('image/')) return `.${type.slice('image/'.length).split(';')[0]}`;
  if (type.startsWith('font/')) return `.${type.slice('font/'.length).split(';')[0]}`;
  if (type.includes('woff2')) return '.woff2';
  if (type.includes('woff')) return '.woff';
  if (type.includes('ttf')) return '.ttf';
  if (type.includes('otf')) return '.otf';
  if (type.includes('ico')) return '.ico';
  if (type.includes('webp')) return '.webp';
  if (type.includes('avif')) return '.avif';
  if (url.pathname.endsWith('/')) return '.html';
  return '.bin';
}

function assetPathFromUrl(url, contentType = '') {
  const hostDir = path.join(ROOT, 'assets', safeHost(url.hostname));
  const decodedPath = decodeURIComponent(url.pathname || '/');
  const segments = decodedPath.split('/').filter(Boolean);
  const endsWithSlash = decodedPath.endsWith('/');

  if (endsWithSlash || !segments.length) segments.push('index');

  let fileName = segments.pop();
  const ext = path.extname(fileName);
  const querySuffix = url.search ? `__q-${shortHash(url.search)}` : '';

  if (ext) {
    const base = fileName.slice(0, -ext.length);
    fileName = `${base}${querySuffix}${ext}`;
  } else {
    fileName = `${fileName}${querySuffix}${inferExtension(url, contentType)}`;
  }

  return path.join(hostDir, ...segments, fileName);
}

function isTextContentType(contentType = '') {
  const type = contentType.toLowerCase();
  return TEXT_CONTENT_TYPES.some((prefix) => type.startsWith(prefix));
}

function contentTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'application/javascript';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.json') return 'application/json';
  if (ext === '.xml' || ext === '.rss') return 'application/xml';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  return '';
}

async function findExistingAssetPath(url) {
  const cached = existingAssetCache.get(url.href);
  if (cached !== undefined) return cached;

  const hostDir = path.join(ROOT, 'assets', safeHost(url.hostname));
  const decodedPath = decodeURIComponent(url.pathname || '/');
  const endsWithSlash = decodedPath.endsWith('/');
  const segments = decodedPath.split('/').filter(Boolean);
  let dir = hostDir;
  let baseName = 'index';

  if (segments.length) {
    baseName = segments[segments.length - 1];
    dir = path.join(hostDir, ...segments.slice(0, -1));
  }
  if (endsWithSlash) {
    dir = path.join(hostDir, ...segments);
    baseName = 'index';
  }

  const querySuffix = url.search ? `__q-${shortHash(url.search)}` : '';
  const ext = path.extname(baseName);
  const prefix = ext ? `${baseName.slice(0, -ext.length)}${querySuffix}${ext}` : `${baseName}${querySuffix}`;

  try {
    if (ext) {
      const exact = path.join(dir, prefix);
      if (await fs
        .access(exact)
        .then(() => true)
        .catch(() => false)) {
        existingAssetCache.set(url.href, exact);
        return exact;
      }
    }

    const entries = await fs.readdir(dir, { withFileTypes: true });
    const match = entries.find((entry) => entry.isFile() && entry.name.startsWith(prefix));
    if (match) {
      const found = path.join(dir, match.name);
      existingAssetCache.set(url.href, found);
      return found;
    }
  } catch {
    // no existing local asset
  }

  existingAssetCache.set(url.href, null);
  return null;
}

async function fetchResource(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      accept: '*/*',
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = isTextContentType(contentType) ? buffer.toString('utf8') : null;
  return { buffer, text, contentType };
}

function extractPageCandidatesFromHtml(html, baseUrl) {
  const out = new Set();
  const re = /href=(['"])(.*?)\1/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = decodeHtmlEntities(match[2]);
    if (isSkippableValue(href)) continue;
    const page = toCanonicalPageUrl(href, baseUrl);
    if (page) out.add(page);
  }
  return [...out];
}

function splitSrcset(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const pieces = part.split(/\s+/);
      return { url: pieces[0], descriptor: pieces.slice(1).join(' ') };
    });
}

function extractUrlsFromText(text, baseUrl) {
  const out = new Set();

  const urlRe = /url\((.*?)\)/gi;
  let match;
  while ((match = urlRe.exec(text))) {
    const raw = stripQuotes(decodeHtmlEntities(match[1]));
    if (!isSkippableValue(raw)) {
      const url = normalizeUrl(raw, baseUrl);
      if (url) out.add(url.href);
    }
  }

  const importRe = /@import\s+(?:url\()?\s*(['"]?)([^'")\s]+)\1\s*\)?/gi;
  while ((match = importRe.exec(text))) {
    const raw = decodeHtmlEntities(match[2]);
    if (!isSkippableValue(raw)) {
      const url = normalizeUrl(raw, baseUrl);
      if (url) out.add(url.href);
    }
  }

  const attrRe = /\b(href|src|poster|content|action|formaction|data-src|data-lazy-src|data-bg|data-background|data-srcset|srcset)=(['"])(.*?)\2/gi;
  while ((match = attrRe.exec(text))) {
    const attrName = match[1].toLowerCase();
    const raw = decodeHtmlEntities(match[3]);

    if (attrName.includes('srcset')) {
      for (const item of splitSrcset(raw)) {
        if (isSkippableValue(item.url)) continue;
        const url = normalizeUrl(item.url, baseUrl);
        if (url) out.add(url.href);
      }
      continue;
    }

    if (!isSkippableValue(raw)) {
      const url = normalizeUrl(raw, baseUrl);
      if (url) out.add(url.href);
    }
  }

  const absoluteRe = /(?:https?:\/\/|\/\/)[^"'`<>\s)]+/gi;
  while ((match = absoluteRe.exec(text))) {
    const raw = decodeHtmlEntities(match[0]);
    if (raw === 'http://www.w3.org/2000/svg') continue;
    if (isSkippableValue(raw)) continue;
    const url = normalizeUrl(raw, baseUrl);
    if (url) out.add(url.href);
  }

  return [...out];
}

function collectAssetCandidatesFromHtml(html, baseUrl) {
  const urls = new Set();
  for (const raw of extractUrlsFromText(html, baseUrl)) {
    const page = toCanonicalPageUrl(raw, baseUrl);
    if (page) continue;
    const url = normalizeUrl(raw, baseUrl);
    if (!url) continue;
    if (!isInternalHost(url.hostname) && url.pathname === '/' && !url.search) continue;
    urls.add(url.href);
  }
  return [...urls];
}

function decodeAssetValue(raw, baseUrl) {
  const decoded = decodeHtmlEntities(raw);
  if (isSkippableValue(decoded)) return null;
  const page = toCanonicalPageUrl(decoded, baseUrl);
  if (page) return { type: 'page', url: page };
  const url = normalizeUrl(decoded, baseUrl);
  if (!url) return null;
  if (!isInternalHost(url.hostname) && url.pathname === '/' && !url.search) return null;
  return { type: 'asset', url: url.href };
}

function rewriteSrcset(value, baseUrl, sourceFile, routeMap, assetMap) {
  return splitSrcset(value)
    .map(({ url, descriptor }) => {
      const decoded = decodeAssetValue(url, baseUrl);
      if (!decoded) return descriptor ? `${url} ${descriptor}` : url;
      let replacement = url;
      if (decoded.type === 'page') {
        const target = routeMap.get(decoded.url);
        if (target) replacement = relativeHrefBetweenFiles(sourceFile, target);
      } else {
        const asset = assetMap.get(decoded.url);
        if (asset) replacement = relativeHrefBetweenFiles(sourceFile, asset.filePath);
      }
      return descriptor ? `${replacement} ${descriptor}` : replacement;
    })
    .join(', ');
}

function rewriteCssUrls(text, baseUrl, sourceFile, routeMap, assetMap) {
  let out = text;

  out = out.replace(/url\((.*?)\)/gi, (full, raw) => {
    const decoded = decodeAssetValue(stripQuotes(raw), baseUrl);
    if (!decoded) return full;
    if (decoded.type === 'page') {
      const target = routeMap.get(decoded.url);
      if (!target) return full;
      return `url('${relativeHrefBetweenFiles(sourceFile, target)}')`;
    }
    const asset = assetMap.get(decoded.url);
    if (!asset) return full;
    return `url('${relativeHrefBetweenFiles(sourceFile, asset.filePath)}')`;
  });

  out = out.replace(/@import\s+(?:url\()?\s*(['"]?)([^'")\s]+)\1\s*\)?/gi, (full, quote, raw) => {
    const decoded = decodeAssetValue(raw, baseUrl);
    if (!decoded) return full;
    if (decoded.type === 'page') {
      const target = routeMap.get(decoded.url);
      if (!target) return full;
      return `@import url('${relativeHrefBetweenFiles(sourceFile, target)}')`;
    }
    const asset = assetMap.get(decoded.url);
    if (!asset) return full;
    return `@import url('${relativeHrefBetweenFiles(sourceFile, asset.filePath)}')`;
  });

  return out;
}

function rewriteAbsoluteUrls(text, baseUrl, sourceFile, routeMap, assetMap) {
  return text.replace(/(?:https?:\/\/|\/\/)[^"'`<>\s)]+/gi, (raw) => {
    const decoded = decodeAssetValue(decodeHtmlEntities(raw), baseUrl);
    if (!decoded) return raw;
    if (decoded.type === 'page') {
      const target = routeMap.get(decoded.url);
      return target ? relativeHrefBetweenFiles(sourceFile, target) : raw;
    }
    const asset = assetMap.get(decoded.url);
    return asset ? relativeHrefBetweenFiles(sourceFile, asset.filePath) : raw;
  });
}

function rewriteHtml(html, baseUrl, sourceFile, routeMap, assetMap) {
  let out = html.replace(/<base\b[^>]*>\s*/gi, '');

  out = out.replace(/\b(href|src|poster|content|action|formaction|data-src|data-lazy-src|data-bg|data-background|data-srcset|srcset)=(['"])(.*?)\2/gi, (full, name, quote, rawValue) => {
    const value = decodeHtmlEntities(rawValue);
    const decoded = decodeAssetValue(value, baseUrl);

    if (name.toLowerCase().includes('srcset')) {
      return `${name}=${quote}${rewriteSrcset(value, baseUrl, sourceFile, routeMap, assetMap)}${quote}`;
    }

    if (!decoded) return full;

    if (decoded.type === 'page') {
      const target = routeMap.get(decoded.url);
      if (!target) return full;
      return `${name}=${quote}${relativeHrefBetweenFiles(sourceFile, target)}${quote}`;
    }

    const asset = assetMap.get(decoded.url);
    if (!asset) return full;
    return `${name}=${quote}${relativeHrefBetweenFiles(sourceFile, asset.filePath)}${quote}`;
  });

  out = rewriteCssUrls(out, baseUrl, sourceFile, routeMap, assetMap);
  out = rewriteAbsoluteUrls(out, baseUrl, sourceFile, routeMap, assetMap);
  return out;
}

function rewriteTextAsset(text, baseUrl, sourceFile, routeMap, assetMap) {
  let out = rewriteCssUrls(text, baseUrl, sourceFile, routeMap, assetMap);
  out = rewriteAbsoluteUrls(out, baseUrl, sourceFile, routeMap, assetMap);
  return out;
}

async function discoverSitemapSeeds() {
  const startUrls = [`${PRIMARY_SITE}/wp-sitemap.xml`, `${PRIMARY_SITE}/sitemap_index.xml`, `${PRIMARY_SITE}/sitemap.xml`];
  const seeds = new Set();
  const seen = new Set();
  const queue = [...startUrls];

  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    try {
      const { text } = await fetchResource(url);
      if (!text) continue;
      for (const match of text.matchAll(/<loc>(.*?)<\/loc>/gi)) {
        const loc = decodeHtmlEntities(match[1].trim());
        const normalized = normalizeUrl(loc, url);
        if (!normalized) continue;
        if (normalized.pathname.endsWith('.xml') || normalized.pathname.endsWith('.xml/') || /sitemap/i.test(normalized.href)) {
          queue.push(normalized.href);
          continue;
        }
        const page = toCanonicalPageUrl(normalized.href, url);
        if (page) seeds.add(page);
      }
    } catch {
      // Ignore missing sitemap endpoints.
    }
  }

  return [...seeds];
}

async function crawlPages(seedHtml) {
  const initialSeeds = new Set([
    `${PRIMARY_SITE}/`,
    ...extractPageCandidatesFromHtml(seedHtml, `${PRIMARY_SITE}/`),
    ...(await discoverSitemapSeeds()),
  ]);

  const queue = [...initialSeeds];
  const seen = new Set(queue);
  const pages = new Map();
  const assetSeeds = new Set();
  let index = 0;
  let active = 0;

  return await new Promise((resolve, reject) => {
    const launch = () => {
      while (active < PAGE_CONCURRENCY && index < queue.length) {
        const url = queue[index++];
        active++;

        (async () => {
          let text = null;
          const localFile = filePathFromCanonical(url);
          if (await fs
            .access(localFile)
            .then(() => true)
            .catch(() => false)) {
            text = await fs.readFile(localFile, 'utf8');
          } else {
            try {
              ({ text } = await fetchResource(url));
            } catch {
              process.stderr.write(`skip ${url}: no remote page and no local mirror\n`);
              return;
            }
          }
          if (!text) throw new Error(`Expected HTML from ${url}`);
          pages.set(url, text);
          for (const next of extractPageCandidatesFromHtml(text, url)) {
            if (!seen.has(next) && pages.size < MAX_PAGES) {
              seen.add(next);
              queue.push(next);
            }
          }
          for (const assetUrl of collectAssetCandidatesFromHtml(text, url)) {
            assetSeeds.add(assetUrl);
          }
        })()
          .catch(reject)
          .finally(() => {
            active--;
            if (index >= queue.length && active === 0) resolve({ pages, assetSeeds });
            else launch();
          });
      }
    };

    launch();
  });
}

async function crawlAssets(assetSeeds) {
  const queue = [...assetSeeds];
  const seen = new Set(queue);
  const assets = new Map();
  let index = 0;
  let active = 0;

  return await new Promise((resolve, reject) => {
    const launch = () => {
      while (active < ASSET_CONCURRENCY && index < queue.length) {
        const url = queue[index++];
        active++;

        (async () => {
          const urlObj = new URL(url);
          let localFile = await findExistingAssetPath(urlObj);
          let contentType = '';
          let text = null;

          if (localFile) {
            contentType = contentTypeFromPath(localFile);
            if (isTextContentType(contentType)) {
              const buffer = await fs.readFile(localFile);
              text = buffer.toString('utf8');
            }
          } else {
            const fetched = await fetchResource(url);
            contentType = fetched.contentType;
            localFile = assetPathFromUrl(urlObj, contentType);
            await fs.mkdir(path.dirname(localFile), { recursive: true });
            await fs.writeFile(localFile, fetched.buffer);
            text = fetched.text;
          }

          assets.set(url, { filePath: localFile, contentType });

          if (text && isTextContentType(contentType)) {
            for (const next of extractUrlsFromText(text, url)) {
              const decoded = decodeAssetValue(next, url);
              if (!decoded || decoded.type === 'page') continue;
              if (!seen.has(decoded.url)) {
                seen.add(decoded.url);
                queue.push(decoded.url);
              }
            }
          }
        })()
          .catch((err) => {
            process.stderr.write(`skip ${url}: ${err.message}\n`);
          })
          .finally(() => {
            active--;
            if (index >= queue.length && active === 0) resolve(assets);
            else launch();
          });
      }
    };

    launch();
  });
}

async function main() {
  if (process.argv.includes('--rewrite-only')) {
    await rewriteLocalMirror();
    return;
  }

  const seedHtml = await fs.readFile(INDEX_FILE, 'utf8');
  const { pages, assetSeeds } = await crawlPages(seedHtml);

  const routeMap = new Map();
  routeMap.set(`${PRIMARY_SITE}/`, INDEX_FILE);
  routeMap.set(PRIMARY_SITE, INDEX_FILE);
  routeMap.set(`${ALT_SITE}/`, INDEX_FILE);
  routeMap.set(ALT_SITE, INDEX_FILE);
  for (const url of pages.keys()) {
    routeMap.set(url, filePathFromCanonical(url));
  }

  const assets = await crawlAssets(assetSeeds);

  for (const [url, html] of pages) {
    const outFile = filePathFromCanonical(url);
    const rewritten = rewriteHtml(html, url, outFile, routeMap, assets);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, rewritten, 'utf8');
  }

  const rewrittenIndex = rewriteHtml(seedHtml, `${PRIMARY_SITE}/`, INDEX_FILE, routeMap, assets);
  await fs.writeFile(INDEX_FILE, rewrittenIndex, 'utf8');

  for (const [url, meta] of assets) {
    if (!isTextContentType(meta.contentType)) continue;
    const text = await fs.readFile(meta.filePath, 'utf8');
    const rewritten = rewriteTextAsset(text, url, meta.filePath, routeMap, assets);
    if (rewritten !== text) {
      await fs.writeFile(meta.filePath, rewritten, 'utf8');
    }
  }

  process.stdout.write(`done: ${pages.size} pages mirrored, ${assets.size} assets mirrored\n`);
}

main().catch((err) => {
  process.stderr.write(err.stack || err.message);
  process.exit(1);
});
