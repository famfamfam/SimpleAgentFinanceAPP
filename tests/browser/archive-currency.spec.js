import { test, expect } from '@playwright/test';
import { extname } from 'node:path';
import { clientAsset } from './helpers/client-assets.js';

test.use({ serviceWorkers: 'block' });

test('a local archive with a USD account downloads as a restorable v4 backup', async ({ page }) => {
  await page.route('http://localhost:19877/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
      const body = await clientAsset(file);
      const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
      await route.fulfill({ body, contentType });
    } catch { await route.fulfill({ status: 404 }); }
  });
  await page.goto('http://localhost:19877/');
  await page.waitForFunction(() => window.__financeReady);
  await page.evaluate(async () => {
    const db = await import('/db.js');
    const backup = await db.backup();
    backup.base[0].data.accounts[0].currency = 'USD';
    await db.setMeta('archive:1', { settings: backup.meta.find(x => x.id === 'settings').value, base: backup.base, pending: backup.outbox });
  });
  await page.getByRole('link', { name: 'Настройки', exact: true }).click();
  await page.getByRole('button', { name: 'Локальные архивы книг' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.getByRole('button', { name: 'Скачать копию' }).click(),
  ]);
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(backup.format).toBe('finance-backup-v4');
  expect(backup.base[0].data.accounts[0].currency).toBe('USD');
  expect(backup.messages).toEqual([]);
  expect(backup.media).toEqual([]);
  expect(await page.evaluate(async value => {
    try { (await import('/db.js')).backupFile(value); return true; } catch { return false; }
  }, backup)).toBe(true);
});
