"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FlaskConical, Plus, RotateCcw, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { calculateStrategy, makeOccSymbol, optionTradingCutoff, payoffAt, strategyLabels } from "@/lib/quant";
import type { ContractQuote, Strategy, StrategyInput } from "@/lib/quant";
import type { AppState } from "@/lib/workspace";
import { dayInput, Empty, Field, Heading, money, Notice, number, Panel, Stat } from "./ui";

export interface ManualParameters {
  symbol: string;
  strategy: Strategy;
  expiration: string;
  longStrike: string;
  shortStrike: string;
  longPremium: string;
  shortPremium: string;
  quantity: string;
  fees: string;
}

export const strategyKeys = Object.keys(strategyLabels) as Strategy[];
export const isVertical = (strategy: Strategy) => strategy === "bull_call" || strategy === "bear_put";

export function prefilledOpportunity(state: AppState, id?: string) {
  if (!id) return undefined;
  return state.opportunities.find((item) => item.id === id) ??
    state.scans.flatMap((scan) => scan.opportunities).find((item) => item.id === id);
}

function demoExpiration(minDte: number, maxDte: number) {
  const now = Date.now();
  const anchor = Math.min(maxDte, Math.max(minDte, 21));
  const limit = Math.max(maxDte - anchor, anchor - minDte);
  for (let offset = 0; offset <= limit; offset++) {
    for (const dte of offset === 0 ? [anchor] : [anchor + offset, anchor - offset]) {
      if (dte < minDte || dte > maxDte) continue;
      const date = dayInput(new Date(now + dte * 86400000));
      const cutoff = optionTradingCutoff(date);
      if (cutoff !== null && cutoff > now) return date;
    }
  }
  return "";
}

export function defaults(demo: boolean, minDte = 7, maxDte = 30): ManualParameters {
  return {
    symbol: demo ? "SPY" : "", strategy: "bull_call",
    expiration: demo ? demoExpiration(minDte, maxDte) : "",
    longStrike: demo ? "100" : "", shortStrike: demo ? "105" : "",
    longPremium: demo ? "3.20" : "", shortPremium: demo ? "1.40" : "", quantity: "1", fees: "0",
  };
}

function complete(config: ManualParameters) {
  const { symbol, expiration, longStrike, longPremium, quantity, fees, shortStrike, shortPremium, strategy } = config;
  const required = [symbol, expiration, longStrike, longPremium, quantity, fees];
  if (isVertical(strategy)) required.push(shortStrike, shortPremium);
  return required.every((value) => value.trim());
}

function manualNumber(text: string) {
  return text.trim() ? Number(text) : Number.NaN;
}

export function manualInput(config: ManualParameters): StrategyInput {
  const symbol = config.symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new Error("Indiquez un symbole valide.");
  if (!/^\d{4}-\d\d-\d\d$/.test(config.expiration) || !Number.isFinite(Date.parse(config.expiration))) {
    throw new Error("Indiquez une date d’échéance valide.");
  }
  if (optionTradingCutoff(config.expiration) === null) throw new Error("L’échéance doit tomber un jour de séance d’options.");
  const type = config.strategy === "long_call" || config.strategy === "bull_call" ? "call" : "put";
  const now = new Date().toISOString();
  const quote = (strike: number, premium: number): ContractQuote => {
    if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(premium) || premium < 0) {
      throw new Error("Vérifiez les prix d’exercice et les primes.");
    }
    return {
      id: makeOccSymbol(symbol, config.expiration, type, strike),
      symbol,
      type,
      strike,
      expiration: config.expiration,
      multiplier: 100,
      bid: premium,
      ask: premium,
      currency: "USD",
      quoteAt: now,
      retrievedAt: now,
      source: { url: "/strategy-lab", publisher: "Saisie de simulation", method: "manual-simulation" },
      status: "UNVERIFIED",
    };
  };
  const legs = [quote(manualNumber(config.longStrike), manualNumber(config.longPremium))];
  if (isVertical(config.strategy)) legs.push(quote(manualNumber(config.shortStrike), manualNumber(config.shortPremium)));
  return { strategy: config.strategy, legs, quantity: manualNumber(config.quantity), fees: manualNumber(config.fees) };
}

