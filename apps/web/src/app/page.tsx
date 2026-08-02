import { redirect } from 'next/navigation';

/**
 * The root path is not a page — it is a redirect to the console.
 *
 * FIX.md TASK 4. This file used to be a 463-line HTML prototype injected with
 * dangerouslySetInnerHTML, pulling Supabase off a CDN and hand-wiring buttons
 * through document.getElementById. It was a second, drifting copy of the UI that
 * src/app/console already renders properly, so / now sends people to the one
 * that is actually maintained.
 *
 * A Server Component: redirect() issues a 307 before anything reaches the
 * browser, rather than flashing a page and moving afterwards.
 */
export default function Home() {
  redirect('/console');
}
