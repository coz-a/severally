import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const root = fileURLToPath(new URL('../', import.meta.url));
const readmes = ['README.md', 'README.ja.md'];
const imageExtensions = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function localImageReferences(readmePath) {
  const source = fs.readFileSync(readmePath, 'utf8');
  const markdown = [...source.matchAll(/!\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)].map(([, reference]) => reference);
  const html = [...source.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(([, reference]) => reference);
  const srcset = [...source.matchAll(/\bsrcset=["']([^"']+)["']/gi)].flatMap(([, candidates]) =>
    candidates.split(',').map((candidate) => candidate.trim().split(/\s+/, 1)[0]),
  );

  return [...new Set([...markdown, ...html, ...srcset])]
    .filter((reference) => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(reference))
    .map((reference) => decodeURIComponent(reference.split(/[?#]/, 1)[0]))
    .filter(Boolean);
}

function imageFiles(directory, relative = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const childRelative = path.posix.join(relative, entry.name);
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return imageFiles(childPath, childRelative);
    return imageExtensions.test(entry.name) ? [childRelative] : [];
  });
}

test('packed tarball contains only README-referenced local images and resolves both READMEs', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'severally-package-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const packed = spawn.sync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);

  const [packInfo] = JSON.parse(packed.stdout);
  const archive = path.join(temp, packInfo.filename);
  const extractDir = path.join(temp, 'extracted');
  fs.mkdirSync(extractDir);
  execFileSync('tar', ['-xzf', archive, '-C', extractDir], { windowsHide: true });
  const packageDir = path.join(extractDir, 'package');

  const referencesByReadme = Object.fromEntries(
    readmes.map((readme) => [readme, localImageReferences(path.join(packageDir, readme))]),
  );
  const allReferences = [...new Set(Object.values(referencesByReadme).flat())].sort();
  assert.ok(allReferences.length > 0, 'expected both READMEs to reference local images');

  for (const [readme, references] of Object.entries(referencesByReadme)) {
    assert.ok(references.length > 0, `${readme} should include a local image reference`);
    for (const reference of references) {
      assert.ok(fs.existsSync(path.join(packageDir, reference)), `${readme} references missing packed image ${reference}`);
    }
  }

  assert.deepEqual(imageFiles(packageDir).sort(), allReferences);
});