export function fromInput(input: StrategyInput): ManualParameters {
  const [long, short] = input.legs;
  return {
    symbol: long.symbol,
    strategy: input.strategy,
    expiration: long.expiration,
    longStrike: String(long.strike),
    shortStrike: String(short?.strike ?? long.strike + 5),
    longPremium: String(long.ask),
    shortPremium: String(short?.bid ?? 0),
    quantity: String(input.quantity),
    fees: String(input.fees),
  };
}

export function ContractFields({ config, onChange, id, allowPast }: {
  config: ManualParameters; onChange: (config: ManualParameters) => void; id: string; allowPast?: boolean;
}) {
  const set = (key: keyof ManualParameters, value: string) => onChange({ ...config, [key]: value });
  const vertical = isVertical(config.strategy);
  return <div className="wp-fields">
    <Field label="Sous-jacent"><input value={config.symbol} name={id + "-symbol"} onChange={(event) => set("symbol", event.target.value.toUpperCase())} maxLength={10} required /></Field>
    <Field label="Stratégie"><select value={config.strategy} name={id + "-strategy"} onChange={(event) => {
      const strategy = event.target.value as Strategy;
      const longStrike = Number(config.longStrike);
      const shortStrike = Number(config.shortStrike);
      let nextShort = config.shortStrike;
      if (config.longStrike && config.shortStrike && strategy === "bear_put" && shortStrike >= longStrike) nextShort = String(Math.max(0.001, longStrike - 5));
      if (config.longStrike && config.shortStrike && strategy === "bull_call" && shortStrike <= longStrike) nextShort = String(longStrike + 5);
      onChange({ ...config, strategy, shortStrike: nextShort });
    }}>
      {strategyKeys.map((strategy) => <option value={strategy} key={strategy}>{strategyLabels[strategy]}</option>)}
    </select></Field>
    <Field label="Échéance"><input type="date" value={config.expiration} name={id + "-expiration"} min={allowPast ? undefined : dayInput()} onChange={(event) => set("expiration", event.target.value)} required /></Field>
    <Field label="Contrats"><input type="number" min="1" max="1000" value={config.quantity} name={id + "-quantity"} onChange={(event) => set("quantity", event.target.value)} required /></Field>
    <Field label="Exercice acheté"><input type="number" min=".001" step=".001" value={config.longStrike} name={id + "-long-strike"} onChange={(event) => set("longStrike", event.target.value)} required /></Field>
    <Field label="Prime achetée par action"><input type="number" min="0" step=".001" value={config.longPremium} name={id + "-long-premium"} onChange={(event) => set("longPremium", event.target.value)} required /></Field>
    {vertical && <>
      <Field label="Exercice vendu"><input type="number" min=".001" step=".001" value={config.shortStrike} name={id + "-short-strike"} onChange={(event) => set("shortStrike", event.target.value)} required /></Field>
      <Field label="Prime vendue par action"><input type="number" min="0" step=".001" value={config.shortPremium} name={id + "-short-premium"} onChange={(event) => set("shortPremium", event.target.value)} required /></Field>
    </>}
    <Field label="Frais totaux en USD"><input type="number" min="0" step=".01" value={config.fees} name={id + "-fees"} onChange={(event) => set("fees", event.target.value)} required /></Field>
  </div>;
}

const colors = ["#a68afa", "#48d5b2", "#efbd76"];

