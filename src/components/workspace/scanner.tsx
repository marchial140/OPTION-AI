"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Clock3, Download, History, LoaderCircle, Radio, ScanLine, Trash2 } from "lucide-react";
import { strategyLabels } from "@/lib/quant";
import type { AppState, Scan, ScanType, Settings } from "@/lib/workspace";
import { actionForm, dataLabels, dayInput, directionLabels, downloadJson, Empty, errorMessage, Field, Heading, money, Notice, Panel, request, scanLabels, SourceLink, Stat, Status, Submit, timestamp, usePreparedRequest } from "./ui";

const stageNames: Record<string, string> = {
  queued: "En file d’attente", research: "Recherche du sous-jacent", screening: "Sélection des candidats",
  validation: "Vérification des données", contracts: "Recherche de contrats", discovering: "Découverte des contrats",
  constructing: "Construction et contrôle des stratégies", ranking: "Classement",
  completed: "Résultats enregistrés",
};
const scanModes = Object.keys(scanLabels) as ScanType[];
type ScanRequest = { type: ScanType; tickers: string[]; overrides?: Partial<Settings> };
const pendingScan = (scan: Scan) => scan.status === "queued" || scan.status === "running";
const phaseOrder = ["queued", "research", "screening", "contracts", "discovering", "validation", "constructing", "ranking", "completed"];

function mergeProgress(current: Scan | null, next: Scan) {
  if (!current || current.id !== next.id || !pendingScan(current)) return current;
  if (!pendingScan(next)) return next;
  const difference = next.completed.length + next.failed.length - current.completed.length - current.failed.length;
  if (difference !== 0) return difference > 0 ? next : current;
  if (current.current && !next.current) return current;
  const nextStage = phaseOrder.indexOf(next.stage ?? "");
  const currentStage = phaseOrder.indexOf(current.stage ?? "");
  return nextStage < currentStage || (current.status === "running" && next.status === "queued") ? current : next;
}

