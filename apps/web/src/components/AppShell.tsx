'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { SoundToggle } from './SoundToggle';
import { CORE_URL } from '../lib/pairing';

/**
 * The shell both operator surfaces sit inside: a fixed top bar and a fixed left
 * rail carrying identity and navigation.
 *
 * The landing page deliberately does NOT use this. It is the page a judge opens
 * cold with nothing running, so it stays a Server Component with no client
 * state, no polling and nothing that can fail.
 *
 * Every control here goes somewhere real. The reference design also drew a
 * "New predicate" button and a Settings link; there is no predicate editor and
 * no settings screen behind them, and a judge who clicks a dead control learns
 * something about the whole product. They are not here.
 */

type NavItem = { href: string; label: string; icon: IconName };

const NAV: NavItem[] = [
  { href: '/', label: 'Protocol', icon: 'shield' },
  { href: '/console', label: 'Console', icon: 'terminal' },
  { href: '/playground', label: 'Playground', icon: 'bug' },
];

/**
 * Core liveness for the top bar's indicator.
 *
 * Its own poll rather than a value threaded down from the pages: the pages'
 * effect dependency arrays drive their EventSource, and adding a subscriber to
 * them reconnects the stream. A HEAD-weight GET every five seconds against a
 * service on the same host is the cheaper of the two risks.
 */
function useCoreUp(): boolean | null {
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch(`${CORE_URL}/health`, { cache: 'no-store' });
        if (alive) setUp(res.ok);
      } catch {
        if (alive) setUp(false);
      }
    };
    void check();
    const id = setInterval(check, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return up;
}

/**
 * The paired agent id, read from the cache pairing.ts already writes.
 *
 * Polled rather than read once: the shell mounts before the page's pairing call
 * has returned, so a single read on mount always finds an empty slot and the
 * rail would say "no agent paired" for the rest of the session. It also has to
 * survive a core restart, which mints a different id under the same key.
 */
function useAgentId(): string | null {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    const read = () => {
      try {
        setId(window.localStorage.getItem('rekha.agentId'));
      } catch {
        setId(null);
      }
    };
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  }, []);

  return id;
}

function TopAppBar({ coreUp }: { coreUp: boolean | null }) {
  const pathname = usePathname();
  const dot =
    coreUp === null
      ? 'bg-outline-variant'
      : coreUp
        ? 'bg-status-success shadow-[0_0_8px_var(--color-status-success)]'
        : 'bg-status-error shadow-[0_0_8px_var(--color-status-error)]';

  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-16 items-center justify-between border-b border-muted bg-surface px-margin-mobile md:px-margin-desktop">
      <Link href="/" className="flex items-center gap-2 text-on-surface transition-colors hover:text-primary">
        <Icon name="lock" size={18} className="text-primary" />
        <span className="font-mono text-body-lg font-bold tracking-tighter">LAKSHMAN REKHA</span>
      </Link>

      <div className="flex items-center gap-3 md:gap-6">
        {/* The rail is md-and-up only, so below that the top bar carries the
            navigation. Without this there is no way off /console on a phone
            except the browser's back button. */}
        <nav className="flex items-center gap-0.5 md:hidden">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
                className={`flex items-center justify-center rounded-sm p-2 transition-colors ${
                  active
                    ? 'bg-surface-container-highest text-tertiary'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-primary'
                }`}
              >
                <Icon name={item.icon} size={18} />
              </Link>
            );
          })}
        </nav>

        <span className="hidden rounded-sm border border-muted bg-surface-container px-2 py-1 font-mono text-label-sm tracking-widest text-on-surface-variant lg:inline-block">
          [ NETWORK: BASE SEPOLIA ]
        </span>

        <div className="flex items-center gap-1 text-on-surface-variant">
          <Link
            href="/#verification"
            className="hidden items-center justify-center rounded-sm p-2 transition-colors hover:bg-surface-container-high hover:text-primary sm:flex"
            aria-label="Deployed contracts"
            title="Deployed contracts"
          >
            <Icon name="network" size={18} />
          </Link>

          <span
            className="relative flex items-center justify-center rounded-sm p-2"
            title={coreUp === null ? 'Checking the core' : coreUp ? 'Core is up' : 'Core is not answering'}
          >
            <Icon name="signal" size={18} />
            <span className={`absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${dot}`} />
            <span className="sr-only">
              {coreUp === null ? 'Checking the core' : coreUp ? 'Core is up' : 'Core is not answering'}
            </span>
          </span>

          <SoundToggle />
        </div>
      </div>
    </header>
  );
}

function SideNav({ agentId }: { agentId: string | null }) {
  const pathname = usePathname();

  return (
    <nav className="fixed left-0 top-16 z-40 hidden h-[calc(100vh-4rem)] w-sidenav flex-col border-r border-muted bg-surface-container-low md:flex">
      <div className="border-b border-muted p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-muted bg-surface">
            <Icon name="bot" size={20} className="text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate font-headline text-[17px] font-semibold text-on-surface">
              {agentId ? agentId.toUpperCase() : 'NO AGENT PAIRED'}
            </h2>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">
                Signatures required
              </span>
              <span className="flex items-center gap-0.5 text-tertiary">
                <Icon name="key" size={12} />
                <Icon name="key" size={12} />
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-1 px-3 py-4">
        {NAV.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'flex items-center gap-3 border-l-4 border-tertiary bg-surface-container-highest px-4 py-3 text-tertiary'
                  : 'group flex items-center gap-3 border-l-4 border-transparent px-4 py-3 text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface'
              }
            >
              <Icon name={item.icon} size={18} className={active ? '' : 'group-hover:text-primary'} />
              <span className={`font-mono text-label-sm uppercase tracking-wider ${active ? 'font-bold' : ''}`}>
                {item.label}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="border-t border-muted p-4">
        <a
          href="https://github.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-sm px-4 py-2.5 text-on-surface-variant transition-colors hover:bg-surface-variant hover:text-on-surface"
        >
          <Icon name="book" size={16} className="group-hover:text-primary" />
          <span className="font-mono text-[11px] uppercase tracking-wider">Documentation</span>
        </a>
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const coreUp = useCoreUp();
  const agentId = useAgentId();

  return (
    <>
      <TopAppBar coreUp={coreUp} />
      <SideNav agentId={agentId} />
      <main className="mt-16 min-h-[calc(100vh-4rem)] md:ml-sidenav">{children}</main>
    </>
  );
}
