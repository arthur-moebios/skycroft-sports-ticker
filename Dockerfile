# Skycroft Ticker em contêiner: servidor + display + controle remoto.
# Zero dependências npm, então não há etapa de install.
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8099 \
    TZ=America/Sao_Paulo \
    SKYCROFT_PORTAL=0 \
    SKYCROFT_STATE_FILE=/data/control-state.json \
    SKYCROFT_KEY_FILE=/data/remote-key

RUN apk add --no-cache tzdata \
 && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --chown=node:node display ./display
COPY --chown=node:node remote  ./remote
COPY --chown=node:node setup   ./setup
COPY --chown=node:node server/index.js server/espn.js server/net.js server/package.json ./server/

USER node
VOLUME /data
EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
