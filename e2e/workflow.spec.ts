import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { buildRx88Frame } from '../src/test/fixtures/frames';
import { DEMO_TARGET_PUBKEY_HEX } from '../src/demo/scenarios';
import {
  buildAnonRequestPacket,
  buildTextMessagePacket,
  OTHER_PUBLIC_KEY,
} from '../src/test/fixtures/packets';
import { connectMockAndStart, injectFrames, injectGoodFix, openTestApp } from './helpers';

test('only provably direct target receptions drive finder data and exports round-trip', async ({ page }) => {
  await openTestApp(page);
  await connectMockAndStart(page);
  await injectGoodFix(page);

  const direct = buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: DEMO_TARGET_PUBKEY_HEX }), { rssi: -74, snr: 6 });
  const forwarded = buildRx88Frame(buildAnonRequestPacket({
    senderPubkeyHex: DEMO_TARGET_PUBKEY_HEX,
    path: [OTHER_PUBLIC_KEY.slice(0, 6)],
    pathHashSize: 3,
  }), { rssi: -55, snr: 10 });
  const ambiguous = buildRx88Frame(buildTextMessagePacket({ sourceHash: 0xa1 }), { rssi: -45, snr: 12 });
  await injectFrames(page, [direct, forwarded, ambiguous]);

  await expect.poll(() => page.evaluate(() => window.__finderTest?.receptions().length)).toBe(3);
  const classifications = await page.evaluate(() => window.__finderTest?.receptions().map((item) => ({ kind: item.cls.kind, confirmed: item.cls.confirmed })));
  expect(classifications).toEqual([
    { kind: 'DIRECT_TARGET', confirmed: true },
    { kind: 'TARGET_ORIGIN_BUT_FORWARDED', confirmed: false },
    { kind: 'AMBIGUOUS_PREFIX', confirmed: false },
  ]);
  await expect(page.getByText('1 confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('TARGET ORIGIN BUT FORWARDED')).toBeVisible();
  await expect(page.getByText('AMBIGUOUS PREFIX')).toBeVisible();
  await expect(page.getByRole('meter', { name: 'Confirmed relative signal' })).toHaveAttribute('aria-valuenow', /[1-9][0-9]?|100/);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'End' }).click();
  await page.locator('a[href="#/sessions"]').click();
  await page.locator('a[href^="#/session?id="]').click();

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON + SHA-256' }).click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).not.toBeNull();
  const json = await readFile(jsonPath!, 'utf8');
  const archive = JSON.parse(json) as { simulatedData: boolean; receptions: Array<{ cls: { kind: string; confirmed: boolean } }> };
  expect(archive.simulatedData).toBe(true);
  expect(archive.receptions.filter((item) => item.cls.confirmed)).toHaveLength(1);
  const digest = createHash('sha256').update(json).digest('hex');
  await expect(page.getByText(`JSON exported · SHA-256 ${digest}`)).toBeVisible();

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  const csvPath = await (await csvDownloadPromise).path();
  const csv = await readFile(csvPath!, 'utf8');
  expect(csv).toContain('DIRECT_TARGET');
  expect(csv).toContain('TARGET_ORIGIN_BUT_FORWARDED');

  const geoDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'GeoJSON' }).click();
  const geoPath = await (await geoDownloadPromise).path();
  const geo = JSON.parse(await readFile(geoPath!, 'utf8')) as { type: string; features: unknown[] };
  expect(geo.type).toBe('FeatureCollection');
  expect(geo.features.length).toBeGreaterThanOrEqual(3);

  await page.locator('a[href="#/sessions"]').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(jsonPath!);
  await expect(page.getByText('Imported 3 receptions for review.')).toBeVisible();
  await expect(page.locator('a[href^="#/session?id="]')).toHaveCount(2);
});
