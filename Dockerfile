FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3000

CMD ["node", "src/server.js"]
