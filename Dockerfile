FROM node:24-bookworm-slim
WORKDIR /app
COPY server.mjs ./
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
CMD ["node","server.mjs"]
