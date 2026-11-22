"use client";

import {
  Activity, BarChart3, CircleDollarSign, Clock3, Database, FlaskConical, Layers3,
  Radar, ShieldCheck, TrendingDown, TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { strategyLabels, type Strategy } from "@/lib/quant";
import type { AppState } from "@/lib/workspace";
import { OpportunityTable } from "./opportunities";

const chartColors = ["#9b7ef8", "#684dd6", "#5a8ae8", "#3abeb0"];
const axisFont = { fill: "#8589a2", fontSize: 11 };
const tooltipStyle = { background: "#17192a", color: "#f3f1fb", border: "1px solid #34354b", borderRadius: "10px", boxShadow: "0 4px 22px #08091080" };
const prices = new Intl.NumberFormat("fr-CA", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numbers = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 2 });
const marketDate = new Intl.DateTimeFormat("fr-CA", { day: "numeric", month: "short", timeZone: "America/New_York" });
const scanStatuses = { queued: "Planifié", running: "En cours", completed: "Terminé", partial: "Partiel", failed: "Échec", cancelled: "Annulé" };

export function Overview({ state }: { state: AppState }) {
  const lastScan = state.scans[0];
  const latestQuote = [...state.opportunities.flatMap((opportunity) => opportunity.input.legs.map((leg) => leg.quoteAt)), ...state.marketSeries.quotes.flatMap((quote) => quote.quoteAt ?? [])]
    .reduce((latest, stamp) => Date.parse(stamp) > Date.parse(latest || "1970-01-01") ? stamp : latest, "");
  const trend = state.marketSeries.trend;
  const distribution = (Object.keys(strategyLabels) as Strategy[]).flatMap((strategy, index) => {
    const count = state.opportunities.filter((item) => item.strategy === strategy).length;
    return count ? [{ name: strategyLabels[strategy], value: count, color: chartColors[index] }] : [];
  });
  const watchCount = new Set(state.watchlists.flatMap((list) => list.items)).size;
  const cost = state.cost.monthly;
  const hasRealized = state.analytics.equity.length > 0;
  const isDemo = state.mode === "demo";
  const verifiedCount = state.opportunities.filter((item) => item.status === "VERIFIED_FRESH" || item.status === "VERIFIED_DELAYED").length;
  const manualCount = state.opportunities.filter((item) => item.status === "MANUAL_ATTESTED").length;
  const displayedCount = isDemo ? state.opportunities.length : verifiedCount + manualCount;
  const scanTrend = trend.map((point) => ({ ...point, timestamp: Date.parse(point.date) }));
  const trendTicks = scanTrend.length <= 7 ? scanTrend.map((point) => point.timestamp) : undefined;
  const directions = [
    { id: "bullish", name: "Haussier", color: "#41d5a1" },
    { id: "bearish", name: "Baissier", color: "#f17791" },
    { id: "neutral", name: "Neutre", color: "#a38afb" },
    { id: "mixed", name: "Mitigé", color: "#f1c17a" },
    { id: "insufficient", name: "Insuffisant", color: "#8589a2" },
  ].map((direction) => ({ ...direction, count: state.candidates.filter((item) => item.direction === direction.id).length }));

  return <div className="overview">
    <div className="overview-market" aria-label="Cours de référence des sous-jacents">
      <span className="overview-market-label"><Activity size={16} /> <span>MARCHÉ US</span></span>
      {state.marketSeries.quotes.length ? state.marketSeries.quotes.map((quote) => {
        const series = isDemo ? quote.history : undefined;
        const positive = quote.change !== null && quote.change >= 0;
        return <Link href={`/opportunities?q=${encodeURIComponent(quote.symbol)}&view=research`} key={quote.symbol} className="overview-quote" title={quote.source && quote.quoteAt ? `${quote.source} · ${dateLabel(quote.quoteAt)} (HE)` : isDemo ? "Cours fictif, simulation" : "Ouvrir la recherche"}>
          <div><strong>{quote.symbol}</strong><span>{quote.price === null ? "—" : prices.format(quote.price)}</span></div>
          <div className="overview-quote-trend">
            {series && <Sparkline values={series} positive={positive} />}
            {!isDemo && quote.quoteAt && <time dateTime={quote.quoteAt} className="overview-quote-time">{marketDate.format(new Date(quote.quoteAt))} · HE</time>}
            <span className={quote.change === null ? "text-muted" : positive ? "text-positive" : "text-negative"}>
              {quote.change === null ? "—" : `${positive ? "+" : ""}${numbers.format(quote.change)} %`}
            </span>
          </div>
        </Link>;
      }) : <p>Aucun cours horodaté dans les résultats enregistrés.</p>}
    </div>

    <section className="overview-hero" aria-labelledby="overview-title">
      <div className="overview-hero-content">
        <div className="overview-hero-kicker"><span className="overview-hero-kicker-icon"><Radar size={15} /></span> RECHERCHE ET STRATÉGIES</div>
        <h1 id="overview-title">Votre centre d’intelligence<br className="overview-hero-break" /> pour le trading d’options</h1>
        <p>Découvrez, comparez et analysez les opportunités du marché avec l’intelligence artificielle.</p>
        <div className="overview-hero-actions">
          <Link href="/scanner" className="button button-primary"><Radar size={17} /> Scanner le marché</Link>
          <Link href="/strategy-lab" className="button button-hero"><FlaskConical size={17} /> Laboratoire</Link>
        </div>
      </div>
      <div className="overview-hero-art" aria-hidden="true">
        <span className="overview-orbit overview-orbit-1" /><span className="overview-orbit overview-orbit-2" /><span className="overview-orbit overview-orbit-3" />
        <span className="overview-orbit overview-orbit-4" /><span className="overview-orbit overview-orbit-5" />
        <span className="overview-orbit-dot overview-orbit-dot-one" /><span className="overview-orbit-dot overview-orbit-dot-two" />
        <span className="overview-orbit-core"><Radar size={76} strokeWidth={0.85} /></span>
      </div>
    </section>

    <div className="overview-kpis">
      <Kpi icon={<Radar size={17} />} tone="accent" label="Candidats de recherche" value={String(state.candidates.length)} detail="Sous-jacents documentés" href="/opportunities?view=research" />
      <Kpi icon={<ShieldCheck size={17} />} tone="blue" label={isDemo ? "Stratégies de démonstration" : manualCount ? "Opportunités admissibles" : "Opportunités vérifiées"} value={String(displayedCount)} detail={isDemo ? "Calculées à partir des cotations fictives" : manualCount ? `${verifiedCount} vérifiées · ${manualCount} sur saisie courtier attestée` : "Contrats et cotations validés"} href="/opportunities" />
      <Kpi icon={<Layers3 size={17} />} tone="cyan" label="Symboles suivis" value={String(watchCount)} detail={`${state.watchlists.length} liste${state.watchlists.length !== 1 ? "s" : ""} de suivi`} href="/watchlist" />
      <Kpi icon={<CircleDollarSign size={17} />} tone="green" label="P&L réalisé · papier" value={hasRealized ? signedPrice(state.analytics.realizedPnl) : "—"} valueTone={hasRealized ? (state.analytics.realizedPnl >= 0 ? "text-positive" : "text-negative") : undefined} detail={state.analytics.completedTrades > 0 ? `${state.analytics.completedTrades} position${state.analytics.completedTrades !== 1 ? "s" : ""} clôturée${state.analytics.completedTrades !== 1 ? "s" : ""}` : hasRealized ? "Sorties partielles enregistrées" : "Aucune position clôturée"} href="/portfolio" />
    </div>

    <div className="overview-charts">
      <section className="panel overview-chart" aria-labelledby="trend-heading">
        <div className="panel-heading">
          <div><h2 id="trend-heading">Activité de recherche</h2><p>Candidats et stratégies au fil des scans</p></div>
          <span className="overview-chart-chip"><Clock3 size={13} /> {scanTrend.length > 1 ? `${scanTrend.length} relevés` : "Historique"}</span>
        </div>
        <div className="overview-area-chart">
          {scanTrend.length > 1 ? <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={scanTrend} margin={{ top: 6, right: 10, left: -19, bottom: 0 }}>
              <defs>
                <linearGradient id="overview-trend-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#9972f7" stopOpacity={0.39} /><stop offset="100%" stopColor="#9972f7" stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#26283c" strokeDasharray="4 5" />
              <XAxis dataKey="timestamp" type="number" scale="time" domain={["dataMin", "dataMax"]} ticks={trendTicks} tickFormatter={trendDate} axisLine={false} tickLine={false} tick={axisFont} tickMargin={11} minTickGap={14} />
              <YAxis axisLine={false} tickLine={false} tick={axisFont} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#c1b4ff", marginBottom: 5 }} labelFormatter={trendDate} />
              <Area isAnimationActive={false} type="linear" name="Candidats" dataKey="value" stroke="#a084ff" strokeWidth={2.5} fill="url(#overview-trend-fill)" />
              {scanTrend.some((point) => typeof point.secondary === "number") && <Area isAnimationActive={false} type="linear" name="Stratégies" dataKey="secondary" stroke="#50bcae" strokeWidth={1.7} fill="transparent" strokeDasharray="4 4" />}
            </AreaChart>
          </ResponsiveContainer> : <ChartEmpty icon={<BarChart3 size={24} />} text="Au moins deux relevés sont nécessaires pour tracer une tendance." />}
        </div>
        <div className="overview-chart-legend"><span><i /> Candidats</span>{scanTrend.some((point) => typeof point.secondary === "number") && <span><i /> Stratégies</span>}{isDemo && <small>Série fictive</small>}</div>
      </section>
      <section className="panel overview-distribution" aria-labelledby="strategy-heading">
        <div className="panel-heading"><div><h2 id="strategy-heading">Répartition des stratégies</h2><p>Vue par structure d’options</p></div><span className="panel-heading-icon"><Layers3 size={18} /></span></div>
        {distribution.length ? <div className="overview-donut-body">
          <div className="overview-donut">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart><Pie data={distribution} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="88%" startAngle={90} endAngle={-270} paddingAngle={4} stroke="none" isAnimationActive={false}>{distribution.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
            <div className="overview-donut-total"><strong>{state.opportunities.length}</strong><span>Stratégies</span></div>
          </div>
          <ul className="overview-donut-legend">{distribution.map((item) => <li key={item.name}><i style={{ backgroundColor: item.color }} /><span>{item.name}</span><strong>{item.value}</strong></li>)}</ul>
        </div> : <ChartEmpty icon={<Layers3 size={24} />} text="La répartition apparaît dès qu’une stratégie admissible est enregistrée." />}
      </section>
    </div>

    <section className="panel overview-opportunities" aria-labelledby="overview-ranked-heading">
      <div className="panel-heading"><div><h2 id="overview-ranked-heading">Opportunités classées</h2><p>{isDemo ? "Stratégies fictives issues des scans de démonstration" : "Analyses indicatives issues de contrats admissibles"}</p></div><Link href="/opportunities" className="button button-secondary">Voir les opportunités</Link></div>
      <OpportunityTable opportunities={state.opportunities} compact />
    </section>

    <div className="overview-bottom">
      <section className="panel overview-summary" aria-labelledby="summary-heading">
        <div className="panel-heading"><div><h2 id="summary-heading">État de la recherche</h2><p>Dernier relevé et couverture</p></div><span className="panel-heading-icon"><Database size={18} /></span></div>
        <dl className="overview-summary-list">
          <div><dt>Dernier scan</dt><dd>{lastScan ? `${scanStatuses[lastScan.status]} · ${dateLabel(lastScan.completedAt ?? lastScan.startedAt)}` : "Aucun scan enregistré"}</dd></div>
          <div><dt>Coût OpenAI du mois, estimé</dt><dd>{isDemo || state.research.pricingConfigured ? `${prices.format(cost)} USD` : "Tarifs indisponibles"}</dd></div>
          <div><dt>Dernière cotation incluse</dt><dd>{latestQuote ? dateLabel(latestQuote) : "Indisponible"}</dd></div>
        </dl>
      </section>
      <section className="panel overview-summary" aria-labelledby="direction-heading">
        <div className="panel-heading"><div><h2 id="direction-heading">Biais de recherche</h2><p>Répartition des candidats par direction</p></div><span className="panel-heading-icon"><TrendingUp size={18} /></span></div>
        <div className="overview-direction-bars">{directions.filter((direction) => direction.count > 0).map((direction) => <div key={direction.id}><span>{direction.name}</span><i><b style={{ width: `${direction.count / state.candidates.length * 100}%`, background: direction.color }} /></i><strong>{direction.count}</strong></div>)}</div>
        {!state.candidates.length && <p className="overview-small-empty">Aucun biais directionnel documenté.</p>}
      </section>
      <section className="panel overview-summary" aria-labelledby="equity-heading">
        <div className="panel-heading"><div><h2 id="equity-heading">Résultat papier cumulé</h2><p>Seulement les gains et pertes réalisés</p></div><span className="panel-heading-icon"><TrendingDown size={18} /></span></div>
        {state.analytics.equity.length > 1 ? <div className="overview-equity">
          <ResponsiveContainer width="100%" height={110}><AreaChart data={state.analytics.equity} margin={{ top: 8, left: 2, right: 2, bottom: 3 }}><Area type="stepAfter" dataKey="value" name="P&L réalisé" stroke="#48cba2" strokeWidth={2} fill="#48cba21c" isAnimationActive={false} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => signedPrice(Number(value))} labelFormatter={(label, entries) => dateLabel(entries[0]?.payload.date ?? String(label), false)} /></AreaChart></ResponsiveContainer>
        </div> : <p className="overview-small-empty">L’historique réalisé sera disponible après plusieurs clôtures.</p>}
      </section>
    </div>
  </div>;
}

