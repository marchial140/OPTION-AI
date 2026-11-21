"use client";

import {
  Activity, Bell, BookOpen, ChartNoAxesCombined, ChevronDown, ChevronRight, CircleHelp, Database,
  FlaskConical, Gauge, History, LayoutDashboard, ListChecks, LogOut, Menu, Radar, Settings2,
  Sparkles, Wallet, X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AppState } from "@/lib/workspace";

const Overview = dynamic(() => import("./overview").then((screen) => screen.Overview), { loading: SnapshotLoading });
const Opportunities = dynamic(() => import("./opportunities").then((screen) => screen.Opportunities), { loading: SnapshotLoading });
const WorkspacePage = dynamic(() => import("./workspace-pages").then((screen) => screen.WorkspacePage), { loading: SnapshotLoading });

const groups = [
  { label: "RECHERCHE", routes: [
    { slug: "dashboard", label: "Tableau de bord", href: "/", icon: LayoutDashboard, shortcut: "1" },
    { slug: "scanner", label: "Scanner de marché", href: "/scanner", icon: Radar, shortcut: "2" },
    { slug: "opportunities", label: "Opportunités", href: "/opportunities", icon: ChartNoAxesCombined, shortcut: "3" },
    { slug: "strategy-lab", label: "Laboratoire", href: "/strategy-lab", icon: FlaskConical, shortcut: "4" },
    { slug: "assistant", label: "Assistant IA", href: "/assistant", icon: Sparkles, shortcut: "5" },
  ] },
  { label: "SUIVI", routes: [
    { slug: "watchlist", label: "Listes de suivi", href: "/watchlist", icon: ListChecks, shortcut: "6" },
    { slug: "portfolio", label: "Portefeuille papier", href: "/portfolio", icon: Wallet, shortcut: "7" },
    { slug: "analytics", label: "Performances", href: "/analytics", icon: Gauge, shortcut: "8" },
    { slug: "history", label: "Historique", href: "/history", icon: History, shortcut: "9" },
  ] },
  { label: "PRÉFÉRENCES", routes: [
    { slug: "settings", label: "Paramètres", href: "/settings", icon: Settings2, shortcut: "0" },
  ] },
];

const routes = groups.flatMap((group) => group.routes);

function Brand() {
  return <Link href="/" className="terminal-brand" aria-label="Options AI Pro, accueil">
    <span className="terminal-brand-symbol"><Activity aria-hidden="true" size={23} strokeWidth={2.4} /></span>
    <span className="terminal-brand-wordmark">OPTIONS<span> AI</span> <small>PRO</small></span>
  </Link>;
}

export default function Terminal({ section = "dashboard", detail }: { section?: string; detail?: string }) {
  if (section === "login") return <LoginScreen />;
  return <WorkspaceShell section={section} detail={detail} />;
}

