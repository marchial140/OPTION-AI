import { expect, test, type Page } from "@playwright/test";
import { makeOccSymbol, optionTradingCutoff, type ContractQuote } from "../../src/lib/quant";
import { portfolioAnalytics, type AppState } from "../../src/lib/workspace";

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
  const attempts: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/api/portfolio/trades", async (route) => {
    const submission = route.request();
    attempts.push({ key: submission.headers()["idempotency-key"], body: submission.postData() });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.ok()).toBeTruthy();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const save = page.getByRole("button", { name: "Enregistrer la position" });
  await save.click();
  await expect(page.getByRole("alert").filter({ hasText: "La connexion a échoué" })).toBeVisible();
  await save.click();
  await expect(page.getByText("Position simulée enregistrée.")).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toMatch(/^[a-f0-9]{32}$/);
  expect(attempts[1]).toEqual(attempts[0]);
  await page.getByRole("button", { name: "Enregistrer une sortie de AAPL" }).click();
  await page.getByLabel("Contrats à clôturer").fill("1");
  await page.getByLabel("Solde total de sortie (USD)").fill("235");
  await page.getByRole("button", { name: "Confirmer la sortie partielle" }).click();
  await expect(page.getByText(/1 \/ 2 contrat/)).toBeVisible();

  await page.getByRole("button", { name: "Enregistrer une sortie de AAPL" }).click();
  await page.getByLabel("Solde total de sortie (USD)").fill("-5");
  await page.getByRole("button", { name: "Confirmer la clôture" }).click();
  await expect(page.getByText(/0 \/ 2 contrat/)).toBeVisible();
  await open(page, "/analytics", "Analyse de performance");
  const ticker = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "AAPL", exact: true }) });
  await expect(ticker).toContainText("-130,00");
});

test("renders the calculator and mobile navigation without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/strategy-lab");
  await expect(page.getByRole("heading", { name: "Laboratoire de stratégies" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Ouvrir le menu", exact: true }).click();
  await expect(page.getByRole("link", { name: "Tableau de bord" })).toBeVisible();
  await page.getByRole("link", { name: "Scanner de marché", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scanner de marché IA" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
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

test("opens the targeted scanner and keeps cancelled outcomes distinct", async ({ page }) => {
  await open(page, "/watchlist", "Listes de suivi");
  await page.getByRole("button", { name: /^ETF/ }).click();
  await page.getByRole("link", { name: "Scanner la liste" }).click();
  await expect(page.getByLabel("Liste de suivi")).toHaveValue("etf");
  await expect(page.getByLabel("Symboles")).toHaveValue("SPY, QQQ");
  await page.evaluate(() => window.history.pushState(null, "", "/scanner?symbol=tsla"));
  await expect(page.getByLabel("Symboles")).toHaveValue("TSLA");

  let release = () => {};
  const advance = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/scans/*/advance", async (route) => {
    await advance;
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Scanner le marché" }).click();
    await page.getByRole("button", { name: "Annuler le scan" }).click();
    await expect(page.getByText(/Scan annulé\. Les résultats/)).toBeVisible();
    await expect(page.getByText(/Aucune opportunité ne respecte/)).toHaveCount(0);
  } finally {
    release();
  }
});

test("concurrent tabs create and favorite symbols without erasing either mutation", async ({ page, context }) => {
  await open(page, "/watchlist", "Listes de suivi");
  const other = await context.newPage();
  await open(other, "/watchlist", "Listes de suivi");
  try {
    await Promise.all([
      page.getByLabel("Nouvelle liste").fill("Résultats"),
      other.getByLabel("Nouvelle liste").fill("Défensives"),
    ]);
    await Promise.all([
      page.getByRole("button", { name: "Créer", exact: true }).click(),
      other.getByRole("button", { name: "Créer", exact: true }).click(),
    ]);
    await expect(page.getByText("Liste créée.")).toBeVisible();
    await expect(other.getByText("Liste créée.")).toBeVisible();
    await Promise.all([page.reload(), other.reload()]);

    await expect(page.getByRole("button", { name: /^Résultats/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Défensives/ })).toBeVisible();
    await Promise.all([
      page.getByRole("button", { name: "Ajouter aux favoris NVDA" }).click(),
      other.getByRole("button", { name: "Ajouter aux favoris SPY" }).click(),
    ]);
    await expect(page.getByText("NVDA ajouté aux favoris.")).toBeVisible();
    await expect(other.getByText("SPY ajouté aux favoris.")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: /^Favoris/ }).click();
    await expect(page.getByText("NVDA", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("SPY", { exact: true }).first()).toBeVisible();
  } finally {
    await other.close();
  }
});

test("a live workspace begins simulations with blank market values and shows analytics limits", async ({ page }) => {
  const response = await page.request.get("/api/state");
  expect(response.ok()).toBeTruthy();
  const snapshot: AppState = await response.json();
  const now = new Date();
  const expiryDate = new Date(+now + 20 * 86400000);
  let expiry = expiryDate.toISOString().slice(0, 10);
  while (optionTradingCutoff(expiry) === null) {
    expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
    expiry = expiryDate.toISOString().slice(0, 10);
  }
  const quote: ContractQuote = {
    id: makeOccSymbol("SPY", expiry, "call", 100), symbol: "SPY", type: "call", strike: 100,
    expiration: expiry, multiplier: 100, bid: 1, ask: 1.05, currency: "USD",
    quoteAt: now.toISOString(), retrievedAt: now.toISOString(),
    source: { url: "https://www.cboe.com/", publisher: "Courtier de test", method: "manual-broker" },
    status: "MANUAL_ATTESTED",
  };
  const live: AppState = {
    ...snapshot, mode: "live", scans: [], opportunities: [], candidates: [], portfolio: [],
    manualQuotes: [quote], analytics: portfolioAnalytics([]), marketSeries: { quotes: [], trend: [] },
    research: { configured: false, schedulerConfigured: false },
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: live }));
  await page.goto("/strategy-lab");
  await expect(page.getByRole("heading", { name: "Laboratoire de stratégies" })).toBeVisible();
  await expect(page.getByLabel("Sous-jacent", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Prime achetée par action")).toHaveValue("");
  await expect(page.getByText("Profil indisponible")).toBeVisible();

  await page.goto("/portfolio");
  await page.getByRole("button", { name: "Nouvelle position" }).click();
  await expect(page.getByLabel("Sous-jacent", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Prime achetée par action")).toHaveValue("");

  await page.goto("/analytics");
  await expect(page.getByText("Aucune sortie enregistrée")).toBeVisible();
  await expect(page.getByText(/Fonction indisponible. Un test rétrospectif/)).toBeVisible();
  await expect(page.getByText("DEMO — DONNÉES FICTIVES", { exact: true })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByText("Attestée · indicative", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Courtier de test" })).toHaveAttribute("href", "https://www.cboe.com/");
});
