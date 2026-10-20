import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The public documents: every relative link and anchor in them resolves, and
// each English file and its Japanese translation have the same sections.
const root = fileURLToPath(new URL('../', import.meta.url));
const DOCS = ['README.md', 'README.ja.md', 'CONFIG.md',
  ...fs.readdirSync(path.join(root, 'docs')).filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`)];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const withoutCode = (s) => s.replace(/^```[\s\S]*?^```/gm, '');

// GitHub's heading anchors: lower case, punctuation dropped (letters of any
// script kept), spaces to hyphens, a repeat numbered.
function anchors(rel) {
  const seen = new Map();
  return new Set([...withoutCode(read(rel)).matchAll(/^#{1,6} (.+)$/gm)].map(([, title]) => {
    const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  }));
}

function links(rel) {
  const text = withoutCode(read(rel));
  return [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]),
  ].filter((l) => !/^[a-z]+:/i.test(l));
}

test('every relative link and anchor in the public documents resolves', () => {
  const broken = [];
  for (const rel of DOCS) {
    for (const link of links(rel)) {
      const [file, anchor] = link.split('#');
      const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), file)) : rel;
      if (!fs.existsSync(path.join(root, target))) { broken.push(`${rel}: ${link} (no such file)`); continue; }
      if (anchor && target.endsWith('.md') && !anchors(target).has(decodeURIComponent(anchor))) {
        broken.push(`${rel}: ${link} (no such heading)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('each English document and its Japanese translation have the same headings, level by level', () => {
  for (const ja of DOCS.filter((d) => d.endsWith('.ja.md'))) {
    const en = ja.replace(/\.ja\.md$/, '.md');
    const levels = (rel) => [...withoutCode(read(rel)).matchAll(/^(#{1,6}) /gm)].map((m) => m[1].length);
    assert.deepEqual(levels(ja), levels(en), `${en} and ${ja}`);
  }
});

// npm shows README.md on the package page, so a file it links to has to be in
// the package. Images are left out: the logo is not shipped. ponytail: this
// assumes the registry page resolves images against the repository; check it
// there if the logo ever goes missing.
test('every file README.md links to ships in the npm package', () => {
  const pkg = JSON.parse(read('package.json'));
  const shipped = [...pkg.files, 'package.json', 'LICENSE'];
  const missing = links('README.md').map((l) => l.split('#')[0])
    .filter((f) => f && !/\.(png|svg|jpe?g|gif)$/i.test(f))
    .filter((f) => !shipped.some((s) => f === s || f.startsWith(`${s}/`)));
  assert.deepEqual(missing, []);
});
