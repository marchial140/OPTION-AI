"use client";

import { cloneElement, isValidElement, useId, useRef } from "react";
import type { ComponentType, FormEvent, ReactElement, ReactNode } from "react";
import { AlertCircle, CheckCircle2, CircleHelp, LoaderCircle } from "lucide-react";

const usd = new Intl.NumberFormat("fr-CA", { style: "currency", currency: "USD" });
const num = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 2 });
const moment = new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const date = new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium", timeZone: "UTC" });
const exchangeDate = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "America/New_York" });

export const money = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? usd.format(value) : "—";
export const number = (value?: number | null) => typeof value === "number" && Number.isFinite(value) ? num.format(value) : "—";
export const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? moment.format(new Date(value)) + " HE" : "—";
export const shortDate = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? date.format(new Date(value)) : "—";
export const dayInput = (now = new Date()) => exchangeDate.format(now);

export const directionLabels: Record<string, string> = {
  bullish: "Haussier", bearish: "Baissier", neutral: "Neutre", mixed: "Mitigé", insufficient: "Données insuffisantes",
};
export const dataLabels: Record<string, string> = {
  DEMO: "Fictif", MANUAL_ATTESTED: "Attestée · indicative", VERIFIED_FRESH: "Vérifié · récent", VERIFIED_DELAYED: "Vérifié · différé",
  VERIFIED_HISTORICAL: "Vérifié · historique", STALE: "Périmé", UNVERIFIED: "Non vérifié",
  INSUFFICIENT: "Insuffisant", CONTRADICTORY: "Contradictoire",
};
export const scanLabels: Record<string, string> = { quick: "Rapide", deep: "Approfondi", custom: "Personnalisé" };
export const statusLabels: Record<string, string> = {
  pending: "En attente", queued: "En file", running: "En cours", completed: "Terminé", partial: "Partiel",
  failed: "Échec", cancelled: "Annulé", canceled: "Annulé", open: "Ouverte", closed: "Clôturée",
};

export function Heading({ icon: Icon, title, detail, actions }: {
  icon: ComponentType<{ size?: number }>; title: string; detail: string; actions?: ReactNode;
}) {
  return <header className="wp-heading">
    <div className="wp-heading-main"><div className="wp-heading-icon"><Icon size={23} /></div>
      <div><h1>{title}</h1><p>{detail}</p></div>
    </div>{actions && <div className="wp-actions">{actions}</div>}
  </header>;
}

export function Panel({ title, detail, children, actions, className = "" }: {
  title: string; detail?: string; children: ReactNode; actions?: ReactNode; className?: string;
}) {
  return <section className={`wp-panel ${className}`}>
    <header className="wp-panel-head"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div>{actions}</header>
    <div className="wp-panel-body">{children}</div>
  </section>;
}

export function Field({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) {
  const id = useId();
  const input = isValidElement(children) ? cloneElement(
    children as ReactElement<{ id?: string; "aria-describedby"?: string }>,
    { id, "aria-describedby": hint ? id + "-hint" : undefined },
  ) : children;
  return <div className={`wp-field${wide ? " wp-field-wide" : ""}`}><label htmlFor={id}>{label}</label>{input}
    {hint && <small id={id + "-hint"}>{hint}</small>}
  </div>;
}

export function Empty({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <div className="wp-empty"><span className="wp-empty-icon"><CircleHelp size={19} /></span>
    <strong>{title}</strong><p>{detail}</p>{children}</div>;
}

export function Notice({ children, type = "info" }: { children: ReactNode; type?: "info" | "error" | "success" }) {
  const Icon = type === "success" ? CheckCircle2 : AlertCircle;
  return <div className={`wp-notice wp-notice-${type}`} role={type === "error" ? "alert" : "status"}>
    <Icon size={16} /><div>{children}</div>
  </div>;
}

export function Status({ value, dictionary = statusLabels }: { value: string; dictionary?: Record<string, string> }) {
  const tone = ["completed", "closed", "VERIFIED_FRESH", "bullish"].includes(value) ? "good" :
    ["failed", "CONTRADICTORY", "bearish"].includes(value) ? "bad" :
    ["partial", "running", "pending", "queued", "VERIFIED_DELAYED", "MANUAL_ATTESTED", "STALE"].includes(value) ? "warn" : "neutral";
  return <span className={`wp-status wp-status-${tone}`}><i />{dictionary[value] ?? value}</span>;
}

function isLinkableSource(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hostname.endsWith(".invalid");
  } catch {
    return false;
  }
}

export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  if (url === "/settings#data-sources") return <a href={url}>{children}</a>;
  if (isLinkableSource(url)) return <a href={url} target="_blank" rel="noreferrer">{children}</a>;
  return <>{children}</>;
}

export function Stat({ label, value, hint, tone = "" }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return <div className="wp-stat"><span>{label}</span><strong className={tone}>{value}</strong>{hint && <small>{hint}</small>}</div>;
}

export function Submit({ children, pending, disabled }: { children: ReactNode; pending?: boolean; disabled?: boolean }) {
  return <button className="wp-button wp-primary" type="submit" disabled={pending || disabled}>
    {pending && <LoaderCircle size={16} className="wp-spin" />}{children}
  </button>;
}

export function newRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function usePreparedRequest<Payload>() {
  const pending = useRef<{ fingerprint: string; key: string; body: Payload } | null>(null);
  return {
    get(input: unknown, prepare: () => Payload) {
      const fingerprint = JSON.stringify(input);
      if (!pending.current || pending.current.fingerprint !== fingerprint) {
        pending.current = { fingerprint, key: newRequestId(), body: prepare() };
      }
      return pending.current;
    },
    clear() {
      pending.current = null;
    },
  };
}

export async function request<T = Record<string, unknown>>(url: string, method = "GET", body?: unknown, requestKey?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      cache: "no-store",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error("La connexion a échoué. Réessayez dans un instant.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data?.error;
    throw new Error(typeof error === "string" ? error : error?.message ?? data?.message ?? "La demande n’a pas abouti.");
  }
  return data as T;
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "La demande n’a pas abouti.";

export function actionForm(action: () => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    action();
  };
}

export function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
