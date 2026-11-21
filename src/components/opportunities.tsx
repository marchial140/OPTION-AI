"use client";

import { Bookmark, ChartNoAxesCombined, Check, ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, Filter, FlaskConical, GitCompareArrows, Info, Layers3, ListFilter, Radar, Search, ShieldCheck, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { payoffAt, strategyLabels, type Opportunity, type ResearchCandidate } from "@/lib/quant";
import type { AppState } from "@/lib/workspace";

const usdFormat = new Intl.NumberFormat("fr-CA", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 });
const numberFormat = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 2 });
const pageSize = 8;
const directionNames = { bullish: "Haussier", bearish: "Baissier", neutral: "Neutre", mixed: "Mitigé", insufficient: "Insuffisant" } as const;
const statusNames: Record<string, string> = {
  DEMO: "Démo", VERIFIED_FRESH: "Vérifiée · récente", VERIFIED_DELAYED: "Vérifiée · différée",
  VERIFIED_HISTORICAL: "Historique", STALE: "Périmée", UNVERIFIED: "Non vérifiée",
  INSUFFICIENT: "Données insuffisantes", CONTRADICTORY: "Contradictoire",
};

type Column = "price" | "direction" | "expiration" | "dte" | "debit" | "risk" | "profit" | "ratio" | "score" | "status" | "updated";
type SortKey = Column | "symbol" | "strategy";
const fullColumns: { key: Column; label: string }[] = [
  { key: "price", label: "Sous-jacent" }, { key: "direction", label: "Biais" }, { key: "expiration", label: "Échéance" },
  { key: "dte", label: "DTE" }, { key: "debit", label: "Débit" }, { key: "risk", label: "Perte max." },
  { key: "profit", label: "Gain max." }, { key: "ratio", label: "Gain / risque" }, { key: "score", label: "Score" },
  { key: "status", label: "Données" }, { key: "updated", label: "Mis à jour" },
];
const initialColumns: Column[] = ["price", "direction", "dte", "debit", "risk", "profit", "score", "status"];
const compactColumns: Column[] = ["direction", "dte", "debit", "risk", "profit", "score", "status"];

