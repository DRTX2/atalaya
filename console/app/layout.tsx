import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { UI } from '@/lib/api';
import { authEnabled, currentUser } from '@/lib/auth';
import { NavLinks } from './nav-links';
import './globals.css';

export const metadata: Metadata = {
  title: 'Atalaya Console',
  description: 'Incident command center across Nimbus, Flagship, Hookrelay and Bitácora',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <a href="/" className="brand"><span className="brand-mark" aria-hidden /> Atalaya <small>console</small></a>
          <NavLinks />
          <div className="nav-products" aria-label="Product dashboards">
            <a href={UI.nimbus} target="_blank" rel="noreferrer">Nimbus ↗</a>
            <a href={UI.flagship} target="_blank" rel="noreferrer">Flagship ↗</a>
            <a href={UI.hookrelay} target="_blank" rel="noreferrer">Hookrelay ↗</a>
          </div>
          {user && (
            <div className="nav-user">
              <span title={user.username}>{user.name} <span className={`role ${user.role}`}>{user.role}</span></span>
              {authEnabled() && <form action="/auth/logout" method="post"><button type="submit" className="link-button">Sign out</button></form>}
            </div>
          )}
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
