"use client";

import Decimal from "decimal.js";
import Link from "next/link";
import { useState } from "react";
import { BarChart3, BriefcaseBusiness, ClipboardPenLine, Plus } from "lucide-react";
import { calculateStrategy, strategyLabels, validateQuote } from "@/lib/quant";
import type { AppState, PaperTrade } from "@/lib/workspace";
import { ContractFields, defaults, fromInput, manualInput, prefilledOpportunity } from "./strategy-lab";
import { actionForm, dayInput, Empty, errorMessage, Field, Heading, money, Notice, Panel, request, shortDate, Stat, Status, Submit, timestamp, useRequestKey } from "./ui";

function transactionTime(date: string) {
  const now = new Date();
  return date === dayInput(now) ? now.toISOString() : date + "T12:00:00.000Z";
}

function EntryForm({ state, close, saved }: { state: AppState; close: () => void; saved: () => Promise<void> }) {
  const opportunity = prefilledOpportunity(state);
  const [config, setConfig] = useState(() => opportunity ? fromInput(opportunity.input) : defaults());
  const [entryDate, setEntryDate] = useState(dayInput());
  const [customDebit, setCustomDebit] = useState("");
  const [notes, setNotes] = useState("");
  const [entryReason, setEntryReason] = useState("");
  const [lesson, setLesson] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRequestKey();

  let automaticDebit: number | null = null;
  try {
    automaticDebit = calculateStrategy(manualInput(config)).entryDebit;
  } catch {
    // The form submits only after the leg terms are validated.
  }

  const submit = async () => {
    setPending(true);
    setError("");
    try {
      const input = manualInput(config);
      const result = calculateStrategy(input);
      const link = opportunity && input.strategy === opportunity.strategy &&
        input.legs.every((leg, index) => leg.id === opportunity.input.legs[index]?.id);
      const journal = [
        entryReason.trim() && "Motif d’entrée · " + entryReason.trim(),
        notes.trim(),
        lesson.trim() && "Leçon / point à surveiller · " + lesson.trim(),
      ].filter(Boolean).join("\n");
      await request("/api/portfolio/trades", "POST", {
        input,
        entryDate: transactionTime(entryDate),
        entryDebit: customDebit.trim() ? Number(customDebit) : result.entryDebit,
        notes: journal || undefined,
        opportunityId: link ? opportunity.id : undefined,
      }, requestKey.get({ config, entryDate, customDebit, journal }));
      requestKey.clear();
      await saved();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return <Panel title="Ouvrir une position simulée" detail="Les primes et exécutions sont saisies manuellement."
    actions={<button type="button" className="wp-button" onClick={close}>Fermer le formulaire</button>}>
    {opportunity && <Notice>Recherche d’origine · {opportunity.symbol} · {strategyLabels[opportunity.strategy]}</Notice>}
    <form className="wp-form" onSubmit={actionForm(() => void submit())}>
      <ContractFields id="paper" config={config} onChange={setConfig} />
      <div className="wp-fields">
        <Field label="Date d’entrée"><input type="date" required value={entryDate} max={dayInput()} onChange={(event) => setEntryDate(event.target.value)} /></Field>
        <Field label="Débit total d’entrée (USD)" hint={automaticDebit === null ? "Renseignez d’abord les contrats." : `Débit des jambes · ${money(automaticDebit)} hors frais.`}>
          <input type="number" min=".01" step=".01" value={customDebit} placeholder={automaticDebit?.toFixed(2) ?? "—"} onChange={(event) => setCustomDebit(event.target.value)} />
        </Field>
        <Field label="Motif d’entrée" wide><textarea maxLength={500} placeholder="Quel signal a motivé cette simulation ?" value={entryReason} onChange={(event) => setEntryReason(event.target.value)} /></Field>
        <Field label="Notes du journal" wide><textarea maxLength={1300} value={notes} placeholder="Thèse, conditions d’invalidation, références…" onChange={(event) => setNotes(event.target.value)} /></Field>
        <Field label="Points à surveiller" wide><textarea maxLength={500} value={lesson} onChange={(event) => setLesson(event.target.value)} /></Field>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      <div className="wp-actions"><Submit pending={pending}><Plus size={16} /> Enregistrer la position</Submit></div>
    </form>
  </Panel>;
}

function ExitForm({ trade, close, saved }: { trade: PaperTrade; close: () => void; saved: () => Promise<void> }) {
  const [quantity, setQuantity] = useState(String(trade.remainingQuantity));
  const [credit, setCredit] = useState("");
  const [fees, setFees] = useState("0");
  const [exitDate, setExitDate] = useState(dayInput());
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRequestKey();

  const submit = async () => {
    setError("");
    setPending(true);
    try {
      await request(`/api/portfolio/trades/${encodeURIComponent(trade.id)}`, "PATCH", {
        quantity: Number(quantity), exitCredit: Number(credit), fees: Number(fees), exitDate: transactionTime(exitDate), notes: notes.trim(),
      }, requestKey.get({ quantity, credit, fees, exitDate, notes }));
      requestKey.clear();
      await saved();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  const exitQuantity = Number(quantity);
  const closedCount = trade.quantity - trade.remainingQuantity;
  const realized = credit.trim() && exitQuantity > 0 && exitQuantity <= trade.remainingQuantity ?
    new Decimal(credit).minus(fees || 0).minus(allocatedEntryCost(trade, closedCount + exitQuantity).minus(allocatedEntryCost(trade, closedCount))).toNumber() : null;
  return <form className="wp-form wp-card-row" onSubmit={actionForm(() => void submit())}>
    <div className="wp-split"><strong>Enregistrer une sortie de {trade.symbol}</strong><button type="button" className="wp-button" onClick={close}>Fermer</button></div>
    <div className="wp-fields">
      <Field label="Contrats à clôturer"><input type="number" min="1" max={trade.remainingQuantity} required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
      <Field label="Crédit total de sortie (USD)" hint="Pour la quantité clôturée, hors frais."><input type="number" min="0" step=".01" required value={credit} onChange={(event) => setCredit(event.target.value)} /></Field>
      <Field label="Frais de clôture (USD)"><input type="number" min="0" step=".01" required value={fees} onChange={(event) => setFees(event.target.value)} /></Field>
      <Field label="Date de sortie"><input type="date" required min={dayInput(new Date(trade.exits.at(-1)?.exitDate ?? trade.entryDate))} max={dayInput()} value={exitDate} onChange={(event) => setExitDate(event.target.value)} /></Field>
      <Field label="Motif, erreurs et leçons de sortie" wide><textarea maxLength={1300} value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
    </div>
    {realized !== null && <p className="wp-micro">P&L net indicatif · <strong className={realized < 0 ? "wp-bad" : "wp-good"}>{money(realized)}</strong></p>}
    {error && <Notice type="error">{error}</Notice>}
    <div className="wp-actions"><Submit pending={pending}>{Number(quantity) === trade.remainingQuantity ? "Confirmer la clôture" : "Confirmer la sortie partielle"}</Submit></div>
  </form>;
}

function allocatedEntryCost(trade: PaperTrade, closedCount: number) {
  return new Decimal(trade.entryDebit).plus(trade.fees).times(closedCount).div(trade.quantity).toDecimalPlaces(2);
}

function remainingEntryCost(trade: PaperTrade) {
  return new Decimal(trade.maxLoss).minus(allocatedEntryCost(trade, trade.quantity - trade.remainingQuantity));
}

function referenceValue(trade: PaperTrade, quotes: AppState["manualQuotes"]) {
  if (trade.status !== "open") return null;
  const legs = trade.input.legs.map((leg) => quotes.find((quote) => quote.id === leg.id && validateQuote(quote, trade.symbol).valid));
  if (legs.some((quote) => !quote)) return null;
  const [long, short] = legs;
  if (!long || (short && Math.abs(Date.parse(long.quoteAt) - Date.parse(short.quoteAt)) > 300_000)) return null;
  const value = new Decimal(long.bid).minus(short?.ask ?? 0).times(trade.remainingQuantity).times(long.multiplier);
  const asOf = short && Date.parse(short.quoteAt) < Date.parse(long.quoteAt) ? short.quoteAt : long.quoteAt;
  return { value: value.toNumber(), pnl: value.minus(remainingEntryCost(trade)).toNumber(), asOf, legs };
}

export function PortfolioPage({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [showForm, setShowForm] = useState(() => Boolean(prefilledOpportunity(state)));
  const [closing, setClosing] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  const [notice, setNotice] = useState("");
  const active = state.portfolio.filter((trade) => trade.status === "open");
  const exposure = active.reduce((acc, trade) => acc.plus(remainingEntryCost(trade)), new Decimal(0));
  const trades = state.portfolio.filter((trade) => filter === "all" || trade.status === filter);
  return <>
    <Heading icon={BriefcaseBusiness} title="Portefeuille papier" detail="Consignez vos exécutions simulées et suivez les résultats réalisés."
      actions={<><Link href="/analytics" className="wp-button"><BarChart3 size={16} /> Performance</Link>
        <button type="button" className="wp-button wp-primary" onClick={() => { setShowForm(true); setNotice(""); }}><Plus size={16} /> Nouvelle position</button></>} />
    <div className="wp-stat-grid">
      <Stat label="Positions ouvertes" value={active.length} />
      <Stat label="Capital encore à risque" value={money(exposure.toNumber())} />
      <Stat label="P&L réalisé" value={money(state.analytics.realizedPnl)} tone={state.analytics.realizedPnl >= 0 ? "wp-good" : "wp-bad"} />
      <Stat label="Positions clôturées" value={state.analytics.completedTrades} />
    </div>
    {notice && <Notice type="success">{notice}</Notice>}
    <div className={showForm ? "wp-grid" : "wp-stack"}>
      {showForm && <EntryForm state={state} close={() => setShowForm(false)} saved={async () => {
        await refresh(); setShowForm(false); setNotice("Position simulée enregistrée.");
      }} />}
      <Panel title="Suivi des positions" detail="Valeur courante et P&L latent disponibles uniquement avec des cotations exploitables.">
        <div className="wp-actions">
          {([["all", "Toutes"], ["open", "Ouvertes"], ["closed", "Clôturées"]] as const).map(([value, label]) =>
            <button type="button" key={value} className="wp-button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        {trades.length > 0 ? trades.map((trade) => {
          const estimate = referenceValue(trade, state.manualQuotes);
          return <div className="wp-card-row" key={trade.id}>
          <div className="wp-split"><strong>{trade.symbol} · {strategyLabels[trade.strategy]}</strong><Status value={trade.status} /></div>
          <p>Entrée le {timestamp(trade.entryDate)} · Échéance le {shortDate(trade.expiration)}<br />Débit {money(trade.entryDebit)} · Frais {money(trade.fees)} · {trade.remainingQuantity} / {trade.quantity} contrat(s)</p>
          <p>Résultat réalisé · <strong className={trade.realizedPnl < 0 ? "wp-bad" : "wp-good"}>{money(trade.realizedPnl)}</strong>
            {trade.status === "open" && <> · Résultat latent {estimate ? money(estimate.pnl) + " (indicatif, frais de sortie exclus)" : "—"}</>}</p>
          {estimate && <p>Valeur de liquidation indicative · {money(estimate.value)} · {timestamp(estimate.asOf)}</p>}
          <details><summary><ClipboardPenLine size={13} /> Journal, contrats et sorties</summary>
            {trade.thesis && <p>Thèse d’origine · {trade.thesis}</p>}
            {trade.notes && <p style={{ whiteSpace: "pre-wrap" }}>{trade.notes}</p>}
            <ul className="wp-sources">{trade.input.legs.map((leg, index) => <li key={leg.id}>{index ? "Vente" : "Achat"} · {leg.id}</li>)}</ul>
            {estimate?.legs.map((quote) => quote && <p key={quote.id}><a href={quote.source.url} target="_blank" rel="noreferrer">{quote.source.publisher}</a> · {timestamp(quote.quoteAt)} · {quote.id}</p>)}
            {trade.exits.map((exit) => <p key={exit.id}>{timestamp(exit.exitDate)} · {exit.quantity} contrat(s) · {money(exit.realizedPnl)} réalisé{exit.notes ? " · " + exit.notes : ""}</p>)}
          </details>
          {trade.status === "open" && closing !== trade.id && <div className="wp-actions"><button type="button" className="wp-button" aria-label={`Enregistrer une sortie de ${trade.symbol}`} onClick={() => { setClosing(trade.id); setNotice(""); }}>Enregistrer une sortie</button></div>}
          {closing === trade.id && trade.status === "open" && <ExitForm trade={trade} close={() => setClosing(null)} saved={async () => {
            await refresh(); setClosing(null); setNotice("Sortie enregistrée. Le P&L réalisé a été mis à jour.");
          }} />}
        </div>; }) : <Empty title="Aucune position à afficher" detail="Les opérations correspondant au filtre apparaîtront ici.">
          {!showForm && <button type="button" className="wp-button" onClick={() => setShowForm(true)}>Ouvrir une position simulée</button>}
        </Empty>}
      </Panel>
    </div>
  </>;
}
