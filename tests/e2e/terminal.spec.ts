import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import type { AppState } from '../../src/lib/workspace';

test('the desktop terminal loads every section without browser errors', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width:1440, height:1000 });
  const errors: string[] = [];
  page.on('pageerror',(error) => errors.push(error.message));
  page.on('console',(message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Votre centre d.intelligence/})).toBeVisible();
  await expect(page.getByText('DEMO — DONNÉES FICTIVES',{exact:true})).toBeVisible();
  await page.screenshot({path:resolve('work/terminal-desktop.png'),animations:'disabled',fullPage:true});
  const navigation = page.getByRole('navigation');
  for (const name of ['Scanner de marché','Opportunités','Laboratoire','Assistant IA','Listes de suivi',
    'Portefeuille papier','Performances','Historique','Paramètres','Tableau de bord']) {
    const link = navigation.getByRole('link',{name,exact:true});
    await link.click();
    await expect(link).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('main').getByRole('heading',{level:1})).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('the mobile menu reaches the scanner and stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Votre centre d.intelligence/})).toBeVisible();
  await page.screenshot({path:resolve('work/terminal-mobile.png'),animations:'disabled'});
  const openMenu = page.getByRole('button',{name:'Ouvrir le menu'});
  await openMenu.click();
  await expect(page.getByRole('button',{name:'Fermer le menu'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(openMenu).toBeFocused();
  await openMenu.click();
  await page.getByRole('navigation').getByRole('link',{name:'Scanner de marché',exact:true}).click();
  await expect(page).toHaveURL('/scanner');
  await expect(page.getByRole('main').getByRole('heading',{level:1})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize({width:320,height:700});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expect(page.getByText('DEMO — DONNÉES FICTIVES',{exact:true})).toBeInViewport();
});

test('filters, opens, and bookmarks a research dossier with source timestamps', async ({ page }) => {
  await page.goto('/opportunities');
  await expect(page.getByRole('heading',{name:'Opportunités',exact:true})).toBeVisible();
  const search = page.getByRole('searchbox',{name:'Rechercher un symbole ou une société'});
  await search.fill('ticker-inexistant');
  await expect(page.getByText('Aucun résultat pour ces filtres.')).toBeVisible();
  await page.getByRole('button',{name:'Effacer les filtres'}).click();
  await expect(search).toHaveValue('');
  await search.fill('NVDA');
  await expect(page.getByRole('link',{name:/Ouvrir NVDA/})).toBeVisible();
  await expect(page.getByRole('link',{name:/Ouvrir TSLA/})).toHaveCount(0);
  await page.getByRole('link',{name:/Ouvrir NVDA/}).click();
  await expect(page.getByRole('heading',{name:'Contrats',exact:true})).toBeVisible();
  await expect(page.getByRole('columnheader',{name:'Horodatage'})).toBeVisible();
  await expect(page.getByRole('columnheader',{name:'Source'})).toBeVisible();
  await page.getByRole('button',{name:'Enregistrer la recherche'}).click();
  await expect(page.getByRole('button',{name:'Retirer des enregistrements'})).toHaveAttribute('aria-pressed','true');
  await page.goto('/opportunities?view=saved');
  await expect(page.getByRole('button',{name:/Enregistrées 1/})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('link',{name:/Ouvrir NVDA/})).toBeVisible();
  await expect(page.getByRole('link',{name:/Ouvrir TSLA/})).toHaveCount(0);
});

test('keyboard shortcuts trap focus in their dialog and close with Escape', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Votre centre d.intelligence/})).toBeVisible();
  const shortcuts = page.getByRole('button',{name:/Raccourcis clavier/});
  await shortcuts.click();
  const dialog = page.getByRole('dialog',{name:'Raccourcis clavier'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Fermer'})).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')) || document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(shortcuts).toBeFocused();
  await page.keyboard.press('Alt+2');
  await expect(page).toHaveURL('/scanner');
});

