import { expect, test, type Page } from '@playwright/test';
import { buildRx88Frame } from '../src/test/fixtures/frames';
import { buildAdvertPacket, buildAnonRequestPacket } from '../src/test/fixtures/packets';
import { DEMO_TARGET_PUBKEY_HEX } from '../src/demo/scenarios';
import { connectMockAndStart, injectFrames, injectGoodFix, openTestApp } from './helpers';

const target = { lat: -33.8688, lon: 151.2093 };

async function waitForReceptionCount(page: Page, count: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__finderTest?.receptions().length)).toBe(count);
}

async function recordBearing(
  page: Page,
  lat: number,
  lon: number,
  bearingDeg: number,
  destinationHash: number,
): Promise<void> {
  await injectGoodFix(page, lat, lon);
  const before = await page.evaluate(() => window.__finderTest?.receptions().length ?? 0);
  await injectFrames(page, [buildRx88Frame(buildAnonRequestPacket({
    senderPubkeyHex: DEMO_TARGET_PUBKEY_HEX,
    destinationHash,
  }), { rssi: -90, snr: 4 })]);
  await waitForReceptionCount(page, before + 1);
  await page.getByLabel('Direction (degrees true)').fill(String(bearingDeg));
  await page.getByLabel('Angular uncertainty (± degrees)').fill('8');
  await page.getByRole('button', { name: 'Save bearing with phone GPS' }).click();
  await expect(page.getByText(`${bearingDeg}° ±8°`, { exact: true })).toBeVisible();
}

test('false admin coordinates stay hidden while field bearings produce an approximate final-approach zone', async ({ page }) => {
  await openTestApp(page);
  await connectMockAndStart(page);

  await injectGoodFix(page, target.lat, target.lon - 0.001);
  await injectFrames(page, [buildRx88Frame(buildAdvertPacket({
    pubkeyHex: DEMO_TARGET_PUBKEY_HEX,
    name: 'SIMULATED Lost Repeater',
    lat: 51.5074,
    lon: -0.1278,
  }), { rssi: -94, snr: 2 })]);
  await waitForReceptionCount(page, 1);
  await expect.poll(() => page.evaluate(() => window.__finderTest?.activeTarget()?.advertisedReference)).toMatchObject({
    lat: 51.5074,
    lon: -0.1278,
    trust: 'untrusted-admin',
  });

  await page.locator('a[href="#/df"]').click();
  await recordBearing(page, target.lat, target.lon - 0.001, 90, 0x41);
  await recordBearing(page, target.lat - 0.0009, target.lon, 0, 0x42);
  await recordBearing(page, target.lat, target.lon + 0.001, 270, 0x43);

  const centreSamples = [
    { lat: target.lat, lon: target.lon - 0.0002, destinationHash: 0x44, rssi: -66 },
    { lat: target.lat, lon: target.lon, destinationHash: 0x45, rssi: -64 },
    { lat: target.lat, lon: target.lon + 0.0002, destinationHash: 0x46, rssi: -65 },
  ];
  for (const sample of centreSamples) {
    await injectGoodFix(page, sample.lat, sample.lon);
    const before = await page.evaluate(() => window.__finderTest?.receptions().length ?? 0);
    await injectFrames(page, [buildRx88Frame(buildAnonRequestPacket({
      senderPubkeyHex: DEMO_TARGET_PUBKEY_HEX,
      destinationHash: sample.destinationHash,
    }), { rssi: sample.rssi, snr: 8 })]);
    await waitForReceptionCount(page, before + 1);
  }

  await expect.poll(() => page.evaluate(() => window.__finderTest?.finalApproach())).toMatchObject({
    ready: true,
    approximate: true,
    bearingCount: 3,
  });
  const approach = await page.evaluate(() => window.__finderTest?.finalApproach());
  expect(approach?.polygon?.every(([lat, lon]) => (
    Math.abs(lat - target.lat) < 0.01 && Math.abs(lon - target.lon) < 0.01
  ))).toBe(true);

  await page.getByRole('link', { name: 'View shaded zones' }).click();
  await expect(page.getByText(/Final approach · .* confidence/)).toBeVisible();
  await expect(page.getByLabel('Admin-configured position — unverified')).not.toBeChecked();
  await expect(page.getByText('Approximate final-approach guidance')).toBeVisible();
  const visibleText = (await page.locator('main').innerText()).toLowerCase();
  expect(visibleText).not.toMatch(/\b(exact|pinpoint(?:ed)?)\b/);

  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel('Show admin-configured target position').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.locator('a[href="#/map"]').click();
  await expect(page.getByLabel('Admin-configured position — unverified')).toBeChecked();
});
