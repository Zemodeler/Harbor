// Browser smoke and visual checks for the local renderer. Requires Playwright.
const { chromium } = require(process.env.HARBOR_PLAYWRIGHT_PATH || 'playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

(async () => {
  const output = resolve(__dirname, 'qa'); mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.env.HARBOR_BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const checks = [];
  for (const [name, width, height, scheme] of [
    ['light', 1440, 1000, 'light'], ['dark', 1440, 1000, 'dark'],
    ['narrow', 390, 844, 'dark'], ['short', 760, 480, 'light']
  ]) {
    await page.setViewportSize({ width, height }); await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:5179/'); await page.getByText(/I've assigned the account page/).waitFor();
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    const metrics = await page.evaluate(() => {
      const composer = document.querySelector('textarea').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth, composerVisible: composer.bottom <= innerHeight && composer.top >= 0 };
    });
    if (metrics.overflow || !metrics.composerVisible) throw new Error(`${name} layout failed: ${JSON.stringify(metrics)}`);
    if (width < 761) {
      await page.getByRole('button', { name: 'Open project menu' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Harbor', exact: true }).click();
      await page.locator('header').getByRole('heading', { name: 'Harbor', exact: true }).waitFor();
      if (await page.getByRole('dialog').count()) throw new Error('Project menu did not close');
      await page.getByRole('button', { name: 'Open project menu' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Your tools, connected.' }).waitFor();
      if (await page.getByRole('dialog').count()) throw new Error('Settings did not close the project menu');
    }
    checks.push({ name, width, height, scheme, ...metrics });
  }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('http://127.0.0.1:5179/'); await page.getByText(/I've assigned the account page/).waitFor();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.screenshot({ path: resolve(output, 'settings.png') });
  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await page.getByLabel('Message Harbor').fill('Add validation'); await page.getByLabel('Message Harbor').press('Enter');
  await page.getByRole('heading', { name: 'Approve optional free reset?' }).waitFor();
  await page.screenshot({ path: resolve(output, 'permission.png') });
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('dialog').isVisible())) throw new Error('Escape dismissed an unanswered permission');
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => document.activeElement?.closest('dialog') !== null))) throw new Error('Permission focus escaped the dialog');
  }
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.getByText(/Sample reset declined/).waitFor();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy code' }).click();
  if ((await page.evaluate(() => navigator.clipboard.readText())) !== "const status = 'ready for review';") throw new Error('Code copy failed');
  await browser.close();
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ checks, errors, permission: 'explicit deny; Escape retained request' }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ checks, errors }));
})().catch(e => { console.error(e); process.exit(1); });
