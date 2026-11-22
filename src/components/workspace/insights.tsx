"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BarChart3, ChartNoAxesCombined, Send, Sparkles, Trash2 } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { strategyLabels } from "@/lib/quant";
import type { Strategy } from "@/lib/quant";
import type { AppState } from "@/lib/workspace";
import { prefilledOpportunity } from "./strategy-lab";
import { actionForm, Empty, errorMessage, Field, Heading, money, Notice, number, Panel, request, shortDate, SourceLink, Stat, Submit, timestamp } from "./ui";

type Aggregate = { label: string; count: number; value: number };

function Breakdown({ title, rows, labelFormat = (label) => label, countLabel = "Positions" }: {
  title: string; rows: Aggregate[]; labelFormat?: (label: string) => string; countLabel?: string;
}) {
  return <Panel title={title}>
    {!rows.length ? <Empty title="Données insuffisantes" detail="Enregistrez des sorties simulées pour obtenir cette répartition." /> :
      <div className="wp-table-wrap"><table className="wp-table"><thead><tr><th>Catégorie</th><th>{countLabel}</th><th>P&L net</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.label}><td>{labelFormat(row.label)}</td><td data-numeric>{row.count}</td><td data-numeric className={row.value < 0 ? "wp-bad" : "wp-good"}>{money(row.value)}</td></tr>)}
      </tbody></table></div>}
  </Panel>;
}

