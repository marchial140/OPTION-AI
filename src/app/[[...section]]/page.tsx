import { notFound } from 'next/navigation';
import Terminal from '@/components/terminal';

const sections = new Set([
  'dashboard', 'scanner', 'opportunities', 'strategy-lab', 'assistant',
  'watchlist', 'portfolio', 'analytics', 'history', 'settings', 'login',
]);

export default async function Page({params}: {params: Promise<{section?: string[]}>}) {
  const { section = [] } = await params;
  const [current = 'dashboard', detail] = section;
  if (!sections.has(current) || section.length > 2 || (detail && current !== 'opportunities')) notFound();
  return <Terminal section={current} detail={detail} />;
}