function WorkspaceShell({ section, detail }: { section: string; detail?: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [popover, setPopover] = useState<"notifications" | "account" | "shortcuts" | null>(null);
  const router = useRouter();
  const route = routes.find((entry) => entry.slug === section) ?? routes[0];

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        throw new Error("Le terminal ne peut pas récupérer vos données.");
      }
      setState(await res.json() as AppState);
      setSnapshotError("");
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : "La connexion au terminal a échoué.");
    }
  }, [router]);

  useEffect(() => {
    const activation = window.setTimeout(() => void refresh(), 0);
    const marketClock = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    return () => {
      window.clearTimeout(activation);
      window.clearInterval(marketClock);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        setPopover(null);
      }
      const target = event.target;
      if (!event.altKey || event.ctrlKey || event.metaKey ||
        (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))) return;
      const shortcut = routes.find((entry) => entry.shortcut === event.key);
      if (!shortcut) return;
      event.preventDefault();
      setMobileOpen(false);
      setPopover(null);
      router.push(shortcut.href);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  const togglePopover = (next: typeof popover) => setPopover((value) => value === next ? null : next);
  const lastCompleted = state?.scans.find((scan) => scan.status === "completed" && scan.completedAt);
  const unread = state?.notifications.some((notification) => !notification.readAt) ?? false;

  async function markRead() {
    try {
      const response = await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("notifications");
      await refresh();
    } catch {
      setSnapshotError("Les notifications n’ont pas pu être marquées comme lues.");
    }
  }

  async function signout() {
    try {
      const response = await fetch("/api/auth/signout", { method: "POST" });
      if (!response.ok) throw new Error("signout");
      router.replace("/login");
    } catch {
      setSnapshotError("La déconnexion a échoué.");
    }
  }

  return <div className="terminal-shell" data-theme={state?.settings.theme}>
    <a className="terminal-skip" href="#terminal-content">Aller au contenu</a>
    {mobileOpen && <button className="terminal-overlay" onClick={() => setMobileOpen(false)} aria-label="Fermer le menu" />}
    <aside className={`terminal-sidebar${mobileOpen ? " mobile-open" : ""}`} aria-label="Navigation principale">
      <div className="terminal-sidebar-brand">
        <Brand />
        <button className="icon-button terminal-sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Fermer le menu"><X size={20} /></button>
      </div>
      <nav className="terminal-nav">
        {groups.map((group) => <div className="terminal-nav-group" key={group.label}>
          <span className="terminal-nav-heading">{group.label}</span>
          {group.routes.map(({ slug, href, icon: Icon, label }) => <Link
            key={slug} href={href} aria-current={route.slug === slug ? "page" : undefined}
            className={`terminal-nav-link${route.slug === slug ? " active" : ""}`}
            onClick={() => { setMobileOpen(false); setPopover(null); }}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
            <span>{label}</span>
            {route.slug === slug && <span className="terminal-nav-indicator" aria-hidden="true" />}
          </Link>)}
        </div>)}
      </nav>
      <div className="terminal-sidebar-footer">
        <button className="terminal-nav-link terminal-shortcut-button" onClick={() => togglePopover("shortcuts")} aria-expanded={popover === "shortcuts"}><CircleHelp size={17} /> <span>Raccourcis clavier</span><kbd>Alt</kbd></button>
        <div className="terminal-sidebar-status">
          <span className="terminal-status-dot" data-active={state?.research.configured || state?.mode === "demo"} />
          <div><strong>{state?.mode === "demo" ? "Espace de démonstration" : "Espace de recherche"}</strong><span>{state?.mode === "demo" ? "Données fictives" : state?.research.configured ? "Recherche web configurée" : "Connexion OpenAI requise"}</span></div>
        </div>
      </div>
    </aside>
    <div className="terminal-frame">
      <header className="terminal-topbar">
        <div className="terminal-breadcrumb">
          <button className="icon-button terminal-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Ouvrir le menu" aria-expanded={mobileOpen}><Menu size={21} /></button>
          <span className="terminal-breadcrumb-root">Espace de travail</span>
          <ChevronRight aria-hidden="true" size={13} className="terminal-breadcrumb-separator" />
          <strong>{route.label}</strong>
        </div>
        <div className="terminal-topbar-right">
          {state?.mode === "demo" && <span className="terminal-header-demo"><FlaskConical aria-hidden="true" size={13} /><span>DEMO — DONNÉES FICTIVES</span></span>}
          {state?.market && <div className="terminal-session" title={state.market.optionsOpen ? "Séance régulière des options" : "Pas de séance régulière des options"}>
            <span className="terminal-status-dot" data-active={state.market.optionsOpen} />
            <div><strong>{state.market.label}</strong><span>{state.market.time} · New York</span></div>
          </div>}
          {lastCompleted?.completedAt && <span className="terminal-last-scan" title={new Date(lastCompleted.completedAt).toLocaleString("fr-CA")}>Scan {relativeDate(lastCompleted.completedAt)}</span>}
          <div className="terminal-topbar-separator" />
          <button className="icon-button terminal-bell" onClick={() => togglePopover("notifications")} aria-expanded={popover === "notifications"} aria-label="Notifications"><Bell size={18} />{unread && <i />}</button>
          <button className="terminal-account" onClick={() => togglePopover("account")} aria-label="Menu du compte" aria-expanded={popover === "account"}>
            <span>{state?.user.email?.slice(0, 2).toUpperCase() || "OA"}</span><ChevronDown aria-hidden="true" size={13} />
          </button>
        </div>
        {popover === "notifications" && <div className="terminal-popover"><strong>Notifications</strong>{state?.notifications.length ? <ul>{state.notifications.slice(0, 6).map((notification) => <li key={notification.id} data-unread={!notification.readAt}>{notification.message}</li>)}</ul> : <p>Aucune notification pour le moment.</p>}
          {unread && <button className="button button-secondary" onClick={() => void markRead()}>Marquer comme lues</button>}
        </div>}
        {popover === "account" && <div className="terminal-popover terminal-account-popover">
          <strong>{state?.user.email || "Compte de démonstration"}</strong>
          <Link href="/settings" onClick={() => setPopover(null)}><Settings2 size={16} /> Paramètres du compte</Link>
          {state?.market && <p><span className="terminal-status-dot" data-active={state.market.optionsOpen} /> {state.market.label} · {state.market.time} à New York</p>}
          <Link href="/settings#data-sources" onClick={() => setPopover(null)}><Database size={16} /> {state?.research.configured ? "Recherche OpenAI configurée" : "État des sources"}</Link>
          {state?.mode === "live" && <button onClick={() => void signout()}><LogOut size={16} /> Se déconnecter</button>}
        </div>}
      </header>
      <main id="terminal-content" className="terminal-content">
        {snapshotError && <div className="terminal-error" role="alert"><span>{snapshotError}</span><button className="button button-secondary" onClick={() => void refresh()}>Réessayer</button></div>}
        {!state && !snapshotError && <SnapshotLoading />}
        {state && route.slug === "dashboard" && <Overview state={state} />}
        {state && route.slug === "opportunities" && <Opportunities key={detail ?? "list"} state={state} detail={detail} refresh={refresh} />}
        {state && !["dashboard", "opportunities"].includes(route.slug) && <WorkspacePage section={route.slug} state={state} refresh={refresh} />}
      </main>
    </div>
    {popover === "shortcuts" && <div className="terminal-modal-backdrop" onClick={() => setPopover(null)}>
      <section className="terminal-modal terminal-shortcuts" role="dialog" aria-modal="true" aria-labelledby="terminal-shortcut-title" onClick={(event) => event.stopPropagation()}>
        <header><div><BookOpen size={19} /><h2 id="terminal-shortcut-title">Raccourcis clavier</h2></div><button className="icon-button" aria-label="Fermer" onClick={() => setPopover(null)} autoFocus><X size={19} /></button></header>
        <ul>{routes.map(({ label, shortcut }) => <li key={shortcut}>{label}<span><kbd>Alt</kbd> <kbd>{shortcut}</kbd></span></li>)}</ul>
      </section>
    </div>}
  </div>;
}

