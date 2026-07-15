import { expect, type Page } from '@playwright/test';

export async function openTestApp(page: Page): Promise<void> {
  await page.goto('/?e2e=1&nosw=1#/connect');
  await page.evaluate(() => window.__finderTest?.ready);
  const acknowledgement = page.getByRole('checkbox', { name: 'I understand and am authorised to search Required once on this device' });
  if (await acknowledgement.isVisible()) {
    await acknowledgement.check();
    await page.getByRole('button', { name: 'Continue' }).click();
  }
}

export async function connectMockAndStart(page: Page): Promise<void> {
  await page.evaluate(async () => window.__finderTest?.connectMock());
  await expect(page.getByText('Radio connected')).toBeVisible();
  await page.locator('a[href="#/finder"]').click();
  await page.getByRole('button', { name: 'Start walk' }).click();
  await expect(page.getByRole('button', { name: 'End' })).toBeVisible();
}

export async function injectGoodFix(page: Page, lat = -33.8688, lon = 151.2093): Promise<void> {
  await page.evaluate(async ({ latitude, longitude }) => {
    const now = Date.now();
    await window.__finderTest?.injectGps({
      t: now,
      posT: now,
      lat: latitude,
      lon: longitude,
      accuracy: 6,
      speed: 1.2,
      heading: 90,
      accepted: true,
      quality: 'good',
    });
  }, { latitude: lat, longitude: lon });
}

export async function injectFrames(page: Page, frames: readonly Uint8Array[]): Promise<void> {
  await page.evaluate((arrays) => {
    for (const bytes of arrays) window.__finderTest?.injectFrame(Uint8Array.from(bytes));
  }, frames.map((frame) => [...frame]));
}
