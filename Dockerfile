FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy application files
COPY server.mjs ./
COPY adapters/ ./adapters/
COPY db/ ./db/
COPY routes/ ./routes/
COPY sync/ ./sync/
COPY mattermost/ ./mattermost/
COPY dashboard/ ./dashboard/
COPY questbus/ ./questbus/

# Create data directory
RUN mkdir -p /data

ENV QUESTWORKS_DB=/data/questworks.db
ENV PORT=8788

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8788/health || exit 1

CMD ["node", "server.mjs"]
