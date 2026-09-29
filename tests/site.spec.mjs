import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SEED } from '../docs/assets/js/data/seed.js';

// Exercise the committed fallback, keeping CI independent of API quotas and CDN uptime.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
});

async function openSite(page) {
  await page.goto('/docs/');
  await expect(page.locator('#catalog-grid .card').first()).toBeVisible();
}

test('initial grid stays silent and does not download optional graphics', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const errors = [];
  const unnecessaryRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\.(mp3|ogg)(?:\?|$)|(?:three|pixi|cosmos|glyphs|singularity)(?:@|\.|\/)/i.test(request.url())) {
      unnecessaryRequests.push(request.url());
    }
  });
  await openSite(page);
  await expect(page.locator('#catalog-source')).toContainText(/saved|snapshot/i);
  await expect(page.locator('#sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('h1')).toContainText('Small tools.');
  expect(unnecessaryRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('search and category survive reload together, with an actionable empty state', async ({ page }) => {
  await openSite(page);
  await page.locator('#catalog-search').fill('obs');
  await page.locator('[data-filter="streaming"]').click();
  await expect(page).toHaveURL(/#\/q\/obs\?cluster=streaming$/);
  const count = await page.locator('#catalog-grid .card').count();
  expect(count).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('#catalog-search')).toHaveValue('obs');
  await expect(page.locator('[data-filter="streaming"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#catalog-grid .card')).toHaveCount(count);
  await page.locator('#catalog-search').fill('zzzznonexistentzzzz');
  await expect(page.locator('#catalog-grid .card')).toHaveCount(0);
  await page.locator('#catalog-clear').click();
  await expect(page.locator('#catalog-search')).toHaveValue('');
  await expect(page.locator('#catalog-grid .card').first()).toBeVisible();
});

test('command palette traps focus, isolates the background, and restores focus', async ({ page }) => {
  await openSite(page);
  const opener = page.locator('#open-palette');
  await opener.click();
  await expect(page.locator('#palette-input')).toBeFocused();
  await expect(page.locator('main')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('#palette').contains(document.activeElement))).toBe(true);
  await page.locator('#palette-input').fill('scenedeck');
  await expect(page.locator('#palette-list')).toContainText('scenedeck');
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette')).toBeHidden();
  await expect(page.locator('main')).toHaveJSProperty('inert', false);
  await expect(opener).toBeFocused();
});

test('appearance works by keyboard and keeps the selected theme after reload', async ({ page }) => {
  await openSite(page);
  const summary = page.locator('details.appearance summary');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details.appearance')).toHaveAttribute('open', '');
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-theme-id="foundation"]')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'foundation');
  await expect(page.locator('details.appearance')).not.toHaveAttribute('open', '');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'foundation');
});

test('hero preserves both gutters without horizontal overflow', async ({ page }) => {
  await openSite(page);
  const geometry = await page.evaluate(() => {
    const container = document.querySelector('.hero-composition').getBoundingClientRect();
    const copy = document.querySelector('.hero-copy').getBoundingClientRect();
    return { containerLeft: container.left, containerRight: container.right, copyLeft: copy.left,
      copyRight: copy.right, scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  expect(geometry.copyLeft).toBeGreaterThanOrEqual(geometry.containerLeft - 1);
  expect(geometry.copyRight).toBeLessThanOrEqual(geometry.containerRight + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport + 1);
});

test('all five themes meet automated WCAG A and AA checks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Theme colors are shared across viewport sizes');
  test.setTimeout(60_000);
  await openSite(page);
  for (const theme of ['foundation', 'matrix', 'blueprint', 'nebula', 'solar']) {
    await page.locator('details.appearance summary').click();
    await page.locator(`[data-theme-id="${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations, `${theme} accessibility violations`).toEqual([]);
  }
});

test('live refresh updates metadata while preserving focused cards and empty-response fallback', async ({ page }) => {
  let stage = 'offline';
  let stars = 999;
  // Later Playwright routes take precedence over the general external-network block.
  await page.route('https://api.github.com/**', route => {
    if (stage === 'offline') return route.abort();
    const owner = new URL(route.request().url()).pathname.split('/')[2];
    const repos = stage === 'empty' ? [] : SEED.filter(repo => repo.owner === owner).map(repo => ({
      name: repo.name, html_url: repo.url, description: repo.description,
      homepage: repo.name === 'scenedeck' ? 'https://example.com/refreshed' : repo.home,
      language: repo.name === 'scenedeck' ? 'Kotlin' : repo.lang,
      stargazers_count: repo.name === 'scenedeck' ? stars : repo.stars,
      pushed_at: repo.name === 'scenedeck' ? '2026-09-29T12:00:00Z' : repo.updated,
      topics: repo.name === 'scenedeck' ? ['refresh-verification'] : repo.topics,
      forks_count: repo.forks, fork: repo.isFork, archived: repo.isArchived,
    }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(repos) });
  });
  await openSite(page);
  await expect(page.locator('#catalog-source')).toContainText(/saved|snapshot/i);
  const card = page.locator('#card-scenedeck');
  await card.locator('[data-open]').focus();
  await page.evaluate(() => {
    window.savedCard = document.querySelector('#card-scenedeck');
    window.savedLink = document.activeElement;
  });
  const refresh = () => page.evaluate(async () => {
    const { loadCatalog } = await import('./assets/js/data/projects.js');
    await loadCatalog({ force: true });
  });
  stage = 'live';
  await refresh();
  expect(await page.evaluate(() => window.savedCard === document.querySelector('#card-scenedeck') &&
    window.savedLink === document.activeElement)).toBe(true);
  await expect(card.locator('.card__stars')).toContainText('999');
  await expect(card.locator('.card__head .chip')).toHaveText('Kotlin');
  await expect(card.locator('.card__foot a')).toHaveAttribute('href', 'https://example.com/refreshed');
  await expect(card.locator('.card__updated')).toHaveAttribute('title', 'Pushed on 2026-09-29');
  await expect(card.locator('[data-topic]')).toHaveText('refresh-verification');
  await expect(page.locator('#catalog-source')).toHaveText('Live from GitHub');
  await card.locator('[data-topic]').focus();
  stars = 1001;
  await refresh();
  await expect(card.locator('[data-topic]')).toBeFocused();
  await expect(card.locator('.card__stars')).toContainText(/1K|1,001/);
  await page.locator('#view-constellation').click();
  await page.evaluate(() => { location.hash = '/p/scenedeck'; });
  const detail = page.locator('#star-card-scenedeck');
  await detail.locator('[data-open]').focus();
  stars = 2002;
  await refresh();
  await expect(detail.locator('.card__stars')).toContainText(/2K|2,002/);
  await expect(detail.locator('[data-open]')).toBeFocused();
  const count = await page.locator('#catalog-grid .card').count();
  stage = 'empty';
  await refresh();
  await expect(page.locator('#catalog-grid .card')).toHaveCount(count);
  await expect(page.locator('#catalog-source')).toHaveText(/^Cached snapshot.*Refresh unavailable$/);
});
