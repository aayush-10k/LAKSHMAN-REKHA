FROM node:20-alpine

WORKDIR /app

COPY apps/vendorsim/package.json ./
RUN npm install

COPY apps/vendorsim/src/ ./src/
COPY apps/vendorsim/seed/ ./seed/

ENV PORT=4100

EXPOSE 4100

CMD ["node", "src/server.js"]
