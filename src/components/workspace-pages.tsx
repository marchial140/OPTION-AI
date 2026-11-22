"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { AppState } from "@/lib/workspace";
import { AnalyticsPage, AssistantPage } from "./workspace/insights";
import { PortfolioPage } from "./workspace/portfolio";
import { HistoryPage, Scanner } from "./workspace/scanner";
import { SettingsPage } from "./workspace/settings";
import { StrategyLab } from "./workspace/strategy-lab";
import { WatchlistPage } from "./workspace/watchlist";
import "./workspace-pages.css";

type Props = { section: string; state: AppState; refresh: () => Promise<void> };

function WorkspaceContent({ section, state, refresh }: Props) {
  const params = useSearchParams();
  const opportunityId = params.get("opportunity") ?? undefined;
  switch (section) {
    case "scanner": {
      const symbol = params.get("symbol") ?? undefined;
      const listId = params.get("watchlist") ?? undefined;
      return <Scanner key={JSON.stringify([symbol, listId])} state={state} refresh={refresh} symbol={symbol} listId={listId} />;
    }
    case "strategy-lab": return <StrategyLab key={opportunityId} state={state} opportunityId={opportunityId} />;
    case "assistant": return <AssistantPage key={opportunityId} state={state} opportunityId={opportunityId} />;
    case "watchlist": return <WatchlistPage state={state} refresh={refresh} />;
    case "portfolio": return <PortfolioPage key={opportunityId} state={state} refresh={refresh} opportunityId={opportunityId} />;
    case "analytics": return <AnalyticsPage state={state} />;
    case "history": return <HistoryPage state={state} refresh={refresh} />;
    case "settings": return <SettingsPage state={state} refresh={refresh} />;
    default: return null;
  }
}

export function WorkspacePage(props: Props) {
  return <div className="wp"><Suspense fallback={<div className="wp-card-row" role="status">Chargement des paramètres de cette page…</div>}>
    <WorkspaceContent {...props} />
  </Suspense></div>;
}
