FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Копируем все модули, а не перечисление: список уже разошёлся с кодом,
# и контейнер падал при старте с ERR_MODULE_NOT_FOUND.
COPY *.mjs ./
COPY public ./public
# Данные (SQLite, карточки планов, файловый кеш) живут в томе, иначе стираются
# при каждой пересборке образа.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--no-warnings=ExperimentalWarning","server.mjs"]
