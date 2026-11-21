import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  await expect(page.getByText("DEMO — DONNÉES FICTIVES", { exact: true })).toBeVisible();
}

test("runs a demo scan, archives the evidence, and explores the payoff calculator", async ({ page }) => {
  await open(page, "/scanner", "Scanner de marché IA");
  await page.getByLabel("Symboles", { exact: true }).fill("NVDA");
  await page.getByRole("button", { name: "Scanner le marché", exact: true }).click();
  const report = page.locator("section").filter({ has: page.getByRole("heading", { name: "Suivi du scan", exact: true }) });
  await expect(report.getByText("Analysés · NVDA")).toBeVisible({ timeout: 20_000 });
  await expect(report.getByText("Terminé", { exact: true })).toBeVisible();
  await expect(report.getByRole("button", { name: "Exporter ce scan" })).toBeVisible();

  await page.getByRole("link", { name: "Historique", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Historique de recherche" })).toBeVisible();
  await page.getByLabel("Rechercher un scan").fill("NVDA");
  await expect(page.getByRole("heading", { name: "Scan rapide" })).toBeVisible();

  await open(page, "/strategy-lab", "Laboratoire de stratégies");
  await expect(page.getByText("Débit d’entrée", { exact: true }).locator("..")).toContainText("180,00");
  await expect(page.getByText("Gain maximal", { exact: true }).locator("..")).toContainText("320,00");
  await expect(page.getByText("Seuil de rentabilité", { exact: true }).locator("..")).toContainText("101,80");
  await page.getByRole("button", { name: "Ajouter à la comparaison" }).click();
  await expect(page.getByRole("button", { name: "Retirer la comparaison 1" })).toBeVisible();
  await page.getByLabel("Prime achetée par action").fill("3.70");
  await expect(page.getByText("Débit d’entrée", { exact: true }).locator("..")).toContainText("230,00");
  await page.getByRole("button", { name: "Afficher les scénarios types" }).click();
  await expect(page.getByRole("columnheader", { name: "Variation" })).toBeVisible();
});

test("persists settings and watchlist mutations across reloads", async ({ page }) => {
  await open(page, "/settings", "Réglages");
  await page.getByLabel("Capital du compte (USD)").fill("12500");
  await page.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await expect(page.getByText("Réglages enregistrés.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Capital du compte (USD)")).toHaveValue("12500");

  await open(page, "/watchlist", "Listes de suivi");
  await page.getByLabel("Ajouter un symbole").fill("AAPL");
  await page.getByRole("button", { name: "Ajouter", exact: true }).click();
  await expect(page.getByRole("cell", { name: "AAPL", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ajouter aux favoris AAPL", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retirer des favoris AAPL", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: "Retirer des favoris AAPL", exact: true })).toBeVisible();
});

test("opens a paper position, records partial and full exits, then reads realized analytics", async ({ page }) => {
  await open(page, "/portfolio", "Portefeuille papier");
  await page.getByRole("button", { name: "Nouvelle position" }).click();
  await page.getByLabel("Sous-jacent", { exact: true }).fill("AAPL");
  await page.getByLabel("Contrats", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Enregistrer la position" }).click();
  await expect(page.getByText("Position simulée enregistrée.")).toBeVisible();
  await page.getByRole("button", { name: "Enregistrer une sortie de AAPL" }).click();
  await page.getByLabel("Contrats à clôturer").fill("1");
  await page.getByLabel("Crédit total de sortie (USD)").fill("210");
  await page.getByRole("button", { name: "Confirmer la sortie partielle" }).click();
  await expect(page.getByText(/1 \/ 2 contrat/)).toBeVisible();

  await page.getByRole("button", { name: "Enregistrer une sortie de AAPL" }).click();
  await page.getByLabel("Crédit total de sortie (USD)").fill("190");
  await page.getByRole("button", { name: "Confirmer la clôture" }).click();
  await expect(page.getByText(/0 \/ 2 contrat/)).toBeVisible();
  await open(page, "/analytics", "Analyse de performance");
  await expect(page.getByRole("cell", { name: "AAPL", exact: true })).toBeVisible();
});

test("renders the calculator and mobile navigation without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/strategy-lab");
  await expect(page.getByRole("heading", { name: "Laboratoire de stratégies" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Ouvrir le menu", exact: true }).click();
  await expect(page.getByRole("link", { name: "Tableau de bord" })).toBeVisible();
});

test("reports a scanner input error and answers a research question using demo context", async ({ page }) => {
  await open(page, "/scanner", "Scanner de marché IA");
  await page.getByLabel("Symboles", { exact: true }).fill("???");
  await page.getByRole("button", { name: "Scanner le marché", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "format attendu" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scanner le marché", exact: true })).toBeEnabled();

  await open(page, "/assistant", "Assistant de recherche IA");
  await page.getByRole("button", { name: "Explique la différence entre gain maximal et rendement attendu." }).click();
  await page.getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect(page.getByRole("log").getByText(/Le gain maximal décrit le meilleur résultat possible/)).toBeVisible();
});
