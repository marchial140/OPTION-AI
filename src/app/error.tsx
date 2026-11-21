'use client';

import Link from 'next/link';

export default function ErrorPage({reset}: {reset: () => void}) {
  return <main className="route-fallback">
    <div className="panel route-fallback-panel" role="alert">
      <h1>Le terminal est momentanément indisponible</h1>
      <p>Vous pouvez réessayer ou revenir au tableau de bord.</p>
      <div className="route-fallback-actions">
        <button className="button button-primary" onClick={reset}>Réessayer</button>
        <Link className="button button-secondary" href="/">Tableau de bord</Link>
      </div>
    </div>
  </main>;
}
