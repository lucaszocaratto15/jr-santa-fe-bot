FROM node:24.21.0-alpine

ENV NODE_ENV=production \
    JR_CONTROL_HOST=0.0.0.0 \
    JR_CONTROL_PORT=8787 \
    JR_CONTROL_DATA_DIR=/data

WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node index.mjs server.mjs store.mjs proxy.mjs validation.mjs compact.mjs handbook.mjs ./

USER node
EXPOSE 8787
CMD ["node", "index.mjs"]