function Kpi({ icon, tone, label, value, detail, href, valueTone }: {
  icon: React.ReactNode; tone: string; label: string; value: string; detail: string; href: string; valueTone?: string;
}) {
  return <Link href={href} className="panel overview-kpi"><div className="overview-kpi-header"><span className="overview-kpi-icon" data-tone={tone}>{icon}</span><span>{label}</span></div><strong className={valueTone}>{value}</strong><span className="overview-kpi-detail">{detail}</span></Link>;
}

function Sparkline({ values, positive }: { values: number[]; positive: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const series = values.map((value) => ({ value: max === min ? 0.5 : (value - min) / (max - min) }));
  return <span className="overview-sparkline" aria-hidden="true">
    <ResponsiveContainer width="100%" height="100%"><AreaChart accessibilityLayer={false} data={series} margin={{ top: 2, bottom: 2, left: 1, right: 1 }}><Area isAnimationActive={false} type="monotone" dataKey="value" stroke={positive ? "#46cba2" : "#f17791"} strokeWidth={1.1} fill={positive ? "#46cba219" : "#f1779118"} /></AreaChart></ResponsiveContainer>
  </span>;
}

function ChartEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="overview-chart-empty">{icon}<p>{text}</p></div>;
}

function dateLabel(value: string, full = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return new Intl.DateTimeFormat("fr-CA", full ? { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" } : { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function trendDate(value: unknown) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? dateLabel(new Date(timestamp).toISOString(), false) : "—";
}

function signedPrice(amount: number) {
  return `${amount > 0 ? "+" : ""}${prices.format(amount)}`;
}