const tickersFrom = (value: string) => [...new Set(value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];

function AssetEvidence({ scan }: { scan: Scan }) {
  return <div className="wp-stack">
    {scan.candidates.map((candidate) => <details className="wp-card-row" key={candidate.symbol}>
      <summary><strong>{candidate.symbol}</strong> · {candidate.name} · {directionLabels[candidate.direction]}</summary>
      <div className="wp-stack">
        <p>{candidate.thesis}</p>
        <div className="wp-split"><span className="wp-micro">Cours de référence au moment du scan · {money(candidate.price)}</span><Status value={candidate.status} dictionary={dataLabels} /></div>
        {candidate.bullishFactors.length > 0 && <p><strong>Facteurs haussiers</strong> · {candidate.bullishFactors.join(" · ")}</p>}
        {candidate.bearishFactors.length > 0 && <p><strong>Facteurs baissiers</strong> · {candidate.bearishFactors.join(" · ")}</p>}
        {candidate.risks.length > 0 && <p><strong>Risques</strong> · {candidate.risks.join(" · ")}</p>}
        {!!candidate.sources.length && <ul className="wp-sources">
          {candidate.sources.map((source, index) => <li key={`${source.url}-${index}`}>
            <SourceLink url={source.url}>{source.publisher}</SourceLink>
            {source.quoteAt && ` · Coté le ${timestamp(source.quoteAt)}`} · Consulté le {timestamp(source.retrievedAt)}
          </li>)}
        </ul>}
      </div>
    </details>)}
  </div>;
}

function ScanReport({ scan, showExport = false }: { scan: Scan; showExport?: boolean }) {
  const running = pendingScan(scan);
  const processed = scan.completed.length + scan.failed.length;
  return <>
    <div className="wp-split">
      <Status value={scan.status} />
      <small className="wp-micro">Début · {timestamp(scan.startedAt)}</small>
      {showExport && <button type="button" className="wp-button" onClick={() => downloadJson(`options-ai-pro-${scan.id}.json`, scan)}><Download size={15} /> Exporter ce scan</button>}
    </div>
    {running && <div className="wp-stack">
      <p className="wp-micro wp-sort-status" role="status"><LoaderCircle size={14} className="wp-spin" /> {scan.current ? scan.current + " · " : ""}{stageNames[scan.stage ?? ""] ?? scan.stage ?? "Préparation de l’analyse"}</p>
      <progress className="wp-progress" aria-label="Actifs traités" max={scan.tickers.length || 1} value={processed} />
      <small className="wp-micro">{processed} / {scan.tickers.length} actifs traités</small>
    </div>}
    <div className="wp-stat-grid">
      <Stat label="Actifs analysés" value={scan.completed.length} />
      <Stat label="Actifs en échec" value={scan.failed.length} />
      <Stat label="Candidats" value={scan.candidates.length} />
      <Stat label="Stratégies admissibles" value={scan.opportunities.length} />
      <Stat label="Requêtes" value={scan.requestCount} />
      <Stat label="Coût estimé" value={money(scan.estimatedCost)} />
    </div>
    {scan.error && <Notice type="error">{scan.error}</Notice>}
    {(scan.status === "completed" || scan.status === "partial") && scan.opportunities.length === 0 && <Notice>Aucune opportunité ne respecte actuellement vos critères.</Notice>}
    {scan.status === "cancelled" && <Notice>Scan annulé. Les résultats enregistrés avant l’annulation restent accessibles ici.</Notice>}
    {scan.status === "failed" && !scan.error && <Notice type="error">Le scan n’a pas abouti. Consultez les motifs du rapport avant de relancer.</Notice>}
    {scan.rejections.length > 0 && <details className="wp-card-row">
      <summary>{scan.rejections.length} résultat{scan.rejections.length > 1 ? "s" : ""} écarté{scan.rejections.length > 1 ? "s" : ""}</summary>
      <ul className="wp-sources">{scan.rejections.map((result, index) => <li key={`${result.symbol}-${index}`}><strong>{result.symbol}</strong> · {result.reason}</li>)}</ul>
    </details>}
    {scan.completed.length > 0 && <p className="wp-micro">Analysés · {scan.completed.join(", ")}</p>}
    {scan.failed.length > 0 && <p className="wp-micro">En échec · {scan.failed.join(", ")}</p>}
    {scan.completedAt && <p className="wp-micro">Fin · {timestamp(scan.completedAt)}</p>}
    {!!scan.cached?.length && <p className="wp-micro">Recherches réutilisées · {scan.cached.join(", ")}</p>}
    {!!scan.examinedSources?.length && <details className="wp-card-row">
      <summary>{scan.examinedSources.length} source(s) examinée(s)</summary>
      <ul className="wp-sources">{scan.examinedSources.map((source, index) => <li key={index}>
        <SourceLink url={source.url}>{source.publisher}</SourceLink>
        {source.quoteAt && ` · Coté le ${timestamp(source.quoteAt)}`} · Consulté le {timestamp(source.retrievedAt)}
      </li>)}</ul>
    </details>}
    {showExport && !!scan.opportunities.length && <details className="wp-card-row">
      <summary>{scan.opportunities.length} stratégie(s) retenue(s) lors de ce scan</summary>
      <ul className="wp-sources">{scan.opportunities.map((entry) => <li key={entry.id}>
        <Link href={`/opportunities/${encodeURIComponent(entry.id)}`}>{entry.symbol} · {strategyLabels[entry.strategy]}</Link> · Perte maximale {money(entry.result.maxLoss)}
        {entry.score ? ` · Score ${entry.score.total}/100` : ""}
      </li>)}</ul>
    </details>}
    {scan.candidates.length > 0 && <AssetEvidence scan={scan} />}
  </>;
}

export function Scanner({ state, refresh, symbol, listId }: {
  state: AppState; refresh: () => Promise<void>; symbol?: string; listId?: string;
}) {
  const linkedList = listId ? state.watchlists.find((list) => list.id === listId) : state.watchlists[0];
  const [type, setType] = useState<ScanType>("quick");
  const [selectedList, setSelectedList] = useState(symbol ? "" : linkedList?.id ?? "");
  const [symbols, setSymbols] = useState(symbol?.toUpperCase() ?? linkedList?.items.join(", ") ?? "");
  const [minDte, setMinDte] = useState(String(state.settings.minDte));
  const [maxDte, setMaxDte] = useState(String(state.settings.maxDte));
  const [capital, setCapital] = useState(String(state.settings.accountCapital));
  const [risk, setRisk] = useState(String(state.settings.riskPerTrade));
  const [strategies, setStrategies] = useState(state.settings.strategies);
  const [selectedScan, setSelectedScan] = useState<Scan | null>(() => state.scans.find(pendingScan) ?? null);
  const [pending, setPending] = useState(false);
  const [pollPaused, setPollPaused] = useState(false);
  const [error, setError] = useState("");
  const [hasChanged, setHasChanged] = useState(false);
  const prepared = usePreparedRequest<ScanRequest>();
  const scan = selectedScan ?? state.scans[0];
  const tickers = tickersFrom(symbols);
  const running = Boolean(selectedScan && pendingScan(selectedScan));
  const scanId = selectedScan?.id;
  const offline = state.mode === "live" && !state.research.configured && !state.manualQuotes.length;

  useEffect(() => {
    if (!running || !scanId || pollPaused) return;
    let stopped = false;
    let timer: number | undefined;
    const next = async () => {
      try {
        const output = await request<{ scan: Scan }>(`/api/scans/${encodeURIComponent(scanId)}/advance`, "POST");
        if (stopped) return;
        setSelectedScan((current) => mergeProgress(current, output.scan));
        if (pendingScan(output.scan)) timer = window.setTimeout(next, 500);
        else void refresh();
      } catch (failure) {
        if (stopped) return;
        setError(errorMessage(failure));
        setPollPaused(true);
      }
    };
    timer = window.setTimeout(next, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, scanId, pollPaused, refresh]);

  useEffect(() => {
    if (state.mode !== "live" || !running || !scanId) return;
    let stopped = false;
    let timer: number | undefined;
    const read = async () => {
      try {
        const output = await request<{ scan: Scan }>(`/api/scans/${encodeURIComponent(scanId)}/status`);
        if (stopped) return;
        setSelectedScan((current) => mergeProgress(current, output.scan));
        if (!pendingScan(output.scan)) {
          void refresh();
          return;
        }
      } catch {
        // The advancing request owns error reporting and remains independently retryable.
      }
      if (!stopped) timer = window.setTimeout(read, 2000);
    };
    timer = window.setTimeout(read, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [state.mode, running, scanId, refresh]);

  const cancel = async () => {
    if (!scanId) return;
    setPending(true);
    setPollPaused(true);
    setError("");
    try {
      const output = await request<{ scan: Scan }>(`/api/scans/${encodeURIComponent(scanId)}/cancel`, "POST", {});
      setSelectedScan(output.scan);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const launch = async () => {
    setHasChanged(true);
    setError("");
    if (!tickers.length || tickers.length > 20) {
      setError("Sélectionnez entre 1 et 20 symboles par analyse.");
      return;
    }
    if (type === "custom" && (Number(minDte) > Number(maxDte) || !strategies.length)) {
      setError("Vérifiez la plage d’échéances et sélectionnez au moins une stratégie.");
      return;
    }
    setPending(true);
    try {
      const overrides: Partial<Settings> | undefined = type === "custom" ? {
        minDte: Number(minDte), maxDte: Number(maxDte), accountCapital: Number(capital), riskPerTrade: Number(risk), strategies,
      } : undefined;
      const payload = { type, tickers, overrides };
      const { body, key } = prepared.get(payload, () => payload);
      const response = await request<{ scan: Scan }>("/api/scans", "POST", body, key);
      prepared.clear();
      setPollPaused(false);
      setSelectedScan(response.scan);
      void refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return <>
    <Heading icon={ScanLine} title="Scanner de marché IA" detail="Analysez des sous-jacents, vérifiez les sources et appliquez vos limites de risque."
      actions={<Link className="wp-button" href="/history"><History size={16} /> Historique</Link>} />
    <div className="wp-grid">
      <Panel title="Configurer un scan" detail="Le scanner enregistre ses résultats et les motifs de rejet.">
        <form className="wp-form" onSubmit={actionForm(() => void launch())}>
          <fieldset className="wp-segment">
            <legend className="wp-micro">Mode de recherche</legend>
            {scanModes.map((mode) => <label key={mode}><input type="radio" name="mode" value={mode} checked={type === mode} onChange={() => setType(mode)} /> {scanLabels[mode]}</label>)}
          </fieldset>
          <p className="wp-micro">{type === "deep" ? "Recherche élargie et davantage de vérifications par sous-jacent." : type === "custom" ? "Resserrez les limites de risque ou d’échéance pour ce scan." : "Repérage ciblé avec réutilisation des recherches récentes lorsque possible."}</p>
          <Field label="Liste de suivi"><select value={selectedList} onChange={(event) => {
            setSelectedList(event.target.value);
            const list = state.watchlists.find((item) => item.id === event.target.value);
            if (list) setSymbols(list.items.join(", "));
          }}><option value="">Saisie libre</option>{state.watchlists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></Field>
          {listId && !linkedList && <Notice type="error">La liste liée est introuvable. Choisissez une liste ou saisissez des symboles.</Notice>}
          <Field label="Symboles" hint="20 symboles maximum, séparés par des virgules ou des espaces."><textarea value={symbols} onChange={(event) => { setSymbols(event.target.value.toUpperCase()); setSelectedList(""); }} rows={3} required maxLength={720} /></Field>
          <p className="wp-micro">{tickers.length} / 20 symboles</p>
          {type === "custom" && <div className="wp-fields">
            <Field label="Échéance minimale (jours)"><input min={state.settings.minDte} max={state.settings.maxDte} type="number" required value={minDte} onChange={(event) => setMinDte(event.target.value)} /></Field>
            <Field label="Échéance maximale (jours)"><input min={state.settings.minDte} max={state.settings.maxDte} type="number" required value={maxDte} onChange={(event) => setMaxDte(event.target.value)} /></Field>
            <Field label="Capital (USD)"><input min=".01" max={state.settings.accountCapital} step=".01" type="number" required value={capital} onChange={(event) => setCapital(event.target.value)} /></Field>
            <Field label="Risque par opération (%)"><input min="0" max={state.settings.riskPerTrade} step=".01" type="number" required value={risk} onChange={(event) => setRisk(event.target.value)} /></Field>
            <fieldset className="wp-segment wp-field-wide"><legend className="wp-micro">Stratégies de ce scan</legend>
              {state.settings.strategies.map((strategy) => <label key={strategy}><input type="checkbox" checked={strategies.includes(strategy)}
                onChange={(event) => setStrategies(event.target.checked ? [...strategies, strategy] : strategies.filter((item) => item !== strategy))} /> {strategyLabels[strategy]}</label>)}
            </fieldset>
          </div>}
          {state.mode === "demo" && <Notice>Démo · Le scanner utilise des données fictives et aucun appel de recherche facturable.</Notice>}
          {offline && <Notice type="error">La connexion OpenAI Web Search manque dans la configuration du serveur.</Notice>}
          {error && <Notice type="error">{error}</Notice>}
          <div className="wp-actions">
            <Submit pending={pending} disabled={running || offline}><ScanLine size={16} /> Scanner le marché</Submit>
            {running && <button type="button" className="wp-button" disabled={pending} onClick={() => void cancel()}>Annuler le scan</button>}
            {running && pollPaused && <button type="button" className="wp-button" onClick={() => { setPollPaused(false); setError(""); }}>Reprendre le suivi</button>}
          </div>
        </form>
      </Panel>
      <Panel title={hasChanged || running ? "Suivi du scan" : "Dernière analyse"} detail={scan ? scan.tickers.join(" · ") : "Le détail s’affiche après le lancement."}
        actions={<Radio size={17} color="var(--wp-accent)" />}>
        {scan ? <ScanReport scan={scan} showExport={!running} /> : <Empty title="Aucun scan enregistré" detail="Sélectionnez des actifs et lancez votre première analyse." />}
      </Panel>
    </div>
  </>;
}

export function HistoryPage({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [symbol, setSymbol] = useState("");
  const [minDate, setMinDate] = useState("");
  const [maxDate, setMaxDate] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparedId, setComparedId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const query = symbol.trim().toLowerCase();
  const visible = state.scans.filter((scan) => (!minDate || dayInput(new Date(scan.startedAt)) >= minDate) &&
    (!maxDate || dayInput(new Date(scan.startedAt)) <= maxDate) && (!query || scan.tickers.some((ticker) => ticker.toLowerCase().includes(query)) ||
      scan.id.toLowerCase().includes(query) || scanLabels[scan.type].toLowerCase().includes(query)));
  const selected = visible.find((scan) => scan.id === selectedId) ?? visible[0];
  const compared = state.scans.find((scan) => scan.id === comparedId && scan.id !== selected?.id);
  const remove = async (id: string) => {
    setPending(true);
    setError("");
    try {
      await request(`/api/scans/${encodeURIComponent(id)}`, "DELETE");
      setSelectedId(null);
      setConfirmDelete(null);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return <>
    <Heading icon={History} title="Historique de recherche" detail="Retrouvez les sources, les résultats et les décisions de validation de chaque scan."
      actions={<button type="button" className="wp-button" disabled={!visible.length} onClick={() => downloadJson("options-ai-pro-historique.json", visible)}><Download size={16} /> Exporter les résultats</button>} />
    <div className="wp-grid">
      <Panel title="Archives des scans" detail={visible.length + " scan(s) trouvé(s)"}>
        <div className="wp-fields">
          <Field label="Rechercher un scan" wide><input type="search" placeholder="Symbole, mode ou identifiant" value={symbol} onChange={(event) => setSymbol(event.target.value)} /></Field>
          <Field label="À partir du"><input type="date" max={maxDate || undefined} value={minDate} onChange={(event) => setMinDate(event.target.value)} /></Field>
          <Field label="Jusqu’au"><input type="date" min={minDate || undefined} value={maxDate} onChange={(event) => setMaxDate(event.target.value)} /></Field>
        </div>
        {visible.map((scan) => <button type="button" key={scan.id} className="wp-button wp-split" aria-pressed={scan.id === selected?.id} onClick={() => { setSelectedId(scan.id); setConfirmDelete(null); }}>
          <span className="wp-actions"><Clock3 size={15} /> {timestamp(scan.startedAt)} · {scanLabels[scan.type]}</span><Status value={scan.status} />
        </button>)}
        {!visible.length && <Empty title="Aucun résultat" detail={state.scans.length ? "Modifiez les filtres pour retrouver un autre scan." : "Les scans enregistrés apparaîtront ici."}><Link href="/scanner" className="wp-button">Ouvrir le scanner</Link></Empty>}
      </Panel>
      <div className="wp-stack">
        {selected && <Panel title={`Scan ${scanLabels[selected.type].toLowerCase()}`} detail={selected.tickers.join(" · ")}
          actions={<button type="button" className="wp-button wp-danger wp-icon" disabled={pendingScan(selected)} aria-label="Supprimer ce scan" onClick={() => setConfirmDelete(selected.id)}><Trash2 size={15} /></button>}>
          {confirmDelete === selected.id && <Notice>Supprimer définitivement ce scan ? <div className="wp-actions">
            <button type="button" className="wp-button wp-danger" disabled={pending} onClick={() => void remove(selected.id)}>Confirmer la suppression</button>
            <button type="button" className="wp-button" onClick={() => setConfirmDelete(null)}>Conserver</button>
          </div></Notice>}
          {error && <Notice type="error">{error}</Notice>}
          <ScanReport scan={selected} showExport />
        </Panel>}
        {selected && state.scans.length > 1 && <Panel title="Comparer les conclusions">
          <Field label="Scan de comparaison"><select value={compared ? comparedId : ""} onChange={(event) => setComparedId(event.target.value)}>
            <option value="">Choisir un autre scan</option>{state.scans.filter((scan) => scan.id !== selected.id).map((scan) => <option value={scan.id} key={scan.id}>{timestamp(scan.startedAt)} · {scanLabels[scan.type]}</option>)}
          </select></Field>
          {compared && <div className="wp-table-wrap"><table className="wp-table wp-wrap-table"><thead><tr><th>Symbole</th><th>{timestamp(selected.startedAt)}</th><th>{timestamp(compared.startedAt)}</th></tr></thead>
            <tbody>{[...new Set([...selected.tickers, ...compared.tickers])].map((ticker) => <tr key={ticker}><th scope="row">{ticker}</th>
              {[selected, compared].map((scan) => {
                const candidate = scan.candidates.find((item) => item.symbol === ticker);
                return <td key={scan.id}>{candidate ? <><strong>{directionLabels[candidate.direction]}</strong><small>{candidate.thesis}</small></> : "Aucune conclusion"}</td>;
              })}
            </tr>)}</tbody>
          </table></div>}
        </Panel>}
      </div>
    </div>
  </>;
}
