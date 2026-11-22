"use client";

import {
  Activity, Bell, BookOpen, ChartNoAxesCombined, ChevronDown, ChevronRight, CircleHelp, Database,
  FlaskConical, Gauge, History, LayoutDashboard, ListChecks, LogOut, Menu, Radar, Settings2,
  Sparkles, Wallet, X,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
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

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return <Link href="/" className="terminal-brand" aria-label="Options AI Pro, accueil" onNavigate={onNavigate}>
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
  const [headerAction, setHeaderAction] = useState<"notifications" | "account" | null>(null);
  const [headerError, setHeaderError] = useState("");
  const snapshotRequest = useRef<AbortController | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuClose = useRef<HTMLButtonElement>(null);
  const shortcutsTrigger = useRef<HTMLButtonElement>(null);
  const notificationsTrigger = useRef<HTMLButtonElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const content = useRef<HTMLElement>(null);
  const router = useRouter();
  const route = routes.find((entry) => entry.slug === section) ?? routes[0];

  const refresh = useCallback(async () => {
    snapshotRequest.current?.abort();
    const controller = new AbortController();
    snapshotRequest.current = controller;
    try {
      const res = await fetch("/api/state", { cache: "no-store", signal: controller.signal });
      if (!res.ok) {
        if (res.status === 401) {
          setState(null);
          router.replace("/login");
          return;
        }
        throw new Error(await errorMessage(res, "Le terminal ne peut pas récupérer vos données."));
      }
      const snapshot = await res.json() as AppState;
      if (!controller.signal.aborted) {
        setState(snapshot);
        setSnapshotError("");
      }
    } catch (error) {
      if (!controller.signal.aborted) setSnapshotError(error instanceof Error ? error.message : "La connexion au terminal a échoué.");
    } finally {
      if (snapshotRequest.current === controller) snapshotRequest.current = null;
    }
  }, [router]);

  useEffect(() => {
    const activation = window.setTimeout(() => void refresh(), 0);
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const marketClock = window.setInterval(refreshVisible, 60_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearTimeout(activation);
      window.clearInterval(marketClock);
      document.removeEventListener("visibilitychange", refreshVisible);
      snapshotRequest.current?.abort();
    };
  }, [refresh]);

  const closeMenu = useCallback(() => {
    setMobileOpen(false);
    requestAnimationFrame(() => menuTrigger.current?.focus());
  }, []);

  function closeShortcuts() {
    setPopover(null);
    requestAnimationFrame(() => shortcutsTrigger.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!mobileOpen) return;
    const focus = window.requestAnimationFrame(() => menuClose.current?.focus({ preventScroll: true }));
    const mobile = window.matchMedia("(max-width: 760px)");
    const closeOnDesktop = (event: MediaQueryListEvent) => { if (!event.matches) setMobileOpen(false); };
    mobile.addEventListener("change", closeOnDesktop);
    return () => {
      window.cancelAnimationFrame(focus);
      mobile.removeEventListener("change", closeOnDesktop);
    };
  }, [mobileOpen]);

  useEffect(() => {
    if (popover !== "notifications" && popover !== "account") return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !header.current?.contains(event.target)) setPopover(null);
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [popover]);

  useEffect(() => {
    const main = content.current;
    if (!main || section !== "settings" || window.location.hash !== "#data-sources") return;
    function revealSources() {
      if (window.location.hash !== "#data-sources") return true;
      const sources = document.getElementById("data-sources");
      if (!sources) return false;
      sources.scrollIntoView({ block: "start" });
      return true;
    }
    if (revealSources()) return;
    // The lazy Settings page can mount after the router attempts to scroll.
    const observer = new MutationObserver(() => {
      if (revealSources()) observer.disconnect();
    });
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [section]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (mobileOpen && popover !== "shortcuts") closeMenu();
        if (popover === "notifications") notificationsTrigger.current?.focus();
        if (popover === "account") accountTrigger.current?.focus();
        if (popover !== "shortcuts") setPopover(null);
      }
      const target = event.target;
      if (popover === "shortcuts" || !event.altKey || event.ctrlKey || event.metaKey ||
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
  }, [closeMenu, mobileOpen, popover, router]);

  function togglePopover(next: typeof popover) {
    setHeaderError("");
    setPopover((value) => value === next ? null : next);
  }
  const lastCompleted = state?.scans.find((scan) => scan.status === "completed" && scan.completedAt);
  const unread = state?.notifications.some((notification) => !notification.readAt) ?? false;

  async function markRead() {
    setHeaderAction("notifications");
    setHeaderError("");
    try {
      const response = await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error(await errorMessage(response, "Les notifications n’ont pas pu être marquées comme lues."));
      await refresh();
    } catch (error) {
      setHeaderError(error instanceof Error ? error.message : "Les notifications n’ont pas pu être marquées comme lues.");
    } finally {
      setHeaderAction(null);
    }
  }

  async function signout() {
    setHeaderAction("account");
    setHeaderError("");
    try {
      const response = await fetch("/api/auth/signout", { method: "POST" });
      if (!response.ok) throw new Error(await errorMessage(response, "La déconnexion a échoué."));
      snapshotRequest.current?.abort();
      setState(null);
      router.replace("/login");
    } catch (error) {
      setHeaderError(error instanceof Error ? error.message : "La déconnexion a échoué.");
    } finally {
      setHeaderAction(null);
    }
  }

  return <div className="terminal-shell" data-theme={state?.settings.theme}>
    <a className="terminal-skip" href="#terminal-content">Aller au contenu</a>
    {mobileOpen && <div className="terminal-overlay" aria-hidden="true" onClick={closeMenu} />}
    <aside className={`terminal-sidebar${mobileOpen ? " mobile-open" : ""}`} id="terminal-navigation" aria-label="Navigation principale">
      <div className="terminal-sidebar-brand">
        <Brand onNavigate={() => { setMobileOpen(false); setPopover(null); }} />
        <button ref={menuClose} className="icon-button terminal-sidebar-close" onClick={closeMenu} aria-label="Fermer le menu"><X size={20} /></button>
      </div>
      <nav className="terminal-nav">
        {groups.map((group) => <div className="terminal-nav-group" key={group.label}>
          <span className="terminal-nav-heading">{group.label}</span>
          {group.routes.map(({ slug, href, icon: Icon, label }) => <Link
            key={slug} href={href} aria-current={route.slug === slug ? "page" : undefined}
            className={`terminal-nav-link${route.slug === slug ? " active" : ""}`}
            onNavigate={() => { setMobileOpen(false); setPopover(null); }}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
            <span>{label}</span>
            {route.slug === slug && <span className="terminal-nav-indicator" aria-hidden="true" />}
          </Link>)}
        </div>)}
      </nav>
      <div className="terminal-sidebar-footer">
        <button ref={shortcutsTrigger} className="terminal-nav-link terminal-shortcut-button" onClick={() => togglePopover("shortcuts")} aria-expanded={popover === "shortcuts"} aria-haspopup="dialog"><CircleHelp size={17} /> <span>Raccourcis clavier</span><kbd>Alt</kbd></button>
        <div className="terminal-sidebar-status">
          <span className="terminal-status-dot" data-active={state?.research.configured || state?.mode === "demo"} />
          <div><strong>{state?.mode === "demo" ? "Espace de démonstration" : "Espace de recherche"}</strong><span>{state?.mode === "demo" ? "Données fictives" : state?.research.configured ? "Recherche web configurée" : "Connexion OpenAI requise"}</span></div>
        </div>
      </div>
    </aside>
    <div className="terminal-frame" inert={mobileOpen}>
      <header className="terminal-topbar" ref={header}>
        <div className="terminal-breadcrumb">
          <button ref={menuTrigger} className="icon-button terminal-mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Ouvrir le menu" aria-expanded={mobileOpen} aria-controls="terminal-navigation"><Menu size={21} /></button>
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
          {lastCompleted?.completedAt && <span className="terminal-last-scan" title={new Date(lastCompleted.completedAt).toLocaleString("fr-CA", { timeZone: "America/New_York", timeZoneName: "short" })}>Scan {relativeDate(lastCompleted.completedAt)}</span>}
          <div className="terminal-topbar-separator" />
          <button ref={notificationsTrigger} className="icon-button terminal-bell" onClick={() => togglePopover("notifications")} aria-controls={popover === "notifications" ? "terminal-notifications" : undefined} aria-expanded={popover === "notifications"} aria-label="Notifications"><Bell size={18} />{unread && <i />}</button>
          <button ref={accountTrigger} className="terminal-account" onClick={() => togglePopover("account")} aria-label="Menu du compte" aria-controls={popover === "account" ? "terminal-account-menu" : undefined} aria-expanded={popover === "account"}>
            <span>{state?.user.email?.slice(0, 2).toUpperCase() || "OA"}</span><ChevronDown aria-hidden="true" size={13} />
          </button>
        </div>
        {popover === "notifications" && <div className="terminal-popover" id="terminal-notifications"><strong>Notifications</strong>{state?.notifications.length ? <ul>{state.notifications.map((notification) => <li key={notification.id} data-unread={!notification.readAt}>{notification.message}</li>)}</ul> : <p>Aucune notification pour le moment.</p>}
          {unread && <button className="button button-secondary" onClick={() => void markRead()} disabled={headerAction === "notifications"}>Marquer comme lues</button>}
          {headerError && <p className="text-negative" role="alert">{headerError}</p>}
        </div>}
        {popover === "account" && <div className="terminal-popover terminal-account-popover" id="terminal-account-menu">
          <strong>{state?.user.email || "Compte de démonstration"}</strong>
          <Link href="/settings" onClick={() => setPopover(null)}><Settings2 size={16} /> Paramètres du compte</Link>
          {state?.market && <p><span className="terminal-status-dot" data-active={state.market.optionsOpen} /> {state.market.label} · {state.market.time} à New York</p>}
          <Link href="/settings#data-sources" onClick={() => setPopover(null)}><Database size={16} /> {state?.research.configured ? "Recherche OpenAI configurée" : "État des sources"}</Link>
          {state?.mode === "live" && <button onClick={() => void signout()} disabled={headerAction === "account"}><LogOut size={16} /> Se déconnecter</button>}
          {state?.mode === "demo" && <Link href="/login" onClick={() => setPopover(null)}><LogOut size={16} /> Ouvrir la connexion</Link>}
          {headerError && <p className="text-negative" role="alert">{headerError}</p>}
        </div>}
      </header>
      <main ref={content} id="terminal-content" className="terminal-content">
        {snapshotError && <div className="terminal-error" role="alert"><span>{snapshotError}</span><button className="button button-secondary" onClick={() => void refresh()}>Réessayer</button></div>}
        {!state && !snapshotError && <SnapshotLoading />}
        {state && route.slug === "dashboard" && <Overview state={state} />}
        {state && route.slug === "opportunities" && <Opportunities key={detail ?? "list"} state={state} detail={detail} refresh={refresh} />}
        {state && !["dashboard", "opportunities"].includes(route.slug) && <WorkspacePage section={route.slug} state={state} refresh={refresh} />}
      </main>
    </div>
    {popover === "shortcuts" && <ShortcutsDialog onClose={closeShortcuts} />}
  </div>;
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={dialogRef} className="terminal-modal terminal-shortcuts" aria-labelledby="terminal-shortcut-title" onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="terminal-modal-body">
      <header><div><BookOpen size={19} /><h2 id="terminal-shortcut-title">Raccourcis clavier</h2></div><button className="icon-button" aria-label="Fermer" onClick={onClose} autoFocus><X size={19} /></button></header>
      <ul>{routes.map(({ label, shortcut }) => <li key={shortcut}>{label}<span><kbd>Alt</kbd> <kbd>{shortcut}</kbd></span></li>)}</ul>
    </div>
  </dialog>;
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
  const [capabilities, setCapabilities] = useState<{ authConfigured?: boolean; demoAvailable?: boolean } | null>(null);
  const router = useRouter();
  const signup = action === "signup";

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setCapabilities(await response.json());
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

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
      if (!result.ok) throw new Error(await errorMessage(result, "La connexion a échoué."));
      const payload = await result.json() as { pendingConfirmation?: boolean };
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
      {capabilities?.authConfigured !== false ? <form onSubmit={(event) => void authenticate(event)}>
        <label className="field">Courriel<input name="email" type="email" autoComplete="email" placeholder="nom@exemple.com" required /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} minLength={signup ? 8 : undefined} required /></label>
        <button type="submit" className="button button-primary" disabled={busy}>{busy ? "Connexion en cours…" : signup ? "Créer un compte" : "Se connecter"}</button>
      </form> : <p>La connexion par courriel est indisponible tant que Supabase Auth n’est pas configuré.</p>}
      {message && <p role={message.problem ? "alert" : "status"} className={message.problem ? "text-negative" : "text-positive"}>{message.text}</p>}
      {capabilities?.authConfigured !== false && <button className="terminal-login-switch" onClick={() => { setAction(signup ? "login" : "signup"); setMessage(null); }} disabled={busy}>{signup ? "J’ai déjà un compte" : "Créer un compte"}</button>}
      {capabilities?.demoAvailable !== false && <div className="terminal-login-demo">
        <button className="button button-secondary" onClick={() => void authenticate()} disabled={busy}><FlaskConical size={17} /> Ouvrir la démonstration</button>
        <small>DEMO — DONNÉES FICTIVES</small>
      </div>}
    </section>
  </main>;
}

function relativeDate(value: string) {
  const marketDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  const days = (Date.parse(marketDay.format(new Date())) - Date.parse(marketDay.format(new Date(value)))) / 86_400_000;
  return days > 1 ? `il y a ${days} j` : days === 1 ? "hier" : "aujourd’hui";
}

async function errorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { error?: string | { message?: string }; message?: string } | null;
  return typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? payload?.message ?? fallback;
}
