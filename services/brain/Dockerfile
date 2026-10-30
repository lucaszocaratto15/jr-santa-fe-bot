FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    BRAIN_HOST=0.0.0.0 \
    BRAIN_PORT=8790 \
    BRAIN_DB_PATH=/data/brain.sqlite

WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node index.mjs server.mjs store.mjs access.mjs curator.mjs text.mjs ./

USER node
EXPOSE 8790
VOLUME ["/data"]
CMD ["node", "index.mjs"]
