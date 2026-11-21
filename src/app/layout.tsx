import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './global.css';
import './fallback.css';

export const metadata: Metadata = {
  title: 'OPTIONS AI PRO',
  description: 'Terminal de recherche et de simulation pour les options américaines.',
  applicationName: 'OPTIONS AI PRO',
};

export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="fr" className={GeistSans.variable + ' ' + GeistMono.variable}>
    <body>{children}</body>
  </html>;
}
