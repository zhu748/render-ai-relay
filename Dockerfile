FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
ENV NODE_ENV=production PORT=10000
USER node
EXPOSE 10000
CMD ["node", "src/server.js"]