export function StrategyLab({ state, opportunityId }: { state: AppState; opportunityId?: string }) {
  const opportunity = prefilledOpportunity(state, opportunityId);
  const demoExample = state.mode === "demo" && !opportunity;
  const [config, setConfig] = useState<ManualParameters>(() => opportunity ? fromInput(opportunity.input) : defaults(demoExample));
  const [saved, setSaved] = useState<StrategyInput[]>([]);
  const [price, setPrice] = useState(() => opportunity?.price ?? (Number(config.longStrike) || null));
  const [showScenarios, setShowScenarios] = useState(false);
  const computed = useMemo(() => {
    if (!complete(config)) return {};
    try {
      const input = manualInput(config);
      return { input, result: calculateStrategy(input) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Vérifiez les paramètres." };
    }
  }, [config]);
  const input = computed.input;
  const result = computed.result;
  const active = useMemo(() => input && result ? [input, ...saved] : saved, [input, result, saved]);
  const graph = useMemo(() => {
    const strikes = active.flatMap((comparison) => comparison.legs.map((leg) => leg.strike));
    if (!strikes.length) return { rows: [], min: 0, max: 1, strikes: [] };
    const bounds = Math.max(2, Math.max(...strikes) * .15);
    const breakEvens = active.map((comparison) => calculateStrategy(comparison).breakEven).filter((value): value is number => value !== null);
    const min = Math.max(0, Math.floor(Math.min(...strikes, ...breakEvens) - bounds));
    const max = Math.ceil(Math.max(...strikes, ...breakEvens) + bounds);
    const xValues = new Set([...strikes, ...breakEvens]);
    for (let point = 0; point <= 56; point++) xValues.add(min + (max - min) * point / 56);
    return {
      rows: [...xValues].sort((a, b) => a - b).map((underlying) => ({
        underlying,
        ...Object.fromEntries(active.map((comparison, index) => [`p${index}`, payoffAt(comparison, underlying)])),
      })),
      min,
      max,
      strikes: Array.from(new Set(input?.legs.map((leg) => leg.strike) ?? [])),
    };
  }, [active, input]);
  const scenarioPrice = Math.max(graph.min, Math.min(graph.max, price ?? (Number(config.longStrike) || graph.min)));
  const reset = () => {
    const original = opportunity ? fromInput(opportunity.input) : defaults(demoExample);
    setConfig(original);
    setPrice(opportunity?.price ?? (Number(original.longStrike) || null));
    setSaved([]);
    setShowScenarios(false);
  };
  const displayLoss = result ? -result.maxLoss : null;

  return <>
    <Heading icon={FlaskConical} title="Laboratoire de stratégies" detail="Construisez une position et explorez son profil de gain ou de perte à l’échéance."
      actions={<button type="button" className="wp-button" onClick={reset}><RotateCcw size={15} /> Réinitialiser</button>} />
    <div className="wp-grid">
      <Panel title="Paramètres de la stratégie" detail="Montants en USD · 100 actions par contrat">
        <Notice>Les entrées du laboratoire sont des hypothèses de simulation. {demoExample ? "Les valeurs de départ sont fictives." : opportunity ? "Valeurs préremplies depuis le dossier de recherche sélectionné." : "Saisissez vos propres primes et prix d’exercice."}</Notice>
        {opportunityId && !opportunity && <Notice type="error">Le dossier lié est introuvable. Vous pouvez construire une simulation manuelle.</Notice>}
        <ContractFields config={config} onChange={setConfig} id="lab" />
        {computed.error && <Notice type="error">{computed.error}</Notice>}
        {isVertical(config.strategy) && <p className="wp-micro">Le risque à l’échéance suppose que les deux jambes restent en place. Une assignation anticipée ou le traitement de l’exercice peut modifier l’exposition.</p>}
        <div className="wp-actions">
          <button className="wp-button wp-primary" type="button" disabled={!input || !result || saved.length >= 2} onClick={() => input && setSaved([...saved, input])}>
            <Plus size={16} /> Ajouter à la comparaison
          </button>
          {opportunity && <Link className="wp-button" href={`/portfolio?opportunity=${encodeURIComponent(opportunity.id)}`}>Simuler au portefeuille</Link>}
        </div>
        {saved.map((entry, index) => <div className="wp-split wp-card-row" key={index} style={{ display: "flex" }}>
          <span className="wp-micro">{entry.legs[0].symbol} · {strategyLabels[entry.strategy]} · {money(calculateStrategy(entry).maxLoss)} de risque</span>
          <button type="button" className="wp-button wp-icon" aria-label={`Retirer la comparaison ${index + 1}`} onClick={() => setSaved(saved.filter((_, position) => position !== index))}><X size={14} /></button>
        </div>)}
      </Panel>
      <div className="wp-stack">
        <Panel title="Profil à l’échéance" detail="Gain ou perte de la position selon le prix du sous-jacent.">
          <div className="wp-stat-grid">
            <Stat label="Débit d’entrée" value={money(result?.entryDebit)} />
            <Stat label="Perte maximale" value={money(displayLoss)} tone="wp-bad" />
            <Stat label="Gain maximal" value={result && result.maxProfit === null ? "Illimité" : money(result?.maxProfit)} tone="wp-good" />
            <Stat label="Seuil de rentabilité" value={money(result?.breakEven)} />
            <Stat label="Capital requis" value={money(result?.positionCost)} />
            <Stat label="Rendement / risque" value={result && result.rewardRisk !== null ? number(result.rewardRisk) + "×" : "—"} />
          </div>
          {!graph.rows.length && <Empty title="Profil indisponible" detail="Renseignez un sous-jacent, une échéance et les primes de chaque jambe pour calculer le profil." />}
          {graph.rows.length > 0 && <><div className="wp-chart" role="img" aria-label="Gain ou perte à l’échéance en fonction du cours du sous-jacent">
            <ResponsiveContainer width="100%" height="100%" minWidth={1}>
              <LineChart data={graph.rows} margin={{ left: 8, right: 14, top: 10, bottom: 4 }}>
                <CartesianGrid stroke="#25283a" vertical={false} />
                <XAxis dataKey="underlying" type="number" domain={[graph.min, graph.max]} tickFormatter={(value) => "$" + number(value)} tick={{ fill: "#969ab0", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis width={64} tickFormatter={(value) => "$" + number(value)} tick={{ fill: "#969ab0", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip labelFormatter={(value) => "Sous-jacent · " + money(Number(value))} formatter={(value) => money(Number(value))} contentStyle={{ background: "#171926", border: "1px solid #32354b", borderRadius: 8 }} labelStyle={{ color: "#f3f1fb" }} />
                <ReferenceLine y={0} stroke="#696b83" />
                {graph.strikes.map((strike) => <ReferenceLine key={strike} x={strike} stroke="#697088" strokeDasharray="4 5" />)}
                {result?.breakEven != null && <ReferenceLine x={result.breakEven} stroke="#efbd76" strokeDasharray="3 4" />}
                <ReferenceLine x={scenarioPrice} stroke="#a68afa" strokeOpacity={.6} />
                {active.map((comparison, index) => <Line key={index} type="linear" dataKey={`p${index}`} name={strategyLabels[comparison.strategy]} stroke={colors[index]} strokeWidth={2.5} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div><div className="wp-chart-key">
            {active.map((comparison, index) => <span key={index}><i style={{ background: colors[index] }} />{comparison.legs[0].symbol} · {strategyLabels[comparison.strategy]}</span>)}
            {result?.breakEven != null && <span><i style={{ background: "#efbd76" }} />Seuil</span>}
          </div></>}
        </Panel>
        {input && result && <Panel title="Scénario hypothétique" detail="Faites varier le cours à l’échéance.">
          <Field label="Prix du sous-jacent"><input type="range" min={graph.min} max={graph.max} step=".1" value={scenarioPrice} onChange={(event) => setPrice(Number(event.target.value))} /></Field>
          <div className="wp-stat-grid"><Stat label="Prix hypothétique" value={money(scenarioPrice)} />
            <Stat label="Résultat à l’échéance" value={money(payoffAt(input, scenarioPrice))} tone={payoffAt(input, scenarioPrice) < 0 ? "wp-bad" : "wp-good"} /></div>
          <button type="button" className="wp-button" aria-expanded={showScenarios} onClick={() => setShowScenarios(!showScenarios)}>{showScenarios ? "Masquer" : "Afficher"} les scénarios types</button>
          {showScenarios && <div className="wp-table-wrap"><table className="wp-table"><thead><tr><th>Variation</th><th>Sous-jacent</th><th>Résultat</th></tr></thead><tbody>
            {[-.15, -.05, 0, .05, .15].map((move) => {
              const underlying = input.legs[0].strike * (1 + move);
              const pnl = payoffAt(input, underlying);
              return <tr key={move}><td>{move > 0 && "+"}{number(move * 100)} %</td><td>{money(underlying)}</td><td className={pnl < 0 ? "wp-bad" : "wp-good"}>{money(pnl)}</td></tr>;
            })}
          </tbody></table></div>}
        </Panel>}
      </div>
    </div>
  </>;
}
