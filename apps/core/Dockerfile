# Core API + the adversary runner, in one image.
#
# The adversary is here rather than in its own service because only the core
# ever calls it — `POST /v1/adversary/run` proxies to it server-side, so it
# never needs a public hostname. It is pure-stdlib Python (see
# apps/agents/adversary/pyproject.toml: `dependencies = []`), so it costs one
# `apk add python3` and nothing else.

FROM node:20-alpine

# python3 for the adversary runner. No pip install: it has no dependencies.
RUN apk add --no-cache python3

WORKDIR /app

# ── Dependencies ────────────────────────────────────────────
#
# pnpm-lock.yaml MUST be copied. Without it `--frozen-lockfile` fails with
# ERR_PNPM_NO_LOCKFILE and the image cannot build at all — this Dockerfile
# omitted it and so had never built. Verified 2026-08-04 by reproducing this
# copy set outside Docker:
#   no lockfile                    -> EXIT=1  ERR_PNPM_NO_LOCKFILE
#   lockfile, these manifests only -> EXIT=0  127 packages
#
# Only core's and task-engine's manifests are copied. pnpm does not require the
# other workspace members to be present, and leaving apps/web out keeps the
# image at 127 packages instead of 472.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/core/tsconfig.json apps/core/
COPY apps/agents/task-engine/package.json apps/agents/task-engine/

# corepack, not `npm i -g pnpm`: it honours "packageManager": "pnpm@9.0.0" in
# the root package.json. A newer pnpm major can refuse this lockfile version.
RUN corepack enable && corepack pnpm install --frozen-lockfile

# ── Source ──────────────────────────────────────────────────
COPY apps/core/src/ apps/core/src/
COPY apps/agents/task-engine/src/ apps/agents/task-engine/src/
COPY apps/agents/adversary/ apps/agents/adversary/
COPY apps/core/docker-entrypoint.sh /usr/local/bin/rekha-entrypoint
RUN chmod +x /usr/local/bin/rekha-entrypoint

# NODE_ENV is set AFTER the install on purpose. pnpm skips devDependencies when
# NODE_ENV=production, and `tsx` — which the start command loads — is a
# devDependency of apps/core. Setting this earlier produces an image that builds
# and then dies at startup on "Cannot find package 'tsx'".
ENV NODE_ENV=production
ENV PORT=4000

# The shipped default is 15000 (see .env.example for why 5000 was not enough to
# survive a real settlement). This line used to say 5000 and silently contradict
# it. Override per environment; do not lower it without re-measuring.
ENV LEASE_TTL_MS=15000
ENV CEREMONY_ROUND_MS=1200

# The adversary listens on loopback inside this container.
ENV ADVERSARY_URL=http://127.0.0.1:4300
ENV ADVERSARY_PORT=4300

EXPOSE 4000

CMD ["rekha-entrypoint"]
