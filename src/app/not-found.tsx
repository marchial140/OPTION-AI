import Link from 'next/link';

export default function NotFound() {
  return <main className="route-fallback">
    <div className="panel route-fallback-panel">
      <h1>Page introuvable</h1>
      <p>Ce dossier ou cette page ne figure pas dans le terminal.</p>
      <Link className="button button-primary" href="/">Tableau de bord</Link>
    </div>
  </main>;
}
