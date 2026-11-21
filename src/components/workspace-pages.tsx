"use client";

import type { AppState } from "@/lib/workspace";
import { AnalyticsPage, AssistantPage } from "./workspace/insights";
import { PortfolioPage } from "./workspace/portfolio";
import { HistoryPage, Scanner } from "./workspace/scanner";
import { SettingsPage } from "./workspace/settings";
import { StrategyLab } from "./workspace/strategy-lab";
import { WatchlistPage } from "./workspace/watchlist";
import "./workspace-pages.css";

export function WorkspacePage({ section, state, refresh }: { section: string; state: AppState; refresh: () => Promise<void> }) {
  let page;
  switch (section) {
    case "scanner": page = <Scanner state={state} refresh={refresh} />; break;
    case "strategy-lab": page = <StrategyLab state={state} />; break;
    case "assistant": page = <AssistantPage state={state} />; break;
    case "watchlist": page = <WatchlistPage state={state} refresh={refresh} />; break;
    case "portfolio": page = <PortfolioPage state={state} refresh={refresh} />; break;
    case "analytics": page = <AnalyticsPage state={state} />; break;
    case "history": page = <HistoryPage state={state} refresh={refresh} />; break;
    case "settings": page = <SettingsPage state={state} refresh={refresh} />; break;
    default: return null;
  }
  return <div className="wp">{page}</div>;
}
