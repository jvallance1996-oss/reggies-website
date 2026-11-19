import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const rootOption = process.argv.indexOf('--root');
assert(rootOption === -1 || (process.argv[rootOption + 1] && !process.argv[rootOption + 1].startsWith('--')), 'Supply a directory after --root');
const root = rootOption === -1 ? resolve(import.meta.dirname, '..') : resolve(process.argv[rootOption + 1]);
const originalPaths = ['/', '/eynesbury/', '/melton/', '/melton-south/', '/wyndham-vale/', '/werribee/', '/caroline-springs/', '/manor-lakes/', '/tarneit/', '/weir-views/', '/harkness/', '/kurunjang/', '/lawn-mowing/', '/rubbish-removal/', '/gardening/', ...['melton','wyndham-vale','werribee','caroline-springs','eynesbury'].flatMap(area => [`/${area}/lawn-mowing/`, `/${area}/rubbish-removal/`])];
const sitemap = await readFile(join(root, 'sitemap.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
assert.equal(new Set(urls).size, urls.length, 'Sitemap contains duplicate URLs');
for (const path of originalPaths) assert(urls.includes(`https://reggies.com.au${path}`), `Original URL lost: ${path}`);
for (const path of ['/acreage-mowing-slashing/', '/service-areas/']) assert(urls.includes(`https://reggies.com.au${path}`), `New page absent from sitemap: ${path}`);
const cache = new Map();
let responsiveSets = 0;
async function page(pathname) {
  const path = join(root, decodeURIComponent(pathname), pathname.endsWith('/') ? 'index.html' : '');
  if (!cache.has(path)) cache.set(path, await readFile(path, 'utf8'));
  return cache.get(path);
}
for (const url of urls) {
  const { pathname } = new URL(url);
  const source = await page(pathname);
  assert.equal((source.match(/<h1(?:\s|>)/g) || []).length, 1, `${pathname}: needs one H1`);
  assert.equal((source.match(/<form(?:\s|>)/g) || []).length, 1, `${pathname}: needs one shared form`);
  assert(source.includes('action="/api/quotes"'), `${pathname}: enquiry form must use the server`);
  assert(source.includes(`<link rel="canonical" href="${url}">`), `${pathname}: canonical must be absolute and match the URL`);
  const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, `${pathname}: duplicate element IDs`);
  for (const match of source.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) JSON.parse(match[1]);
  for (const match of source.matchAll(/\b(href|src)="([^"]+)"/g)) {
    const [, kind, raw] = match;
    if (/^(?:mailto:|tel:|sms:|data:|https?:\/\/)/.test(raw)) continue;
    const target = new URL(raw.replaceAll('&amp;', '&'), url);
    if (target.origin !== 'https://reggies.com.au' || target.pathname.startsWith('/api/')) continue;
    const file = resolve(root, `.${decodeURIComponent(target.pathname)}`);
    assert(file.startsWith(root), `Unsafe path: ${raw}`);
    let info;
    try { info = await stat(file); } catch { assert.fail(`${pathname}: broken ${kind} ${raw}`); }
    const isDirectory = info.isDirectory();
    if (isDirectory) await stat(join(file, 'index.html'));
    if (target.hash) {
      const linked = await page(target.pathname.endsWith('/') ? target.pathname : `${target.pathname}/`);
      const id = decodeURIComponent(target.hash.slice(1));
      assert(linked.includes(`id="${id}"`), `${pathname}: missing fragment ${raw}`);
    }
  }
  for (const match of source.matchAll(/<(?:img|source)\b[^>]*\bsrcset="([^"]*)"[^>]*>/g)) {
    const candidates = match[1].split(',').map(value => value.trim());
    assert(candidates.length && candidates.every(Boolean), `${pathname}: empty responsive image candidate`);
    const descriptors = new Set();
    let descriptorType;
    for (const candidate of candidates) {
      const parts = candidate.match(/^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/);
      assert(parts, `${pathname}: malformed responsive image candidate ${candidate}`);
      const [, raw, value, type] = parts;
      assert(Number.isFinite(Number(value)) && Number(value) > 0 && (type !== 'w' || /^\d+$/.test(value)), `${pathname}: invalid responsive image descriptor ${candidate}`);
      assert(!descriptorType || descriptorType === type, `${pathname}: mixed responsive image descriptor types`);
      descriptorType = type;
      const descriptor = `${Number(value)}${type}`;
      assert(!descriptors.has(descriptor), `${pathname}: duplicate responsive image descriptor ${descriptor}`);
      descriptors.add(descriptor);
      const target = new URL(raw.replaceAll('&amp;', '&'), url);
      if (target.origin !== 'https://reggies.com.au') continue;
      const file = resolve(root, `.${decodeURIComponent(target.pathname)}`);
      assert(file === root || file.startsWith(`${root}/`), `${pathname}: unsafe responsive image path ${raw}`);
      let info;
      try { info = await stat(file); } catch { assert.fail(`${pathname}: broken responsive image ${raw}`); }
      assert(info.isFile() && info.size > 0, `${pathname}: responsive image must be a nonempty file ${raw}`);
    }
    if (descriptorType === 'w') assert(match[0].match(/\bsizes="([^"]*)"/)?.[1].trim(), `${pathname}: width-based responsive images need sizes`);
    responsiveSets++;
  }
}
console.log(`Site checks passed: ${urls.length} pages, all 25 original URLs, links, assets, fragments, forms, canonicals, JSON-LD and ${responsiveSets} responsive image sets.`);
