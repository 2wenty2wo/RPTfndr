import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const root = new URL('..', import.meta.url);

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check through npm run test:hosting.');

const variants = [
  { name: 'root', basePath: undefined, emittedBase: './', outDir: 'dist-hosting-root' },
  {
    name: 'subpath',
    basePath: '/tools/meshcore-finder',
    emittedBase: '/tools/meshcore-finder/',
    outDir: 'dist-hosting-subpath',
  },
];

for (const variant of variants) {
  const dist = new URL(`../${variant.outDir}/`, import.meta.url);
  await rm(dist, { recursive: true, force: true });

  try {
    const env = { ...process.env };
    if (variant.basePath) env.BASE_PATH = variant.basePath;
    else delete env.BASE_PATH;
    const build = spawnSync(process.execPath, [npmCli, 'run', 'build', '--', '--outDir', variant.outDir], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (build.status !== 0) {
      process.stdout.write(build.stdout ?? '');
      process.stderr.write(build.stderr ?? '');
      throw new Error(`${variant.name} hosted build failed`);
    }

    const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', dist), 'utf8'));
    assert.equal(manifest.start_url, './', `${variant.name}: manifest start_url`);
    assert.equal(manifest.scope, './', `${variant.name}: manifest scope`);
    assert.equal(manifest.id, './', `${variant.name}: manifest id`);

    const index = await readFile(new URL('index.html', dist), 'utf8');
    assert.match(index, new RegExp(`(?:src|href)="${escapeRegExp(variant.emittedBase)}assets/`));
    assert.ok(
      index.includes(`href="${variant.emittedBase}manifest.webmanifest"`),
      `${variant.name}: manifest link must stay under the deployment base`,
    );

    const assetNames = await readdir(new URL('assets/', dist));
    const registerName = assetNames.find((name) => name.startsWith('virtual_pwa-register-'));
    assert.ok(registerName, `${variant.name}: generated service-worker registration module`);
    const registration = await readFile(new URL(`assets/${registerName}`, dist), 'utf8');
    assert.ok(
      registration.includes(`\`${variant.emittedBase}sw.js\``),
      `${variant.name}: service-worker URL must stay under the deployment base`,
    );
    assert.ok(
      registration.includes(`scope:\`${variant.emittedBase}\``),
      `${variant.name}: service-worker scope must match the deployment base`,
    );

    const serviceWorker = await readFile(new URL('sw.js', dist), 'utf8');
    assert.ok(serviceWorker.includes('createHandlerBoundToURL("index.html")'), `${variant.name}: offline navigation fallback`);
    assert.ok(serviceWorker.includes('cacheName:"map-tiles"'), `${variant.name}: bounded map-tile cache`);
    assert.ok(serviceWorker.includes('maxEntries:300'), `${variant.name}: map-tile entry limit`);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
}

process.stdout.write('Hosted PWA root and subpath builds verified.\n');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