export function Opportunities({ state, detail, refresh }: { state: AppState; detail?: string; refresh: () => Promise<void> }) {
  const queryParams = useSearchParams();
  const [tab, setTab] = useState<"ranked" | "research" | "saved" | null>(null);
  const [search, setSearch] = useState(queryParams?.get("q") ?? "");
  const [direction, setDirection] = useState("");
  const [strategy, setStrategy] = useState("");
  const [status, setStatus] = useState("");
  const [showColumns, setShowColumns] = useState(false);
  const [columns, setColumns] = useState<Column[]>(initialColumns);
  const [compareIds, setCompareIds] = useState<string[]>(() => {
    const id = queryParams?.get("compare");
    return id ? [id] : [];
  });
  const [comparing, setComparing] = useState(false);
  const queryView = queryParams?.get("view");
  const effectiveTab = tab ?? (queryView === "research" || queryView === "saved" ? queryView : "ranked");
  const allOpportunities = new Map<string, Opportunity>();
  for (const item of [...state.opportunities, ...state.scans.flatMap((scan) => scan.opportunities)]) {
    if (!allOpportunities.has(item.id)) allOpportunities.set(item.id, item);
  }
  const selected = [...allOpportunities.values()].filter((item) => compareIds.includes(item.id));
  const savedOpportunities = [...allOpportunities.values()].filter((item) => state.savedOpportunityIds?.includes(item.id));
  const term = search.trim().toLocaleLowerCase("fr");

  if (detail) {
    const current = state.opportunities.some((opportunity) => opportunity.id === detail);
    const item = allOpportunities.get(detail);
    if (!item) return <section className="empty-state panel"><ChartNoAxesCombined size={24} /><h1>Opportunité introuvable</h1><p>Ce rapport n’est plus disponible dans votre espace de travail.</p><Link href="/opportunities" className="button button-secondary">Toutes les opportunités</Link></section>;
    const scan = state.scans.find((scan) => scan.opportunities.some((opportunity) => opportunity.id === detail));
    const candidate = (current ? state.candidates : scan?.candidates)?.find((candidate) => candidate.symbol === item.symbol);
    return <OpportunityDetail opportunity={item} candidate={candidate} refresh={refresh} isDemo={state.mode === "demo"} isArchived={!current} isSaved={state.savedOpportunityIds?.includes(item.id) ?? false} />;
  }

  function toggleComparison(id: string) {
    setCompareIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= 3 ? current : [...current, id]);
    setComparing(false);
  }

  const filterSymbol = (item: { symbol: string; name: string }) => !term || `${item.symbol} ${item.name}`.toLocaleLowerCase("fr").includes(term);
  const candidates = state.candidates.filter((item) => filterSymbol(item) && (!direction || item.direction === direction));
  const tabOpportunities = effectiveTab === "saved" ? savedOpportunities : state.opportunities;
  const opportunities = tabOpportunities.filter((item) => filterSymbol(item) && (!direction || item.direction === direction) && (!strategy || item.strategy === strategy) && (!status || item.status === status));
  const availableStatuses = [...new Set(tabOpportunities.map((item) => item.status))];

  return <div className="opportunities-page">
    <div className="page-heading">
      <div><h1>Opportunités</h1><p>Comparez les stratégies admissibles et consultez les thèses documentées par le scanner.</p></div>
      <Link href="/scanner" className="button button-primary"><Radar size={16} /> Scanner le marché</Link>
    </div>
    <div className="opportunities-tabs" aria-label="Ensembles de résultats">
      <button className={effectiveTab === "ranked" ? "active" : ""} aria-pressed={effectiveTab === "ranked"} onClick={() => setTab("ranked")}><ShieldCheck size={16} /> {state.mode === "demo" ? "Stratégies de démonstration" : "Opportunités vérifiées"} <span>{state.opportunities.length}</span></button>
      <button className={effectiveTab === "research" ? "active" : ""} aria-pressed={effectiveTab === "research"} onClick={() => setTab("research")}><Radar size={16} /> Candidats de recherche <span>{state.candidates.length}</span></button>
      <button className={effectiveTab === "saved" ? "active" : ""} aria-pressed={effectiveTab === "saved"} onClick={() => setTab("saved")}><Bookmark size={16} /> Enregistrées <span>{savedOpportunities.length}</span></button>
    </div>
    <section className="panel opportunities-panel" aria-label={effectiveTab === "research" ? "Candidats de recherche" : "Stratégies"}>
      <div className="opportunities-toolbar">
        <label className="opportunities-search"><Search size={17} /><input aria-label="Rechercher un symbole ou une société" placeholder="Rechercher un symbole…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="opportunities-clear" onClick={() => setSearch("")} aria-label="Effacer la recherche"><X size={14} /></button>}</label>
        <label className="opportunities-select"><Filter size={15} /><select aria-label="Filtrer par direction" value={direction} onChange={(event) => setDirection(event.target.value)}><option value="">Tous les biais</option>{Object.entries(directionNames).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select><ChevronDown size={13} /></label>
        {effectiveTab !== "research" && <>
          <label className="opportunities-select"><Layers3 size={15} /><select aria-label="Filtrer par stratégie" value={strategy} onChange={(event) => setStrategy(event.target.value)}><option value="">Toutes les stratégies</option>{Object.entries(strategyLabels).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select><ChevronDown size={13} /></label>
          <label className="opportunities-select"><ShieldCheck size={15} /><select aria-label="Filtrer par statut des données" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tous les statuts</option>{availableStatuses.map((value) => <option value={value} key={value}>{statusNames[value] ?? value}</option>)}</select><ChevronDown size={13} /></label>
          <div className="opportunities-columns">
            <button className="button button-secondary" onClick={() => setShowColumns((value) => !value)} aria-expanded={showColumns}><ListFilter size={17} /> Colonnes</button>
            {showColumns && <div className="opportunities-column-popover"><strong>Colonnes visibles</strong>{fullColumns.map((column) => <label key={column.key}><input type="checkbox" checked={columns.includes(column.key)} onChange={() => setColumns((value) => value.includes(column.key) ? value.filter((item) => item !== column.key) : [...value, column.key])} />{column.label}</label>)}</div>}
          </div>
        </>}
      </div>
      {effectiveTab === "saved" && <div className="opportunity-saved-note"><Info size={15} /> Les stratégies archivées conservent leur statut et leur score à la date du scan.</div>}
      {effectiveTab === "saved" && !savedOpportunities.length ? <div className="empty-state opportunities-empty"><Bookmark size={24} /><strong>Aucune stratégie enregistrée.</strong><p>Enregistrez un rapport depuis sa page d’analyse pour le retrouver ici.</p></div> :
        effectiveTab !== "research" ? <OpportunityTable opportunities={opportunities} columns={columns} checked={compareIds} onCompare={toggleComparison} scopeKey={`${term}|${direction}|${strategy}|${status}`} /> : <CandidateList candidates={candidates} />}
    </section>
    {effectiveTab !== "research" && compareIds.length > 0 && <section className="panel opportunities-comparison" aria-label="Comparateur de stratégies">
      <div className="panel-heading"><div><h2><GitCompareArrows size={18} /> Comparateur</h2><p>{selected.length} / 3 sélectionnées</p></div><div className="opportunities-comparison-actions"><button className="button button-secondary" onClick={() => { setCompareIds([]); setComparing(false); }}>Effacer</button><button className="button button-primary" disabled={selected.length < 2} onClick={() => setComparing((value) => !value)}>{comparing ? "Fermer" : "Comparer"}</button></div></div>
      <div className="opportunities-compare-pills">{selected.map((item) => <button className="badge" key={item.id} onClick={() => toggleComparison(item.id)} aria-label={`Retirer ${item.symbol} ${strategyLabels[item.strategy]}`}>{item.symbol} · {strategyLabels[item.strategy]} <X size={13} /></button>)}</div>
      {comparing && <div className="opportunities-compare-results">{selected.map((item) => <div key={item.id}><h3>{item.symbol} · {strategyLabels[item.strategy]}</h3><dl><dt>Débit</dt><dd>{usd(item.result.entryDebit)}</dd><dt>Perte maximale</dt><dd>{usd(item.result.maxLoss)}</dd><dt>Gain maximal</dt><dd>{usd(item.result.maxProfit, "Illimité")}</dd><dt>Seuil de rentabilité</dt><dd>{usd(item.result.breakEven)}</dd></dl><PayoffChart item={item} title={`Profil de ${item.symbol}`} /><Link href={`/opportunities/${encodeURIComponent(item.id)}`} className="button button-secondary">Ouvrir l’analyse</Link></div>)}</div>}
    </section>}
  </div>;
}

export function OpportunityTable({ opportunities, compact, columns, checked, onCompare, scopeKey = "" }: {
  opportunities: Opportunity[]; compact?: boolean; columns?: Column[]; checked?: string[]; onCompare?: (id: string) => void; scopeKey?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "score", desc: true });
  const [pagination, setPagination] = useState({ scope: scopeKey, index: 0 });
  const visibleColumns = fullColumns.filter(({ key }) => (compact ? compactColumns : columns ?? initialColumns).includes(key));
  const sorted = useMemo(() => [...opportunities].sort((a, b) => {
    const first = sortValue(a, sort.key);
    const second = sortValue(b, sort.key);
    if (first === null || second === null) return first === second ? 0 : first === null ? 1 : -1;
    const comparison = typeof first === "number" && typeof second === "number" ? first - second : String(first).localeCompare(String(second), "fr");
    return sort.desc ? -comparison : comparison;
  }), [opportunities, sort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pagination.scope === scopeKey ? pagination.index : 0, totalPages - 1);
  const rows = compact ? sorted : sorted.slice(page * pageSize, (page + 1) * pageSize);

  function sortColumn(key: SortKey) {
    setSort((current) => ({ key, desc: current.key === key ? !current.desc : key === "score" }));
    setPagination({ scope: scopeKey, index: 0 });
  }

  function heading(key: SortKey, label: string) {
    return <th scope="col" key={key} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button onClick={() => sortColumn(key)}>{label}{sort.key === key && <ChevronDown size={12} className={sort.desc ? "" : "opportunities-sort-ascending"} />}</button>
    </th>;
  }

  if (!rows.length) return <div className="empty-state opportunities-empty"><ChartNoAxesCombined size={24} /><strong>Aucune opportunité ne respecte actuellement vos critères.</strong><p>Les opportunités s’affichent lorsque les données disponibles et les limites configurées permettent de construire une stratégie.</p>{!scopeKey.replaceAll("|", "") && <Link href="/scanner" className="button button-secondary"><Radar size={15} /> Ouvrir le scanner</Link>}</div>;

  return <>
    <div className="opportunities-table-scroll">
      <table className="opportunities-table">
        <thead><tr>
          {onCompare && <th scope="col" className="opportunities-check-col"><span className="sr-only">Comparer</span><GitCompareArrows aria-hidden="true" size={15} /></th>}
          {heading("symbol", "Symbole")}{heading("strategy", "Stratégie")}
          {visibleColumns.map(({ key, label }) => heading(key, label))}
          <th scope="col"><span className="sr-only">Ouvrir</span></th>
        </tr></thead>
        <tbody>{rows.map((item) => <tr key={item.id}>
          {onCompare && <td><input type="checkbox" aria-label={`Comparer ${item.symbol} ${strategyLabels[item.strategy]}`} checked={checked?.includes(item.id) ?? false} disabled={!checked?.includes(item.id) && (checked?.length ?? 0) >= 3} onChange={() => onCompare(item.id)} /></td>}
          <td><Link className="opportunity-symbol-link" href={`/opportunities/${encodeURIComponent(item.id)}`}><SymbolMark symbol={item.symbol} /><span><strong>{item.symbol}</strong><small>{item.name}</small></span></Link></td>
          <td>{strategyLabels[item.strategy]}</td>
          {visibleColumns.map(({ key }) => <td key={key} className={`opportunity-cell-${key}`}>{renderCell(item, key)}</td>)}
          <td><Link href={`/opportunities/${encodeURIComponent(item.id)}`} aria-label={`Ouvrir ${item.symbol} ${strategyLabels[item.strategy]}`} className="icon-button opportunity-row-open"><ChevronRight size={17} /></Link></td>
        </tr>)}</tbody>
      </table>
    </div>
    {!compact && <div className="opportunities-pagination"><span>{sorted.length} résultat{sorted.length > 1 ? "s" : ""}</span><div><button className="icon-button" aria-label="Page précédente" disabled={page === 0} onClick={() => setPagination({ scope: scopeKey, index: page - 1 })}><ChevronLeft size={17} /></button><span>Page {page + 1} sur {totalPages}</span><button className="icon-button" aria-label="Page suivante" disabled={page >= totalPages - 1} onClick={() => setPagination({ scope: scopeKey, index: page + 1 })}><ChevronRight size={17} /></button></div></div>}
  </>;
}

function renderCell(item: Opportunity, key: Column) {
  switch (key) {
    case "price": return usd(item.price);
    case "direction": return <Direction value={item.direction} />;
    case "expiration": return formatDate(item.expiration, false);
    case "dte": return `${item.dte} j`;
    case "debit": return usd(item.result.entryDebit);
    case "risk": return <span className="text-negative">{usd(item.result.maxLoss)}</span>;
    case "profit": return <span className="text-positive">{usd(item.result.maxProfit, "Illimité")}</span>;
    case "ratio": return item.result.rewardRisk === null ? "—" : `${numberFormat.format(item.result.rewardRisk)}×`;
    case "score": return item.score ? <span className="opportunity-score">{item.score.total}<small>/100</small></span> : <span className="text-muted" title="Données insuffisantes pour établir un score" aria-label="Non classable">—</span>;
    case "status": return <Quality value={item.status} />;
    case "updated": return formatDate(item.updatedAt);
  }
}

function sortValue(item: Opportunity, key: SortKey) {
  switch (key) {
    case "debit": return item.result.entryDebit;
    case "risk": return item.result.maxLoss;
    case "profit": return item.result.maxProfit;
    case "ratio": return item.result.rewardRisk;
    case "score": return item.score?.total ?? null;
    case "updated": return item.updatedAt;
    default: return item[key];
  }
}

function CandidateList({ candidates }: { candidates: ResearchCandidate[] }) {
  if (!candidates.length) return <div className="empty-state opportunities-empty"><Radar size={24} /><strong>Aucun candidat de recherche trouvé.</strong><p>Modifiez vos filtres ou lancez une recherche sur des sous-jacents.</p></div>;
  return <div className="opportunities-candidates">{candidates.map((candidate) => {
    const quote = candidate.sources.find((item) => item.quoteAt);
    return <article key={candidate.symbol} className="opportunities-candidate">
    <header><div className="opportunity-symbol-link"><SymbolMark symbol={candidate.symbol} /><span><strong>{candidate.symbol}</strong><small>{candidate.name}</small></span></div><Direction value={candidate.direction} /></header>
    <p>{candidate.thesis}</p>
    <span className="opportunities-candidate-price"><strong>{usd(candidate.price)}</strong><Quality value={candidate.status} /></span>
    {candidate.price !== null && quote?.quoteAt && <p className="opportunity-quote-citation"><SourceLink url={quote.url} publisher={quote.publisher} isDemo={candidate.status === "DEMO"} /> · {formatDate(quote.quoteAt)} (HE)</p>}
    {(candidate.bullishFactors.length > 0 || candidate.bearishFactors.length > 0 || candidate.risks.length > 0 || candidate.sources.length > 0) && <details>
      <summary>Éléments de recherche</summary>
      <Evidence candidate={candidate} />
    </details>}
    </article>;
  })}</div>;
}

function OpportunityDetail({ opportunity: item, candidate, refresh, isDemo, isArchived, isSaved }: {
  opportunity: Opportunity; candidate?: ResearchCandidate; refresh: () => Promise<void>; isDemo: boolean; isArchived: boolean; isSaved: boolean;
}) {
  const [watchStatus, setWatchStatus] = useState<"" | "saving" | "saved" | "failed">("");
  const [bookmarkStatus, setBookmarkStatus] = useState<"" | "saving" | "failed">("");
  const priceAnchor = item.price ?? item.input.legs[0]?.strike ?? 0;
  const scenarios = [[-0.10, "Forte baisse"], [-0.05, "Baisse modérée"], [0, "Stabilité"], [0.05, "Hausse modérée"], [0.10, "Forte hausse"]] as const;
  async function watch() {
    setWatchStatus("saving");
    try {
      const result = await fetch("/api/watchlists/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: item.symbol }) });
      if (!result.ok) throw new Error("watchlist");
      await refresh();
      setWatchStatus("saved");
    } catch {
      setWatchStatus("failed");
    }
  }
  async function bookmark() {
    setBookmarkStatus("saving");
    try {
      const result = await fetch(`/api/opportunities/${encodeURIComponent(item.id)}/bookmark`, { method: isSaved ? "DELETE" : "POST" });
      if (!result.ok) throw new Error("bookmark");
      await refresh();
      setBookmarkStatus("");
    } catch {
      setBookmarkStatus("failed");
    }
  }

  return <article className="opportunity-detail">
    <Link href="/opportunities" className="opportunity-back"><ChevronLeft size={16} /> Toutes les opportunités</Link>
    <div className="page-heading">
      <div><div className="opportunity-detail-symbol"><SymbolMark symbol={item.symbol} /><h1>{item.symbol} <span>{strategyLabels[item.strategy]}</span></h1></div>
        <p>{item.name} · Échéance {formatDate(item.expiration, false)} · {item.dte} jours à la date du scan</p>
      </div>
      <div className="opportunity-detail-status"><Quality value={item.status} />{isArchived && <span className="badge">Archivée</span>}</div>
    </div>
    <div className="opportunity-detail-actions">
      <button className="button button-secondary" onClick={() => void bookmark()} disabled={bookmarkStatus === "saving"} aria-pressed={isSaved}>{isSaved ? <Check size={16} /> : <Bookmark size={16} />} {isSaved ? "Retirer des enregistrements" : "Enregistrer la recherche"}</button>
      <button className="button button-secondary" onClick={() => void watch()} disabled={watchStatus === "saved" || watchStatus === "saving"}>{watchStatus === "saved" ? <Check size={16} /> : <Layers3 size={16} />} {watchStatus === "saved" ? "Ajouté à la liste" : watchStatus === "saving" ? "Ajout en cours…" : "Suivre le symbole"}</button>
      <Link href={`/opportunities?compare=${encodeURIComponent(item.id)}`} className="button button-secondary"><GitCompareArrows size={16} /> Comparer</Link>
      <Link href={`/strategy-lab?opportunity=${encodeURIComponent(item.id)}`} className="button button-secondary"><FlaskConical size={16} /> Ouvrir au laboratoire</Link>
      <button className="button button-secondary" onClick={() => exportOpportunity(item)}><Download size={16} /> Exporter</button>
      <Link href={`/scanner?symbol=${encodeURIComponent(item.symbol)}`} className="button button-secondary"><Radar size={16} /> Relancer la recherche</Link>
      <Link href={`/portfolio?opportunity=${encodeURIComponent(item.id)}`} className="button button-primary"><Wallet size={16} /> Ajouter au portefeuille papier</Link>
    </div>
    {watchStatus === "failed" && <p className="text-negative" role="alert">Le symbole n’a pas pu être ajouté à la liste.</p>}
    {bookmarkStatus === "failed" && <p className="text-negative" role="alert">La mise à jour des recherches enregistrées a échoué.</p>}
    <div className="opportunity-provenance-note"><Info size={17} /> {isDemo ? "Simulation avec cotations entièrement fictives." : isArchived ? "Rapport archivé. Les cotations reflètent la date du scan." : "Cotation de recherche. Vérifiez la disponibilité et les prix auprès de votre courtier."} Les gains et pertes ci-dessous sont calculés à l’échéance.</div>
    <div className="opportunity-metrics">
      <Metric label="Cours de référence" value={usd(item.price)} />
      <Metric label="Débit d’entrée" value={usd(item.result.entryDebit)} />
      <Metric label="Perte maximale" value={usd(item.result.maxLoss)} tone="text-negative" />
      <Metric label="Gain maximal" value={usd(item.result.maxProfit, "Illimité")} tone="text-positive" />
      <Metric label="Seuil de rentabilité" value={usd(item.result.breakEven)} />
      <Metric label="Gain / risque" value={item.result.rewardRisk === null ? "—" : `${numberFormat.format(item.result.rewardRisk)}×`} />
    </div>
    <div className="opportunity-detail-grid">
      <section className="panel opportunity-detail-panel"><div className="panel-heading"><div><h2>Profil à l’échéance</h2><p>Résultat selon le cours du sous-jacent · USD</p></div><ChartNoAxesCombined size={18} /></div><PayoffChart item={item} title={`Profil à l’échéance de ${item.symbol}`} /></section>
      <section className="panel opportunity-detail-panel"><div className="panel-heading"><div><h2>Score de recherche</h2><p>Critères de classement</p></div>{item.score && <strong className="opportunity-large-score">{item.score.total}<small>/100</small></strong>}</div>
        {item.score ? <ul className="opportunity-score-list">{item.score.breakdown.map((component) => <li key={component.key}><div><strong>{component.label} <small>· poids {numberFormat.format(component.weight)} %</small></strong><span>{numberFormat.format(component.value)} / 100</span></div><p>{component.reason}</p></li>)}</ul> : <p className="text-muted">Les données disponibles ne permettent pas d’établir un score.</p>}
      </section>
    </div>
    <section className="panel opportunity-detail-panel"><div className="panel-heading"><div><h2>Contrats</h2><p>Cotations et provenance de chaque jambe</p></div></div>
      <div className="opportunities-table-scroll"><table className="opportunities-table"><thead><tr>{["Sens", "Contrat", "Strike", "Échéance", "Qté", "Bid", "Ask", "Horodatage", "Source"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{item.input.legs.map((leg, index) => <tr key={leg.id}>
        <td>{index === 0 ? "Achat" : "Vente"}</td><td><strong>{leg.type === "call" ? "Call" : "Put"}</strong><br /><small className="text-muted">{leg.id}</small></td><td>{usd(leg.strike)}</td><td>{formatDate(leg.expiration, false)}</td><td>{item.input.quantity} × {leg.multiplier}</td><td>{usd(leg.bid)}</td><td>{usd(leg.ask)}</td><td>{formatDate(leg.quoteAt)} (HE)</td><td><SourceLink url={leg.source.url} publisher={leg.source.publisher} isDemo={isDemo} /></td>
      </tr>)}</tbody></table></div>
    </section>
    <div className="opportunity-detail-grid">
      <section className="panel opportunity-detail-panel"><div className="panel-heading"><div><h2>Scénarios à l’échéance</h2><p>Variations hypothétiques autour de {usd(priceAnchor)}</p></div></div>
        <div className="opportunities-table-scroll"><table className="opportunities-table"><thead><tr><th scope="col">Scénario</th><th scope="col">Cours</th><th scope="col">P&L</th></tr></thead><tbody>{scenarios.map(([move, label]) => {
          const price = Math.round(priceAnchor * (1 + move) * 100) / 100;
          const result = payoffAt(item.input, price);
          return <tr key={label}><td>{label}</td><td>{usd(price)}</td><td className={result >= 0 ? "text-positive" : "text-negative"}>{usd(result)}</td></tr>;
        })}</tbody></table></div>
      </section>
      <section className="panel opportunity-detail-panel"><div className="panel-heading"><div><h2>Thèse et risques</h2><p>Éléments associés à l’analyse</p></div><Direction value={item.direction} /></div><p className="opportunity-thesis">{item.thesis}</p>
        {item.warnings.length > 0 && <ul className="opportunity-warnings">{item.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        {candidate && <Evidence candidate={candidate} />}
      </section>
    </div>
  </article>;
}

function Evidence({ candidate }: { candidate: ResearchCandidate }) {
  const groups = [["Facteurs haussiers", candidate.bullishFactors], ["Facteurs baissiers", candidate.bearishFactors], ["Risques", candidate.risks]] as const;
  return <div className="opportunity-evidence">
    {groups.map(([label, items]) => items.length > 0 && <div key={label}><h3>{label}</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>)}
    {candidate.sources.length > 0 && <div><h3>Sources et horodatages</h3>
      <ul>{candidate.sources.map((source, index) => <li key={`${source.url}-${index}`}><SourceLink url={source.url} publisher={source.publisher} isDemo={candidate.status === "DEMO"} /> <span className="text-muted">· {source.quoteAt ? `Cotation ${formatDate(source.quoteAt)}` : `Consulté ${formatDate(source.retrievedAt)}`} (HE)</span>
        {source.citation && <p className="opportunity-citation-excerpt">{source.citation}</p>}
      </li>)}</ul>
    </div>}
  </div>;
}

function SourceLink({ url, publisher, isDemo }: { url: string; publisher: string; isDemo?: boolean }) {
  return !isDemo && /^https:\/\//i.test(url) ? <a href={url} target="_blank" rel="noreferrer" className="opportunity-source">{publisher} <ExternalLink size={12} /></a> : <span>{publisher}</span>;
}

function PayoffChart({ item, title }: { item: Opportunity; title: string }) {
  const strikes = item.input.legs.map((leg) => leg.strike);
  const bound = item.result.breakEven ?? strikes[0];
  const lower = Math.max(0, Math.min(...strikes, bound) * 0.8);
  const upper = Math.max(...strikes, bound) * 1.2;
  const xValues = [...new Set([...Array.from({ length: 33 }, (_, index) => lower + (upper - lower) / 32 * index), ...strikes, bound])].sort((first, second) => first - second);
  const data = xValues.map((price) => ({ price, pnl: payoffAt(item.input, price) }));
  const axis = { fill: "#8589a2", fontSize: 11 };
  return <div className="opportunity-payoff" role="img" aria-label={title}>
    <ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{ right: 14, left: 1, bottom: 5, top: 8 }}>
      <CartesianGrid stroke="#292b3d" strokeDasharray="3 5" vertical={false} />
      <XAxis dataKey="price" type="number" domain={[lower, upper]} tickFormatter={(value) => numberFormat.format(value)} tick={axis} tickLine={false} axisLine={false} padding={{ left: 4, right: 4 }} />
      <YAxis tick={axis} tickFormatter={(value) => `${value}$`} tickLine={false} axisLine={false} width={49} />
      <ReferenceLine y={0} stroke="#676c88" strokeDasharray="4 4" />
      {strikes.map((strike, index) => <ReferenceLine key={`${strike}-${index}`} x={strike} stroke="#8876b2" strokeDasharray="2 4" />)}
      {item.result.breakEven !== null && <ReferenceLine x={item.result.breakEven} stroke="#4abfa2" strokeDasharray="5 3" />}
      <Tooltip labelFormatter={(value) => `Sous-jacent ${usd(Number(value))}`} formatter={(value) => usd(Number(value))} contentStyle={{ background: "#151827", border: "1px solid #33354e", borderRadius: "9px" }} />
      <Area type="linear" dataKey="pnl" name="P&L à l’échéance" stroke="#a38afb" strokeWidth={2.5} fill="#a38afb29" baseValue={0} isAnimationActive={false} />
    </AreaChart></ResponsiveContainer>
  </div>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="panel opportunity-metric"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function Direction({ value }: { value: ResearchCandidate["direction"] }) {
  return <span className="opportunity-bias" data-tone={value}><i /> {directionNames[value]}</span>;
}

function Quality({ value }: { value: string }) {
  return <span className="opportunity-quality" data-tone={value === "DEMO" ? "demo" : value.startsWith("VERIFIED") ? "verified" : "other"}>{statusNames[value] ?? value}</span>;
}

function SymbolMark({ symbol }: { symbol: string }) {
  return <span className="opportunity-symbol-mark" data-symbol={symbol} aria-hidden="true">{symbol.slice(0, 1)}</span>;
}

function usd(number: number | null | undefined, fallback = "—") {
  return number === null || number === undefined ? fallback : usdFormat.format(number);
}

function formatDate(value: string, time = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-CA", time ? { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" } : { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function exportOpportunity(opportunity: Opportunity) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(opportunity, null, 2)], { type: "application/json" }));
  const download = document.createElement("a");
  download.href = url;
  download.download = `${opportunity.symbol}-${opportunity.strategy}.json`;
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
