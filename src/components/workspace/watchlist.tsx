"use client";

import Link from "next/link";
import { useState } from "react";
import { ListPlus, Plus, ScanLine, Star, Trash2 } from "lucide-react";
import type { AppState } from "@/lib/workspace";
import { actionForm, dataLabels, directionLabels, Empty, errorMessage, Field, Heading, money, newRequestId, Notice, Panel, request, SourceLink, Status, Submit, timestamp } from "./ui";

const favoritesId = "favoris";
const symbolPattern = /^[A-Z][A-Z0-9.]{0,9}$/;

export function WatchlistPage({ state, refresh }: { state: AppState; refresh: () => Promise<void> }) {
  const [listId, setListId] = useState(state.watchlists[0]?.id ?? "");
  const [symbol, setSymbol] = useState("");
  const [search, setSearch] = useState("");
  const [listName, setListName] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);

  const selected = state.watchlists.find((list) => list.id === listId) ?? state.watchlists[0];
  const favorites = state.watchlists.find((list) => list.id === favoritesId);
  const items = selected?.items.filter((item) => item.includes(search.trim().toUpperCase())) ?? [];
  const researchBySymbol = new Map(
    [...state.scans].reverse().flatMap((scan) => scan.candidates).map((candidate) => [candidate.symbol, candidate]),
  );
  for (const candidate of state.candidates) researchBySymbol.set(candidate.symbol, candidate);

  const update = async (operation: () => Promise<unknown>, success: string) => {
    setError("");
    setNotice("");
    setPending(true);
    try {
      await operation();
      await refresh();
      setNotice(success);
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  };

  const addItem = (watchlistId: string, value: string) => request("/api/watchlists/items", "POST", { watchlistId, symbol: value });
  const removeItem = (watchlistId: string, value: string) =>
    request(`/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(value)}`, "DELETE");

  const add = async () => {
    if (!selected) return;
    const value = symbol.trim().toUpperCase();
    if (!symbolPattern.test(value)) {
      setError("Utilisez un symbole boursier de 1 à 10 caractères.");
      setNotice("");
      return;
    }
    if (selected.items.includes(value)) {
      setError("Ce symbole figure déjà dans la liste.");
      setNotice("");
      return;
    }
    const saved = await update(() => addItem(selected.id, value), value + " ajouté.");
    if (saved) setSymbol("");
  };

  const remove = (value: string) => {
    if (selected) void update(() => removeItem(selected.id, value), value + " retiré.");
  };

  const toggleFavorite = (value: string) => {
    const favored = Boolean(favorites?.items.includes(value));
    const operation = favored ? () => removeItem(favoritesId, value) : () => addItem(favoritesId, value);
    void update(operation, favored ? value + " retiré des favoris." : value + " ajouté aux favoris.");
  };

  const create = async () => {
    const name = listName.trim();
    if (!name) return;
    if (name.toLocaleLowerCase("fr") === "favoris") {
      setError("Le nom Favoris est réservé à la liste alimentée par les étoiles.");
      setNotice("");
      return;
    }
    if (state.watchlists.some((list) => list.name.toLocaleLowerCase("fr") === name.toLocaleLowerCase("fr"))) {
      setError("Une liste porte déjà ce nom.");
      setNotice("");
      return;
    }
    const list = { id: newRequestId(), name, items: [] };
    if (await update(() => request("/api/watchlists/list", "POST", list), "Liste créée.")) {
      setListId(list.id);
      setListName("");
      setSearch("");
    }
  };

  const removeList = async () => {
    if (!selected || state.watchlists.length < 2) return;
    if (await update(() => request(`/api/watchlists/${encodeURIComponent(selected.id)}`, "DELETE"), "Liste supprimée.")) {
      setListId("");
      setConfirm(false);
      setSearch("");
    }
  };

  return <>
    <Heading icon={ListPlus} title="Listes de suivi" detail="Organisez vos sous-jacents et accédez à leurs dernières recherches."
      actions={selected && selected.items.length > 0 && <Link className="wp-button" href={`/scanner?watchlist=${encodeURIComponent(selected.id)}`}><ScanLine size={16} /> Scanner la liste</Link>} />
    {notice && <Notice type="success">{notice}</Notice>}
    {error && <Notice type="error">{error}</Notice>}
    <div className="wp-grid">
      <Panel title="Mes listes" detail="Regroupez vos symboles par secteur ou sujet.">
        {state.watchlists.map((list) => <button className="wp-button wp-split" type="button" key={list.id} aria-pressed={list.id === selected?.id} onClick={() => {
          setListId(list.id); setConfirm(false); setSearch("");
        }}>
          {list.name}<span className="wp-micro">{list.items.length}</span>
        </button>)}
        <form className="wp-inline-input" onSubmit={actionForm(() => void create())}>
          <Field label="Nouvelle liste"><input required value={listName} maxLength={48} onChange={(event) => setListName(event.target.value)} placeholder="Ex. Avis de résultats" /></Field>
          <Submit pending={pending}><Plus size={15} /> Créer</Submit>
        </form>
        {state.watchlists.length > 1 && selected && <div className="wp-actions">
          {confirm ? <>
            <button type="button" className="wp-button wp-danger" disabled={pending} onClick={() => void removeList()}>Confirmer la suppression</button>
            <button type="button" className="wp-button" onClick={() => setConfirm(false)}>Conserver</button>
          </> : <button type="button" className="wp-button wp-danger" onClick={() => setConfirm(true)}><Trash2 size={15} /> Supprimer la liste</button>}
        </div>}
      </Panel>
      <Panel title={selected?.name ?? "Symboles suivis"} detail={items.length + " symbole(s) affiché(s)"}>
        {selected && <form className="wp-inline-input" onSubmit={actionForm(() => void add())}>
          <Field label="Ajouter un symbole"><input value={symbol} placeholder="Ex. AAPL" maxLength={10} required onChange={(event) => setSymbol(event.target.value.toUpperCase())} /></Field>
          <Submit pending={pending}><Plus size={15} /> Ajouter</Submit>
        </form>}
        <Field label="Rechercher un symbole"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filtrer la liste" /></Field>
        {items.length ? <div className="wp-table-wrap wp-watch-table" role="region" aria-label="Symboles suivis" tabIndex={0}><table className="wp-table"><thead><tr><th>Symbole</th><th>Cours du dernier scan</th><th>Dernière recherche</th><th>Actions</th></tr></thead><tbody>
          {items.map((item) => {
            const candidate = researchBySymbol.get(item);
            const latest = state.scans.find((scan) => scan.tickers.includes(item));
            const quoteSource = candidate?.sources.find((source) => source.quoteAt);
            const opportunity = state.opportunities.find((entry) => entry.symbol === item);
            const favored = Boolean(favorites?.items.includes(item));
            return <tr key={item}>
              <td><strong>{item}</strong>{candidate && <small>{candidate.name}</small>}</td>
              <td data-numeric>{money(candidate?.price)}
                {candidate?.price != null && <small><Status value={candidate.status} dictionary={dataLabels} /></small>}
                {candidate?.price != null && quoteSource?.quoteAt && <small>
                  <SourceLink url={quoteSource.url}>{quoteSource.publisher}</SourceLink> · {timestamp(quoteSource.quoteAt)}
                </small>}
              </td>
              <td>{candidate ? directionLabels[candidate.direction] : "—"}<small>{timestamp(candidate?.updatedAt)}</small>{latest && <small><Status value={latest.status} /></small>}</td>
              <td><div className="wp-actions">
                <button type="button" className="wp-button wp-icon" disabled={pending} aria-label={(favored ? "Retirer des favoris " : "Ajouter aux favoris ") + item} aria-pressed={favored} onClick={() => toggleFavorite(item)}><Star size={15} fill={favored ? "currentColor" : "none"} /></button>
                <Link className="wp-button wp-icon" href={`/scanner?symbol=${encodeURIComponent(item)}`} aria-label={`Scanner ${item}`}><ScanLine size={15} /></Link>
                <button type="button" className="wp-button wp-icon wp-danger" disabled={pending} aria-label={`Retirer ${item}`} onClick={() => remove(item)}><Trash2 size={15} /></button>
              </div>{opportunity && <small><Link href={`/opportunities/${encodeURIComponent(opportunity.id)}`}>Stratégie · {item}</Link></small>}</td>
            </tr>;
          })}
        </tbody></table></div> : <Empty title="Aucun symbole affiché" detail={search ? "Modifiez le filtre pour voir d’autres symboles." : "Ajoutez un symbole pour commencer à suivre son activité."} />}
        {items.filter((item) => researchBySymbol.has(item)).slice(0, 5).map((item) => {
          const candidate = researchBySymbol.get(item)!;
          return <details className="wp-card-row" key={item}><summary>Recherche · <strong>{item}</strong></summary><p>{candidate.thesis}</p>
            {candidate.sources.map((source, index) => <p key={index}><SourceLink url={source.url}>{source.publisher}</SourceLink>
              {source.quoteAt && ` · Coté le ${timestamp(source.quoteAt)}`} · Consulté le {timestamp(source.retrievedAt)}</p>)}
          </details>;
        })}
      </Panel>
    </div>
  </>;
}
