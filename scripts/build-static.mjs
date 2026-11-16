import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Validate the source before creating a separate public-only build. The API
// service continues to run from the repository root and uses its own allowlist.
await import('./check-site.mjs');

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'dist');
const sitemap = await readFile(join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => new URL(match[1]));
const files = new Set(['styles.css', 'script.js', 'robots.txt', 'sitemap.xml', 'google-reviews.json']);

// Google ownership may use a root HTML file instead of (or alongside) the
// existing verification meta tag. Preserve one if it is present in source.
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (entry.isFile() && /^google[a-z0-9]+\.html$/i.test(entry.name)) files.add(entry.name);
}

for (const url of urls) {
  assert.equal(url.origin, 'https://reggies.com.au', 'Unexpected sitemap origin');
  assert(/^\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*$/.test(url.pathname), `Unsupported public route: ${url.pathname}`);
  assert(!url.search && !url.hash, 'Sitemap URLs must not contain query strings or fragments');
  files.add(`${url.pathname.slice(1)}index.html`);
}

const assetExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.ico', '.woff', '.woff2']);
let assets = 0;
async function collectAssets(directory, prefix = 'assets') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), `Symlink is not a public asset: ${prefix}/${entry.name}`);
    if (entry.name.startsWith('.')) continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await collectAssets(join(directory, entry.name), path);
    else if (entry.isFile() && assetExtensions.has(extname(entry.name).toLowerCase())) {
      files.add(path);
      assets++;
    }
  }
}
await collectAssets(join(root, 'assets'));

// Do not recursively copy the repository: it contains backend code and private
// deployment configuration. Only sitemap pages and the explicit assets above
// belong in the static component's output directory.
for (const file of files) {
  const info = await lstat(join(root, file));
  assert(info.isFile() && !info.isSymbolicLink(), `Public source must be a regular file: ${file}`);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) {
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, file), destination);
}
console.log(`Static build ready: ${urls.length} pages, ${assets} assets and ${files.size} public files in dist/.`);