function SnapshotLoading() {
  return <div className="terminal-skeleton" aria-label="Chargement de l’espace de travail" role="status">
    <div className="terminal-skeleton-hero" />
    <div className="terminal-skeleton-row"><span /><span /><span /><span /></div>
    <div className="terminal-skeleton-panels"><span /><span /></div>
  </div>;
}

export function LoginScreen() {
  const [action, setAction] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; problem: boolean } | null>(null);
  const router = useRouter();
  const signup = action === "signup";

  async function authenticate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const values = event ? new FormData(event.currentTarget) : null;
    setMessage(null);
    setBusy(true);
    try {
      const result = await fetch(values ? "/api/auth" : "/api/auth/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values ? { action, email: values.get("email"), password: values.get("password") } : {}),
      });
      const payload = await result.json() as { error?: string | { message?: string }; message?: string; pendingConfirmation?: boolean };
      if (!result.ok) throw new Error(typeof payload.error === "string" ? payload.error : payload.error?.message ?? payload.message ?? "La connexion a échoué.");
      if (payload.pendingConfirmation) {
        setMessage({ text: "Consultez votre boîte de réception pour confirmer votre adresse.", problem: false });
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "La connexion a échoué.", problem: true });
    } finally {
      setBusy(false);
    }
  }

  return <main className="terminal-login">
    <section className="panel terminal-login-card" aria-labelledby="terminal-login-heading">
      <Brand />
      <div><h1 id="terminal-login-heading">{signup ? "Créer votre compte" : "Ouvrir votre terminal"}</h1><p>Accédez à vos recherches, listes de suivi et positions papier.</p></div>
      <form onSubmit={(event) => void authenticate(event)}>
        <label className="field">Courriel<input name="email" type="email" autoComplete="email" placeholder="nom@exemple.com" required /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : undefined} required /></label>
        <button type="submit" className="button button-primary" disabled={busy}>{busy ? "Connexion en cours…" : signup ? "Créer un compte" : "Se connecter"}</button>
      </form>
      {message && <p role={message.problem ? "alert" : "status"} className={message.problem ? "text-negative" : "text-positive"}>{message.text}</p>}
      <button className="terminal-login-switch" onClick={() => { setAction(signup ? "login" : "signup"); setMessage(null); }} disabled={busy}>{signup ? "J’ai déjà un compte" : "Créer un compte"}</button>
      <div className="terminal-login-demo">
        <button className="button button-secondary" onClick={() => void authenticate()} disabled={busy}><FlaskConical size={17} /> Ouvrir la démonstration</button>
        <small>DEMO — DONNÉES FICTIVES</small>
      </div>
    </section>
  </main>;
}

function relativeDate(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  return days > 0 ? `il y a ${days} j` : "aujourd’hui";
}
