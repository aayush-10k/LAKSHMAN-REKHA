import { AppShell } from '@/components/AppShell';

/**
 * The operator surfaces — /console and /playground — share one shell: a fixed
 * top bar and a fixed left rail.
 *
 * A route group rather than a path segment, so both keep their URLs. The
 * landing page stays outside this group on purpose: it is what a judge opens
 * cold with no backend running, and the shell polls the core.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
