import { expect, test } from '@playwright/test';
import { DEMO_TARGET_PUBKEY_HEX } from '../src/demo/scenarios';
import { buildRx88Frame } from '../src/test/fixtures/frames';
import { buildAnonRequestPacket } from '../src/test/fixtures/packets';
import { connectMockAndStart, injectFrames, injectGoodFix, openTestApp } from './helpers';

test('reload offers resume and rebuilds persisted capture state', async ({ page }) => {
  await openTestApp(page);
  await connectMockAndStart(page);
  await injectGoodFix(page);
  await injectFrames(page, [buildRx88Frame(buildAnonRequestPacket({ senderPubkeyHex: DEMO_TARGET_PUBKEY_HEX }), { rssi: -82, snr: 3 })]);
  await expect.poll(() => page.evaluate(() => window.__finderTest?.receptions().length)).toBe(1);

  await page.reload();
  await page.evaluate(() => window.__finderTest?.ready);
  await expect(page.getByRole('heading', { name: 'Resume search session?' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('heading', { name: 'Finder' })).toBeVisible();
  await expect(page.getByText('1 confirmed', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__finderTest?.receptions()[0]?.cls.kind)).toBe('DIRECT_TARGET');
});