export function AnalyticsPage({ state }: { state: AppState }) {
  const analytics = state.analytics;
  const stats = analytics.stats;
  const journal = state.portfolio.filter((trade) => trade.notes || trade.thesis || trade.exits.some((exit) => exit.notes));
  const flat = analytics.completedTrades - stats.wins - stats.losses;
  const distribution = [["Gains", stats.wins, "#41d5a1"], ["Pertes", stats.losses, "#f17791"], ["Équilibre", flat, "#a38afb"]] as const;
  return <>
    <Heading icon={BarChart3} title="Analyse de performance" detail="Analysez les sorties enregistrées et retrouvez les notes associées à vos simulations."
      actions={<Link href="/portfolio" className="wp-button">Voir le portefeuille</Link>} />
    {state.mode === "demo" && <Notice>Démo · Les statistiques incluent les exemples fictifs et les positions simulées de cet espace.</Notice>}
    <div className="wp-stat-grid">
      <Stat label="P&L net réalisé" value={money(analytics.realizedPnl)} tone={analytics.realizedPnl < 0 ? "wp-bad" : "wp-good"} />
      <Stat label="Positions clôturées" value={analytics.completedTrades} />
      <Stat label="Taux de gains observé" value={analytics.winRate === null ? "—" : number(analytics.winRate) + " %"}
        hint={analytics.completedTrades > 0 ? `${stats.wins} sur ${analytics.completedTrades} positions clôturées` : "Aucune position clôturée"} />
      <Stat label="Ratio gains / pertes" value={number(stats.profitFactor)} hint={stats.profitFactor === null ? "Aucune perte nette clôturée" : "Gains cumulés / pertes absolues"} />
      <Stat label="Gain moyen" value={money(stats.averageWin)} />
      <Stat label="Perte moyenne" value={money(stats.averageLoss)} />
      <Stat label="Frais totaux" value={money(stats.totalFees)} />
      <Stat label="Durée moyenne" value={stats.averageHoldDays === null ? "—" : number(stats.averageHoldDays) + " j"} />
      <Stat label="Repli maximal réalisé" value={money(stats.maxDrawdown)} hint="Sur les soldes réalisés de fin de journée" />
    </div>
    <div className="wp-grid wp-grid-even">
      <Panel title="P&L réalisé cumulé" detail="Somme des résultats nets des sorties totales et partielles, par date.">
        {analytics.equity.length ? <>
          <div className="wp-chart" role="img" aria-label="Évolution du résultat net réalisé">
            <ResponsiveContainer width="100%" height="100%" minWidth={1}>
              <AreaChart data={analytics.equity} margin={{ left: 10, right: 14, top: 10, bottom: 8 }}>
                <defs><linearGradient id="wp-realized-gradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#a38afb" stopOpacity=".33" /><stop offset="100%" stopColor="#a38afb" stopOpacity=".015" />
                </linearGradient></defs>
                <CartesianGrid stroke="#25283a" vertical={false} />
                <XAxis dataKey="date" tickFormatter={(value) => shortDate(String(value))} tick={{ fill: "#969ab0", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
                <YAxis width={60} tickFormatter={(value) => "$" + number(value)} tick={{ fill: "#969ab0", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip labelFormatter={(value) => shortDate(String(value))} formatter={(value) => money(Number(value))} contentStyle={{ background: "#171926", border: "1px solid #32354b", borderRadius: 8 }} labelStyle={{ color: "#f3f1fb" }} />
                <ReferenceLine y={0} stroke="#696b83" />
                <Area dataKey="value" name="P&L réalisé" type="linear" stroke="#a38afb" fill="url(#wp-realized-gradient)" strokeWidth={2.5} dot={analytics.equity.length <= 3} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <small className="wp-micro">Dernier point · {shortDate(analytics.equity.at(-1)?.date)}</small>
        </> : <Empty title="Aucune sortie enregistrée" detail="Le graphique s’affichera dès qu’une clôture totale ou partielle aura été enregistrée." />}
      </Panel>
      <Panel title="Distribution du P&L" detail="Nombre de positions clôturées par résultat.">
        {analytics.completedTrades > 0 ? <div className="wp-stack">
          {distribution.map(([label, value, color]) => <div key={label} className="wp-stack" style={{ gap: 6 }}>
            <div className="wp-split"><span>{label}</span><span className="wp-micro">{value} / {analytics.completedTrades}</span></div>
            <div style={{ height: 7, borderRadius: 4, background: "var(--wp-border)", overflow: "hidden" }}><div style={{
              height: "100%", width: (100 * value / analytics.completedTrades) + "%", background: color,
            }} /></div>
          </div>)}
        </div> : <Empty title="Aucune position clôturée" detail="La répartition s’appuie sur les positions intégralement clôturées." />}
      </Panel>
    </div>
    <div className="wp-grid wp-grid-even">
      <Breakdown title="Résultats par sous-jacent" rows={analytics.byTicker} />
      <Breakdown title="Résultats par stratégie" rows={analytics.byStrategy} labelFormat={(label) => strategyLabels[label as Strategy] ?? label} />
      <Breakdown title="Résultats par durée de détention" rows={analytics.byHolding} />
      <Breakdown title="Résultats par mois" rows={analytics.byMonth} countLabel="Sorties" />
    </div>
    <div className="wp-grid wp-grid-even">
      <Panel title="Score de recherche et résultat" detail="Suivez les positions clôturées associées à une opportunité classée.">
        {analytics.scoreOutcomes.length ? <div className="wp-table-wrap"><table className="wp-table"><thead><tr><th>Sous-jacent</th><th>Score</th><th>P&L réalisé</th></tr></thead>
          <tbody>{analytics.scoreOutcomes.map((row, index) => <tr key={index}><td>{row.symbol}</td><td>{number(row.score)} / 100</td><td>{money(row.pnl)}</td></tr>)}</tbody>
        </table></div> : <Empty title="Aucune position liée" detail="Créez une simulation à partir d’une opportunité classée pour l’inclure ici après clôture." />}
      </Panel>
      <Panel title="Journal de trading" detail="Revoyez les hypothèses et notes prises à l’ouverture et à la sortie.">
        {journal.length ? journal.slice(0, 10).map((trade) => <details className="wp-card-row" key={trade.id}><summary>{trade.symbol} · {shortDate(trade.entryDate)}</summary>
          {trade.thesis && <p>{trade.thesis}</p>}{trade.notes && <p style={{ whiteSpace: "pre-wrap" }}>{trade.notes}</p>}
          {trade.exits.map((exit) => exit.notes ? <p key={exit.id}>{shortDate(exit.exitDate)} · {exit.notes}</p> : null)}
        </details>) : <Empty title="Le journal est vide" detail="Ajoutez vos motivations et leçons à vos positions simulées." />}
      </Panel>
    </div>
    <Panel title="Test rétrospectif" actions={<ChartNoAxesCombined size={18} color="var(--wp-muted)" />}>
      <Notice>Fonction indisponible. Un test rétrospectif requiert des chaînes d’options historiques horodatées et des hypothèses d’exécution réalistes.</Notice>
    </Panel>
  </>;
}

type Source = { url: string; publisher?: string; title?: string; retrievedAt?: string };
type Message = { role: "user" | "assistant"; content: string; sources?: Source[]; notice?: string };

const suggestions = [
  "Pourquoi cette stratégie est-elle classée première ?",
  "Explique la différence entre gain maximal et rendement attendu.",
  "Pourquoi certains contrats ont-ils été écartés du dernier scan ?",
  "Quels résultats respectent une perte maximale de 50 USD ?",
];

export function AssistantPage({ state, opportunityId }: { state: AppState; opportunityId?: string }) {
  const prefilled = prefilledOpportunity(state, opportunityId);
  const selectable = state.opportunities.slice(0, 24);
  if (prefilled && !selectable.some((item) => item.id === prefilled.id)) selectable.push(prefilled);
  const [selected, setSelected] = useState(prefilled?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [messages.length, pending]);

  const send = async (value: string) => {
    const message = value.trim();
    if (!message || pending) return;
    setPending(true);
    setError("");
    setPrompt("");
    setMessages([...messages, { role: "user", content: message }]);
    try {
      const reply = await request<{ answer: string; sources?: Source[]; error?: string }>("/api/ai/chat", "POST", {
        message,
        opportunityId: selected || undefined,
        history: messages.slice(-6).map(({ role, content }) => ({ role, text: content.slice(0, 2000) })),
      });
      setMessages((previous) => [...previous, { role: "assistant", content: reply.answer, sources: reply.sources, notice: reply.error }]);
    } catch (failure) {
      setMessages(messages);
      setError(errorMessage(failure));
      setPrompt(message);
    } finally {
      setPending(false);
    }
  };

  return <>
    <Heading icon={Sparkles} title="Assistant de recherche IA" detail="Interrogez les scans sauvegardés, les critères de risque et le profil des stratégies."
      actions={<button type="button" className="wp-button" disabled={!messages.length || pending} onClick={() => { setMessages([]); setError(""); }}><Trash2 size={16} /> Effacer la conversation</button>} />
    <div className="wp-grid">
      <Panel title="Contexte de recherche" detail="Choisissez une opportunité pour orienter la réponse.">
        <Field label="Opportunité analysée"><select value={selected} disabled={pending} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Dernier contexte enregistré</option>
          {selectable.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.symbol} · {strategyLabels[opportunity.strategy]}</option>)}
        </select></Field>
        {opportunityId && !prefilled && <Notice type="error">Le dossier lié est introuvable. Vous pouvez interroger le dernier contexte enregistré.</Notice>}
        <p className="wp-micro">Questions suggérées</p>
        {suggestions.map((suggestion) => <button type="button" className="wp-button" key={suggestion} disabled={pending} onClick={() => { setPrompt(suggestion); }}>{suggestion}</button>)}
        <Notice>{state.mode === "demo" ? "Démo · Assistant local fondé sur les exemples fictifs et les calculs du moteur." :
          state.research.configured ? "L’assistant s’appuie sur les recherches enregistrées et les calculs de la plateforme." :
            "Mode local · Les réponses s’appuient sur les dossiers enregistrés et les calculs du moteur. Configurez OpenAI pour activer la synthèse."}</Notice>
      </Panel>
      <Panel title="Conversation" detail="Les réponses sont rédigées en français.">
        <div className="wp-chat-thread" ref={thread} role="log" aria-label="Conversation de recherche">
          {!messages.length && <Empty title="Posez une question de recherche" detail="Essayez une question proposée ou demandez le détail d’une stratégie." />}
          {messages.map((entry, index) => <div className={`wp-chat-message${entry.role === "user" ? " wp-chat-user" : ""}`} key={index}>
            <strong>{entry.role === "user" ? "Vous" : "Assistant"}</strong><p>{entry.content}</p>
            {entry.notice && <Notice>{entry.notice} La réponse ci-dessus provient du contexte local.</Notice>}
            {!!entry.sources?.length && <ul className="wp-sources">{entry.sources.map((source, sourceIndex) => <li key={sourceIndex}>
              <SourceLink url={source.url}>{source.publisher ?? source.title ?? "Source de recherche"}</SourceLink>
              {source.retrievedAt && ` · Consultée le ${timestamp(source.retrievedAt)}`}
            </li>)}</ul>}
          </div>)}
          {pending && <p className="wp-micro" role="status">Préparation de la réponse…</p>}
        </div>
        {error && <Notice type="error">{error}</Notice>}
        <form className="wp-form" onSubmit={actionForm(() => void send(prompt))}>
          <Field label="Votre question"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Que souhaitez-vous analyser ?" rows={3} maxLength={1500} required disabled={pending} /></Field>
          <div className="wp-actions"><Submit pending={pending} disabled={!prompt.trim()}><Send size={15} /> Envoyer</Submit></div>
        </form>
      </Panel>
    </div>
  </>;
}
