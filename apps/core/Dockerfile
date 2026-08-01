FROM node:20-alpine

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml ./
COPY apps/core/package.json apps/core/
COPY apps/core/tsconfig.json apps/core/
COPY apps/agents/task-engine/package.json apps/agents/task-engine/

# Install dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy source
COPY apps/core/src/ apps/core/src/
COPY apps/agents/task-engine/src/ apps/agents/task-engine/src/

WORKDIR /app/apps/core

ENV NODE_ENV=production
ENV PORT=4000
ENV LEASE_TTL_MS=5000

EXPOSE 4000

CMD ["node", "--import", "tsx/esm", "src/api/index.ts"]
