'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/game-days', label: 'Game days' },
  { href: '/audit', label: 'Audit' },
];

export function NavLinks() {
  const path = usePathname();
  const current = (href: string) => (href === '/' ? path === '/' : path.startsWith(href));
  return (
    <div className="nav-links">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={current(l.href) ? 'page' : undefined}>{l.label}</Link>
      ))}
    </div>
  );
}
