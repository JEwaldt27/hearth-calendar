FROM node:22-alpine

LABEL org.opencontainers.image.title="Hearth Calendar" \
      org.opencontainers.image.description="Self-hosted family wall calendar with two-way Google, Outlook and iCloud sync, chores, lists and meal planning" \
      org.opencontainers.image.source="https://github.com/JEwaldt27/hearth-calendar" \n      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY VERSION ./VERSION

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "src/server.js"]
