import { expect, test } from '@playwright/test';

test('unsupported browsers explain Bluefy and can import an archive for review', async ({ page }) => {
  await page.addInitScript(() => {
    let prototype: object | null = Navigator.prototype;
    while (prototype) {
      Reflect.deleteProperty(prototype, 'bluetooth');
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    Reflect.deleteProperty(navigator, 'bluetooth');
  });
  await page.goto('/?nosw=1#/connect');
  await expect(page.getByRole('heading', { name: 'Connect from a supported browser' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'iPhone / iPad with Bluefy' })).toBeVisible();

  const acknowledgement = page.getByRole('checkbox', { name: 'I understand and am authorised to search Required once on this device' });
  await acknowledgement.check();
  await page.getByRole('button', { name: 'Continue' }).click();

  const now = Date.now();
  const archive = {
    format: 'meshcore-finder-session',
    version: 1,
    exportedAt: new Date(now).toISOString(),
    simulatedData: false,
    session: {
      id: 'review-only-session',
      title: 'Imported review log',
      createdAt: now,
      startedAt: now,
      endedAt: now,
      state: 'ended',
      targetSnapshot: {
        id: 'review-target',
        label: 'Review target',
        identity: { kind: 'node-id', bytesHex: 'a1b2c3d4' },
        source: 'manual',
        createdAt: now,
        updatedAt: now,
      },
      app: { version: '1.0.0', commit: 'test', decoderVersion: '0.3.0' },
      mode: 'walk',
      demo: false,
      settings: {
        cellSizeM: 12,
        minSamples: 5,
        minCells: 3,
        smoothingWindow: 7,
        emaAlpha: 0.3,
        maxGpsAccuracyM: 75,
        audioMode: 'off',
        audioVolume: 0.8,
        audioMuted: false,
        forwardedAlert: false,
      },
      counters: {
        receptions: 0,
        confirmed: 0,
        located: 0,
        fixesAccepted: 0,
        fixesRejected: 0,
        decodeFailed: 0,
        discoveries: 0,
      },
    },
    receptions: [],
    fixes: [],
    events: [],
  };
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import log for review' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await expect(page.getByText('Imported 0 receptions for review.')).toBeVisible();
  await page.locator('a[href="#/sessions"]').click();
  await expect(page.getByText('Imported review log')).toBeVisible();
});
