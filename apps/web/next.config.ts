import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Hosts allowed to request /_next/* dev resources.
   *
   * Next.js 16 blocks cross-origin dev requests by default. The core, agent and
   * vendorsim run inside WSL, and Windows reaches the dev server by the VM's
   * address rather than localhost — which Next treats as cross-origin, refuses
   * the page's client chunk with a 500, and so hydration never completes. The
   * symptom is the worst kind: the page renders its server HTML perfectly and
   * every value stays frozen at its initial state, because no effect ever runs.
   * It looks exactly like "the core is down" and is nothing of the sort.
   *
   * Dev-only; it has no effect on a production build.
   *
   * The WSL VM address changes when WSL restarts — check with
   * `wsl -d Ubuntu -- hostname -I` and add the new one if the chunks 500 again.
   */
  allowedDevOrigins: ["172.27.211.212"],
};

export default nextConfig;
