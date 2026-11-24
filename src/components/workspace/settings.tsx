"use client";

import { useState } from "react";
import { Database, Download, Save, Settings2, Trash2 } from "lucide-react";
import { makeOccSymbol, strategyLabels, validateQuote } from "@/lib/quant";
import type { ScoreKey } from "@/lib/quant";
import type { AppState, Settings } from "@/lib/workspace";
import { strategyKeys } from "./strategy-lab";
import { actionForm, dataLabels, downloadJson, Empty, errorMessage, Field, Heading, money, Notice, Panel, request, SourceLink, Status, Submit, timestamp } from "./ui";

type Refresh = () => Promise<void>;
type NumberKey = KeysOf<Settings, number>;
type KeysOf<T, Value> = { [K in keyof T]-?: T[K] extends Value ? K : never }[keyof T];

const defaultWeights: Record<ScoreKey, number> = { liquidity: 30, payoff: 25, direction: 20, execution: 15, quality: 10 };
const weightLabels: Record<ScoreKey, string> = {
  liquidity: "Liquidité", payoff: "Profil gain / perte", direction: "Cohérence directionnelle",
  execution: "Efficacité d’exécution", quality: "Qualité des données",
};
const weightKeys = Object.keys(weightLabels) as ScoreKey[];

const weekdays = [
  [1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"],
] as const;

function Preferences({ state, refresh }: { state: AppState; refresh: Refresh }) {
  const [settings, setSettings] = useState(state.settings);
  const [changed, setChanged] = useState<Set<keyof Settings>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [alert, setAlert] = useState("");
  const weights = { ...defaultWeights, ...settings.scoreWeights };
  const weightTotal = weightKeys.reduce((sum, key) => sum + weights[key], 0);

  const change = <Key extends keyof Settings>(key: Key, value: Settings[Key]) => {
    setChanged((keys) => keys.has(key) ? keys : new Set(keys).add(key));
    setSettings((current) => ({ ...current, [key]: value }));
    setAlert("");
    setError("");
  };
  const numeric = (key: NumberKey, label: string, min: number, max: number, step = 1) =>
    <Field label={label}><input type="number" required min={min} max={max} step={step} value={Number.isNaN(settings[key]) ? "" : settings[key]}
      onChange={(event) => change(key, event.target.value === "" ? Number.NaN : Number(event.target.value))} /></Field>;
  const submit = async () => {
    setBusy(true);
    setError("");
    setAlert("");
    if (!settings.strategies.length || !settings.schedule.weekdays.length || settings.minDte > settings.maxDte || settings.riskPerTrade > settings.maxPortfolioRisk) {
      setError("Vérifiez la plage d’échéances, les deux limites de risque, les jours et les stratégies sélectionnées.");
      setBusy(false);
      return;
    }
    if (!Number.isFinite(weightTotal) || Math.abs(weightTotal - 100) > .000001) {
      setError("La pondération des critères de classement doit totaliser 100 %.");
      setBusy(false);
      return;
    }
    try {
      const edits = Object.fromEntries([...changed].map((key) => [key, settings[key]]));
      const response = await request<{ settings: Settings }>("/api/settings", "PATCH", edits);
      setChanged(new Set());
      setSettings(response.settings);
      await refresh();
      setAlert("Réglages enregistrés.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <form className="wp-form" onSubmit={actionForm(() => void submit())}>
    <fieldset className="wp-form-lock" disabled={busy}>
    <div className="wp-grid wp-grid-even">
      <div className="wp-stack">
        <Panel title="Capital et risque" detail="Ces limites s’appliquent à la recherche et au portefeuille papier.">
          <div className="wp-fields">
            {numeric("accountCapital", "Capital du compte (USD)", .01, 1_000_000_000, .01)}
            {numeric("riskPerTrade", "Risque par position (%)", 0, 100, .01)}
            {numeric("maxPortfolioRisk", "Risque total du portefeuille (%)", 0, 100, .01)}
            {numeric("maxPositions", "Positions ouvertes maximales", 1, 100)}
            {numeric("maxContracts", "Contrats par position", 1, 100)}
            {numeric("minDte", "Échéance minimale (jours)", 0, 730)}
            {numeric("maxDte", "Échéance maximale (jours)", 0, 730)}
          </div>
          <fieldset className="wp-segment"><legend className="wp-micro">Stratégies autorisées</legend>
            {strategyKeys.map((key) => <label key={key}><input type="checkbox" checked={settings.strategies.includes(key)} onChange={(event) => change("strategies",
              event.target.checked ? [...settings.strategies, key] : settings.strategies.filter((strategy) => strategy !== key))} /> {strategyLabels[key]}</label>)}
          </fieldset>
          <label className="wp-check"><input type="checkbox" checked={settings.avoidEarnings} onChange={(event) => change("avoidEarnings", event.target.checked)} /> Écarter les positions qui couvrent une publication de résultats</label>
          <label className="wp-check"><input type="checkbox" checked={settings.avoidNearExpiration} onChange={(event) => change("avoidNearExpiration", event.target.checked)} /> Écarter les échéances très proches</label>
        </Panel>
        <Panel title="Liquidité des contrats">
          <div className="wp-fields">
            {numeric("minVolume", "Volume minimal", 0, 100_000_000)}
            {numeric("minOpenInterest", "Positions ouvertes minimales", 0, 100_000_000)}
            {numeric("maxSpreadPercent", "Écart bid–ask maximal (%)", 0, 100, .01)}
          </div>
        </Panel>
        <Panel title="Pondération du classement" detail="Définissez la contribution de chaque critère au score sur 100.">
          <div className="wp-fields">
            {weightKeys.map((key) => <Field key={key} label={weightLabels[key] + " (%)"}><input type="number" required min="0" max="100" step=".1"
              value={Number.isNaN(weights[key]) ? "" : weights[key]} onChange={(event) => change("scoreWeights", {
                ...weights, [key]: event.target.value === "" ? Number.NaN : Number(event.target.value),
              })} /></Field>)}
          </div>
          <p className="wp-micro">Total · {Number.isFinite(weightTotal) ? new Intl.NumberFormat("fr-CA").format(weightTotal) : "—"} %</p>
        </Panel>
      </div>
      <div className="wp-stack">
        <Panel title="Budget de recherche" detail="Les plafonds et les coûts estimés sont exprimés en USD.">
          <div className="wp-fields">
            {numeric("dailyBudget", "Budget journalier (USD)", 0, 100, .01)}
            {numeric("monthlyBudget", "Budget mensuel (USD)", 0, 1000, .01)}
            {numeric("dailySearchLimit", "Recherches web par jour", 0, 300)}
            {numeric("maxRequestsPerScan", "Requêtes par scan", 1, 60)}
          </div>
          <div className="wp-card-row">
            <p>Aujourd’hui · {state.cost.requests} requête(s), {state.cost.searches} recherche(s) web.</p>
            <p>Coût réconcilié estimé · Aujourd’hui {money(state.cost.daily)} · Ce mois {money(state.cost.monthly)}</p>
            {(state.cost.dailyUnreconciled || state.cost.monthlyUnreconciled) ? <p>Usage en attente de rapprochement · Aujourd’hui {money(state.cost.dailyUnreconciled)} · Ce mois {money(state.cost.monthlyUnreconciled)}</p> : null}
            {state.cost.pending ? <p>Budget réservé aux demandes en cours · {money(state.cost.pending)}</p> : null}
          </div>
          {!state.research.pricingConfigured && <Notice>Renseignez les tarifs du modèle et de la recherche web côté serveur pour estimer les coûts de l’espace réel.</Notice>}
        </Panel>
        <Panel title="Scan automatique" detail="Horaire du marché américain · America/New_York">
          <label className="wp-check"><input type="checkbox" checked={settings.schedule.enabled} onChange={(event) => change("schedule", { ...settings.schedule, enabled: event.target.checked })} /> Activer le scan automatique</label>
          <div className="wp-fields">
            <Field label="Heure du scan"><input type="time" required value={settings.schedule.time} onChange={(event) => change("schedule", { ...settings.schedule, time: event.target.value })} /></Field>
            <Field label="Liste analysée"><select value={settings.schedule.watchlistId ?? ""} onChange={(event) => change("schedule", { ...settings.schedule, watchlistId: event.target.value || null })}>
              <option value="">Liste principale</option>{state.watchlists.map((list) => <option value={list.id} key={list.id}>{list.name}</option>)}
            </select></Field>
          </div>
          <fieldset className="wp-segment"><legend className="wp-micro">Jours de scan</legend>
            {weekdays.map(([day, label]) => <label key={day}><input type="checkbox" checked={settings.schedule.weekdays.includes(day)}
              onChange={(event) => change("schedule", { ...settings.schedule, weekdays: event.target.checked ? [...settings.schedule.weekdays, day] : settings.schedule.weekdays.filter((item) => item !== day) })} /> {label}</label>)}
          </fieldset>
          <small className="wp-micro">Les exécutions programmées suivent les horaires et jours d’ouverture du marché américain.</small>
          {settings.schedule.enabled && <Notice>{state.research.schedulerConfigured
            ? "Une clé du planificateur est configurée. Les scans dépendent des appels du déclencheur d’hébergement."
            : "Le déclencheur d’hébergement nécessite une clé du planificateur. La préférence peut être enregistrée dès maintenant."}</Notice>}
        </Panel>
        <Panel title="Affichage">
          <div className="wp-fields">
            <Field label="Thème"><select value={settings.theme} onChange={(event) => change("theme", event.target.value as Settings["theme"])}>
              <option value="dark">Sombre</option><option value="contrast">Contraste élevé</option>
            </select></Field>
            <div className="wp-card-row"><p>Langue · Français</p><p>Devise · Dollar américain (USD)</p></div>
          </div>
        </Panel>
      </div>
    </div>
    {error && <Notice type="error">{error}</Notice>}
    {alert && <Notice type="success">{alert}</Notice>}
    <div className="wp-actions"><Submit pending={busy}><Save size={16} /> Enregistrer les réglages</Submit></div>
    </fieldset>
  </form>;
}

type QuoteForm = {
  symbol: string; id: string; type: "call" | "put"; strike: string; expiration: string; multiplier: string;
  bid: string; ask: string; quoteAt: string; url: string; publisher: string; volume: string; interest: string;
};
const blankQuote: QuoteForm = {
  symbol: "", id: "", type: "call", strike: "", expiration: "", multiplier: "100",
  bid: "", ask: "", quoteAt: "", url: "", publisher: "", volume: "", interest: "",
};

function BrokerQuotes({ state, refresh }: { state: AppState; refresh: Refresh }) {
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(blankQuote);
  const [attested, setAttested] = useState(false);
  const [pending, setPending] = useState(false);
  const [alert, setAlert] = useState("");
  const [error, setError] = useState("");
  const change = (key: keyof QuoteForm, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setPending(true);
    setAlert("");
    setError("");
    try {
      const quote = {
        symbol: form.symbol.trim().toUpperCase(), id: form.id.trim().toUpperCase(), type: form.type,
        strike: Number(form.strike), expiration: form.expiration, multiplier: Number(form.multiplier),
        bid: Number(form.bid), ask: Number(form.ask), quoteAt: form.quoteAt.trim(), currency: "USD",
        source: { url: form.url.trim(), publisher: form.publisher.trim() },
        volume: form.volume.trim() ? Number(form.volume) : undefined,
        openInterest: form.interest.trim() ? Number(form.interest) : undefined,
        attested,
      };
      if (!attested || quote.id.replace(/\s/g, "") !== makeOccSymbol(quote.symbol, quote.expiration, quote.type, quote.strike)) {
        throw new Error("Vérifiez l’identité OCC et l’attestation avant d’enregistrer.");
      }
      await request("/api/quotes", "POST", quote);
      await refresh();
      setForm(blankQuote);
      setAttested(false);
      setShow(false);
      setAlert("Cotation indicative enregistrée.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  const remove = async (id: string) => {
    setPending(true);
    setAlert("");
    setError("");
    try {
      await request(`/api/quotes/${encodeURIComponent(id)}`, "DELETE");
      await refresh();
      setAlert("Cotation retirée.");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return <Panel title="Cotations courtier attestées" detail="Saisissez une observation horodatée pour l’utiliser dans une analyse indicative."
    actions={state.mode === "live" ? <button className="wp-button" type="button" aria-expanded={show} onClick={() => setShow(!show)}>{show ? "Fermer" : "Saisir une cotation"}</button> : undefined}>
    {state.mode === "demo" && <Notice>La saisie de cotations courtier est disponible dans l’espace réel.</Notice>}
    {state.mode === "live" && <p className="wp-micro">Ces observations sont attestées par vous et limitées à l’analyse indicative.</p>}
    {alert && <Notice type="success">{alert}</Notice>}
    {error && <Notice type="error">{error}</Notice>}
    {show && <form className="wp-form" onSubmit={actionForm(() => void save())}>
      <div className="wp-fields">
        <Field label="Sous-jacent"><input required value={form.symbol} maxLength={10} onChange={(event) => change("symbol", event.target.value.toUpperCase())} /></Field>
        <Field label="Symbole OCC exact"><input required value={form.id} maxLength={32} onChange={(event) => change("id", event.target.value.toUpperCase())} /></Field>
        <Field label="Type"><select value={form.type} onChange={(event) => change("type", event.target.value)}><option value="call">Call</option><option value="put">Put</option></select></Field>
        <Field label="Échéance"><input required type="date" value={form.expiration} onChange={(event) => change("expiration", event.target.value)} /></Field>
        <Field label="Prix d’exercice"><input required type="number" min=".001" step=".001" value={form.strike} onChange={(event) => change("strike", event.target.value)} /></Field>
        <Field label="Multiplicateur indiqué par le courtier"><input required type="number" min="1" value={form.multiplier} onChange={(event) => change("multiplier", event.target.value)} /></Field>
        <Field label="Bid (USD)"><input required type="number" min="0" step=".001" value={form.bid} onChange={(event) => change("bid", event.target.value)} /></Field>
        <Field label="Ask (USD)"><input required type="number" min="0" step=".001" value={form.ask} onChange={(event) => change("ask", event.target.value)} /></Field>
        <Field label="Volume"><input type="number" min="0" value={form.volume} onChange={(event) => change("volume", event.target.value)} /></Field>
        <Field label="Intérêt ouvert"><input type="number" min="0" value={form.interest} onChange={(event) => change("interest", event.target.value)} /></Field>
        <Field label="Courtier"><input required maxLength={160} value={form.publisher} onChange={(event) => change("publisher", event.target.value)} /></Field>
        <Field label="URL HTTPS de la source"><input required type="url" maxLength={2048} value={form.url} onChange={(event) => change("url", event.target.value)} /></Field>
        <Field label="Horodatage de cotation, avec fuseau" hint="Format ISO 8601, par exemple 2026-06-05T15:55:00-04:00." wide>
          <input required value={form.quoteAt} maxLength={35} onChange={(event) => change("quoteAt", event.target.value)} />
        </Field>
      </div>
      <label className="wp-check"><input type="checkbox" required checked={attested} onChange={(event) => setAttested(event.target.checked)} /> Je confirme avoir relevé cette cotation auprès du courtier indiqué.</label>
      <div className="wp-actions"><Submit pending={pending}>Enregistrer la cotation</Submit></div>
    </form>}
    {state.manualQuotes.length ? <div className="wp-table-wrap"><table className="wp-table"><thead><tr><th>Contrat</th><th>Bid / Ask</th><th>Source</th><th>Horodatage</th><th>Action</th></tr></thead><tbody>
      {state.manualQuotes.map((quote) => <tr key={quote.id}><td>{quote.id}<small><Status value={validateQuote(quote).status} dictionary={dataLabels} /></small></td>
        <td>{money(quote.bid)} / {money(quote.ask)}</td><td><SourceLink url={quote.source.url}>{quote.source.publisher}</SourceLink></td><td>{timestamp(quote.quoteAt)}<small>Enregistrée le {timestamp(quote.retrievedAt)}</small></td>
        <td><button type="button" className="wp-button wp-icon wp-danger" aria-label={`Retirer ${quote.id}`} disabled={pending} onClick={() => void remove(quote.id)}><Trash2 size={15} /></button></td>
      </tr>)}
    </tbody></table></div> : <Empty title="Aucune cotation courtier enregistrée" detail="Les observations admissibles apparaîtront ici avec leur source et leur horodatage." />}
  </Panel>;
}

function Privacy({ refresh, onReset }: { refresh: Refresh; onReset: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const run = async (mode: "download" | "delete") => {
    setPending(true);
    setError("");
    setInfo("");
    try {
      const data = await request("/api/data", mode === "delete" ? "DELETE" : "GET");
      if (mode === "delete") {
        setConfirm(false);
        setInfo("Données réinitialisées.");
        await refresh();
        onReset();
      } else downloadJson("options-ai-pro-donnees.json", data);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return <Panel title="Confidentialité et données">
    {info && <Notice type="success">{info}</Notice>}
    {error && <Notice type="error">{error}</Notice>}
    <div className="wp-actions">
      <button className="wp-button" disabled={pending} type="button" onClick={() => void run("download")}><Download size={15} /> Exporter mes données</button>
      <button className="wp-button wp-danger" disabled={pending} type="button" onClick={() => setConfirm(true)}><Trash2 size={15} /> Réinitialiser mon espace</button>
    </div>
    {confirm && <Notice>Les listes, positions et recherches enregistrées de cet espace seront supprimées.
      <div className="wp-actions"><button type="button" className="wp-button wp-danger" disabled={pending} onClick={() => void run("delete")}>Supprimer mes données</button>
        <button type="button" className="wp-button" onClick={() => setConfirm(false)}>Annuler</button></div>
    </Notice>}
  </Panel>;
}

type ConnectionResult = {ok:boolean; message:string; estimatedCost:number|null; unreconciledCost:number|null};

function OpenAIConnection({ refresh }: { refresh: Refresh }) {
  const [pending,setPending] = useState(false);
  const [result,setResult] = useState<ConnectionResult | null>(null);
  const [error,setError] = useState("");
  const usd = new Intl.NumberFormat("fr-CA",{style:"currency",currency:"USD",maximumFractionDigits:8});

  async function check() {
    setPending(true);
    setResult(null);
    setError("");
    try {
      setResult(await request<ConnectionResult>("/api/ai/connection-test","POST"));
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return <div className="wp-card-row">
    <p>Le test envoie une requête réelle avec recherche Web et peut entraîner un coût.</p>
    <button type="button" className="wp-button" disabled={pending} onClick={() => void check()}>
      {pending ? "Vérification en cours…" : "Tester la connexion OpenAI"}
    </button>
    <div role="status" aria-live="polite">
      {error && <p>{error}</p>}
      {result && <><p>{result.ok ? "Succès" : "Échec"} · {result.message}</p>
        <p>Coût estimé · {result.estimatedCost === null ? "Indisponible" : usd.format(result.estimatedCost)}</p>
        {result.unreconciledCost !== null && <p>Coût potentiel non confirmé · {usd.format(result.unreconciledCost)}</p>}
      </>}
    </div>
  </div>;
}

export function SettingsPage({ state, refresh }: { state: AppState; refresh: Refresh }) {
  const [resetCount, setResetCount] = useState(0);
  const latest = state.scans.find((scan) => scan.status === "completed" || scan.status === "partial");
  const errors = state.scans.filter((scan) => scan.error || scan.failed.length > 0).slice(0, 4);
  return <>
    <Heading icon={Settings2} title="Réglages" detail="Gérez le risque, les sources, les budgets et les données de votre espace." />
    <Preferences state={state} refresh={refresh} key={resetCount} />
    <div id="data-sources" className="wp-stack">
      <Panel title="Diagnostics des sources" detail="Couverture et disponibilité des sources utilisées par le scanner." actions={<Database size={17} color="var(--wp-accent)" />}>
        <div className="wp-card-row">
          <div className="wp-split"><strong>{state.mode === "demo" ? "Fournisseur démo" : "OpenAI Web Search"}</strong>
            <Status value={state.mode === "demo" ? "DEMO" : state.research.configured ? "VERIFIED_FRESH" : "INSUFFICIENT"} dictionary={{
              ...dataLabels, DEMO: "Actif · fictif", VERIFIED_FRESH: "Configuré", INSUFFICIENT: "Configuration requise",
            }} /></div>
          <p>{state.mode === "demo" ? "Les observations, contrats et historiques proviennent de scénarios fictifs." : "La recherche web vérifie les sources accessibles et couvre surtout le contexte des sous-jacents. La couverture des chaînes d’options est partielle."}</p>
          {state.research.model && <p>Modèle configuré · {state.research.model}</p>}
          <p>Dernier scan abouti · {timestamp(latest?.completedAt)}</p>
        </div>
        {state.mode === "live" && <div className="wp-card-row">
          <div className="wp-split">
            <strong>Market Data · chaînes d’options</strong>
            <Status value={state.research.marketDataConfigured ? "configured" : "setup"} dictionary={{
              configured: "Configuré côté serveur", setup: "Configuration requise",
            }} />
          </div>
          <p>{state.research.marketDataConfigured
            ? "L’accès aux données dépend des droits du forfait et se confirme lors d’un scan."
            : "Configurez ce fournisseur facultatif côté serveur pour récupérer des chaînes d’options lors des scans."}</p>
          <p>Les cotations en cache sont horodatées et servent à l’analyse indicative.</p>
        </div>}
        <OpenAIConnection refresh={refresh} />
        {errors.map((scan) => <details key={scan.id} className="wp-card-row"><summary>Diagnostic du scan du {timestamp(scan.startedAt)}</summary>
          <p>{scan.error ?? `Actifs en échec · ${scan.failed.join(", ")}`}</p>
        </details>)}
      </Panel>
      <BrokerQuotes state={state} refresh={refresh} />
    </div>
    <Privacy refresh={refresh} onReset={() => setResetCount((current) => current + 1)} />
  </>;
}
