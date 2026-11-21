import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

test('the desktop terminal loads every section without browser errors', async ({ page }) => {
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
  await page.getByRole('button',{name:'Ouvrir le menu'}).click();
  await page.getByRole('navigation').getByRole('link',{name:'Scanner de marché',exact:true}).click();
  await expect(page).toHaveURL('/scanner');
  await expect(page.getByRole('main').getByRole('heading',{level:1})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('filters, opens, and bookmarks a research dossier with source timestamps', async ({ page }) => {
  await page.goto('/opportunities');
  await expect(page.getByRole('heading',{name:'Opportunités',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'Rechercher un symbole ou une société'}).fill('NVDA');
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
