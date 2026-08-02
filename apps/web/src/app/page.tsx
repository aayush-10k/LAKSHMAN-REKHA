import { redirect } from 'next/navigation';

/**
 * The root path is a redirect to the console. It is not a page.
 *
 * FIX3.md BUG 1. What used to be here was ~44KB of prototype HTML injected
 * through dangerouslySetInnerHTML, which pulled in public/js/{supabase,app,auth,
 * agent}.js. Those scripts were a second, parallel, entirely fake product:
 * simulateSpend() in app.js evaluated "policy" as a client-side if/else chain in
 * the browser, denominated in dollars, matching counterparties by display name,
 * with Math.random() nonces and a hardcoded task script per attack mode. No
 * chain call, no signature, no lease, no core request anywhere in it.
 *
 * A judge opening the deployed site landed on that instead of on the real
 * console — which is why the submission read as hardcoded. It was. The scripts
 * and stylesheet are deleted, not disabled: policy that a browser can evaluate
 * is not policy, and leaving it behind a flag or a route would leave a second
 * answer to "what does this product do".
 *
 * Server Component, so the 307 is issued before anything reaches the browser.
 */
export default function Home() {
  redirect('/console');
}
