import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { __selftest, buildIndex, search, highlight } from '../docs/assets/js/core/search.js';
import { PROJECTS, CLUSTERS, SELECTED_COUNT, buildProjects, stats } from '../docs/assets/js/data/projects.js';
import { SEED } from '../docs/assets/js/data/seed.js';
import { SECTIONS, FEATURED } from '../docs/assets/js/data/catalog.config.js';
import { COPY } from '../docs/assets/js/data/overrides.js';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? filesIn(resolve(directory, entry.name)) : resolve(directory, entry.name)))).flat();
}

test('all shipped JavaScript parses', async () => {
  for (const file of await filesIn(root)) {
    if (extname(file) !== '.js') continue;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${relative(root, file)}: ${result.stderr}`);
  }
});

test('local HTML, CSS, and module references resolve under the Pages subpath', async () => {
  for (const file of await filesIn(root)) {
    const extension = extname(file);
    if (!['.html', '.css', '.js'].includes(extension)) continue;
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    const patterns = extension === '.html'
      ? [/\b(?:src|href)\s*=\s*["']([^"']+)["']/g]
      : extension === '.css' ? [/url\(\s*["']?([^\s)'";]+)["']?\s*\)/g]
      : [/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/g];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
      const reference = match[1];
      if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference)) continue;
      assert.ok(!reference.startsWith('/'), `${relative(root, file)} uses a root-relative URL: ${reference}`);
      const path = decodeURIComponent(reference.split(/[?#]/)[0]);
      if (!path) continue;
      const target = resolve(dirname(file), path);
      assert.ok(!relative(root, target).startsWith('..'), `Asset escapes docs/: ${reference}`);
      await assert.doesNotReject(access(target), `${relative(root, file)} has a missing asset: ${reference}`);
    }
  }
});

test('search ranking, filters, fuzzy matching, highlighting, and escaping regressions', () => {
  assert.deepEqual(__selftest(), []);
  const index = buildIndex(PROJECTS);
  for (const query of ['constructor:x', '__proto__:x', 'toString:x', 'valueOf:x']) {
    assert.doesNotThrow(() => search(index, query), query);
  }
  assert.ok(!highlight('<img src=x onerror=alert(1)>', [[0, 4]]).includes('<img'));
});

test('fallback catalog is complete, unique, and has valid navigation targets', () => {
  assert.ok(PROJECTS.length > 0);
  assert.equal(PROJECTS.length, SELECTED_COUNT, 'Refresh the fallback seed when adding selected repositories');
  assert.equal(new Set(PROJECTS.map(project => project.id)).size, PROJECTS.length);
  const clusters = new Set(CLUSTERS.map(cluster => cluster.id));
  for (const project of PROJECTS) {
    assert.ok(clusters.has(project.cluster), project.name);
    assert.equal(new URL(project.url).protocol, 'https:');
    assert.equal(new URL(project.url).hostname, 'github.com');
    if (project.home) assert.match(new URL(project.home).protocol, /^https?:$/);
  }
  assert.equal(stats().repos, PROJECTS.length);
  assert.deepEqual(buildProjects([...SEED, ...SEED]), PROJECTS, 'Repeated API pages must not duplicate projects');
});

test('organization additions have curated copy, README links, and searchable fallback cards', async () => {
  const additions = {
    'scenedeck-android': 'streaming',
    'obs-effects-v2': 'streaming',
    'airgradient-dms-widget': 'air',
    'camx': 'iot',
    'nerd-fonts-installer-scala': 'linux',
    'obs-websocket-client': 'scala',
    'macropad-nyxilab': 'cad',
    'plastic-lighthouse': 'cad',
  };
  const readme = await readFile(new URL('../profile/README.md', import.meta.url), 'utf8');
  const index = buildIndex(PROJECTS);
  for (const [name, cluster] of Object.entries(additions)) {
    const key = `worxbend/${name}`;
    const project = PROJECTS.find(project => project.owner === 'worxbend' && project.name === name);
    assert.ok(project, key);
    assert.equal(project.cluster, cluster, key);
    assert.ok(project.curated, key);
    assert.ok(COPY[key].tagline.length <= 60, key);
    assert.ok(readme.includes(`https://github.com/${key}`), key);
    assert.ok(search(index, name).some(result => result.project === project), key);
  }
});

test('selection and featured identifiers are unique and use canonical repository URLs', () => {
  const selected = SECTIONS.flatMap(section => section.repos);
  assert.equal(new Set(selected.map(key => key.toLowerCase())).size, selected.length);
  const available = new Map(SEED.map(repo => [`${repo.owner}/${repo.name}`, repo]));
  for (const key of selected) {
    assert.ok(available.has(key), key);
    assert.equal(available.get(key).url, `https://github.com/${key}`, key);
    assert.ok(COPY[key]?.desc, `Curated copy missing for ${key}`);
  }
  for (const key of FEATURED) assert.ok(selected.includes(key), key);
});