test('the comparison ignores an unknown bookmark, accepts three valid choices and renders their payoffs', async ({ page }) => {
  await page.goto('/opportunities?compare=opportunite-supprimee');
  const comparison = page.getByRole('region',{name:'Comparateur de stratégies'});
  await expect(page.getByRole('heading',{name:'Opportunités',exact:true})).toBeVisible();
  await expect(comparison).toHaveCount(0);
  const checks = page.getByRole('checkbox',{name:/Comparer /});
  await expect(checks.first()).toBeVisible();
  for (let index = 0; index < 3; index++) await checks.nth(index).check();
  await expect(comparison.getByText('3 / 3 sélectionnées')).toBeVisible();
  await expect(checks.nth(3)).toBeDisabled();
  await page.getByRole('link',{name:'Comparateur (3)'}).click();
  await comparison.getByRole('button',{name:'Comparer',exact:true}).click();
  await expect(comparison.getByRole('group',{name:/Profil de /})).toHaveCount(3);
  await expect(comparison.locator('.recharts-area-curve')).toHaveCount(3);
  await comparison.getByRole('button',{name:'Effacer'}).click();
  await expect(comparison).toHaveCount(0);
  await expect(checks.nth(3)).toBeEnabled();
});

test('columns can be added and hidden with keyboard access', async ({ page }) => {
  await page.goto('/opportunities');
  await expect(page.getByRole('heading',{name:'Opportunités',exact:true})).toBeVisible();
  const table = page.getByRole('region',{name:'Tableau des stratégies'});
  const columns = page.getByRole('button',{name:'Colonnes'});
  await columns.click();
  const expiration = page.getByRole('checkbox',{name:'Échéance',exact:true});
  await expect(table.getByRole('columnheader',{name:'Échéance'})).toHaveCount(0);
  await expiration.check();
  await expect(table.getByRole('columnheader',{name:'Échéance'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(columns).toBeFocused();
  await expect(columns).toHaveAttribute('aria-expanded','false');
});

test('live screens distinguish attested broker prices from independent verification', async ({ page }) => {
  await page.route('**/api/state', async (route) => {
    const response = await route.fetch();
    const state = await response.json() as AppState;
    const demo = state.opportunities.find((opportunity) => opportunity.symbol === 'NVDA');
    if (!demo) throw new Error('La fixture de stratégie est absente.');
    const manual = {
      ...demo, status:'MANUAL_ATTESTED', price:null,
      input: {
        ...demo.input, legs:demo.input.legs.map((leg) => ({
          ...leg, status:'MANUAL_ATTESTED',
          source:{ url:'https://example.com/quotes', publisher:'Courtier de test' },
        })),
      },
    };
    state.mode = 'live';
    state.user.email = 'test@example.com';
    state.scans = [];
    state.candidates = [];
    state.marketSeries = {quotes:[],trend:[]};
    state.opportunities = [manual] as AppState['opportunities'];
    await route.fulfill({response,json:state});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Votre centre d.intelligence/})).toBeVisible();
  await expect(page.getByText('DEMO — DONNÉES FICTIVES',{exact:true})).toHaveCount(0);
  await expect(page.getByText('0 vérifiées · 1 sur saisie courtier attestée')).toBeVisible();
  await page.getByRole('link',{name:/Ouvrir NVDA/}).click();
  await expect(page.getByText('Courtier · attestée',{exact:true})).toBeVisible();
  await expect(page.getByText(/Cotations courtier attestées par l’utilisateur. Estimation indicative./)).toBeVisible();
  await expect(page.getByRole('link',{name:'Courtier de test'})).toHaveCount(2);
});

test('the account menu opens the source diagnostics and the available demo sign-in', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({json:{status:'ok',authConfigured:false,demoAvailable:true}}));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Votre centre d.intelligence/})).toBeVisible();
  await page.getByRole('button',{name:'Menu du compte'}).click();
  await page.getByRole('link',{name:/^(État des sources|Recherche OpenAI configurée)$/}).click();
  await expect(page).toHaveURL('/settings#data-sources');
  await expect(page.getByRole('heading',{name:'Diagnostics des sources',exact:true})).toBeInViewport();
  await page.getByRole('button',{name:'Menu du compte'}).click();
  await page.getByRole('link',{name:'Ouvrir la connexion'}).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(/La connexion par courriel est indisponible/)).toBeVisible();
  await page.getByRole('button',{name:'Ouvrir la démonstration'}).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('DEMO — DONNÉES FICTIVES',{exact:true})).toBeVisible();
});
