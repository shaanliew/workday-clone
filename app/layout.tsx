import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

// Every page depends on the signed-in user, so render on request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Workline — Leave & Claims',
  description: 'Workday-style HCM for leave applications, expense claims, approvals and payroll hand-off.',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b5cab',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-SG">
      <body>{children}</body>
    </html>
  );
}
