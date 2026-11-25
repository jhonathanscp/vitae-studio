# ==========================================
# Target: API (Node.js + Chromium + BullMQ)
# ==========================================
FROM node:22-bookworm-slim AS api

# Instala Chromium, dependências do Puppeteer e toolchain de compilação nativa para ARM64
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-freefont-ttf \
    ca-certificates \
    procps \
    tzdata \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_HEADLESS=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    TZ=America/Sao_Paulo

WORKDIR /app

# Copia arquivos de dependências da API
COPY api/package*.json api/.npmrc ./

# Instala todas as dependências necessárias para compilação
RUN if [ -f package-lock.json ]; then npm ci || (rm -f package-lock.json && npm install); else npm install; fi

# Copia o código fonte e arquivos de configuração da API
COPY api/ ./

# Compila o projeto TypeScript com esbuild
RUN npm run build

# Remove devDependencies para reduzir o tamanho da imagem final
RUN npm prune --omit=dev

ENV NODE_ENV=production

# Garante a existência do diretório de recursos/persistência
RUN mkdir -p /app/resources

EXPOSE 3000

CMD ["node", "dist/index.js"]


# ==========================================
# Target: Web Builder (React 19 + Vite)
# ==========================================
FROM node:22-alpine AS web-builder

WORKDIR /app

ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}

COPY web/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci || (rm -f package-lock.json && npm install); else npm install; fi

COPY web/ ./
RUN npm run build


# ==========================================
# Target: Web (Nginx Servindo Estáticos)
# ==========================================
FROM nginx:alpine AS web

ENV TZ=America/Sao_Paulo

COPY --from=web-builder /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
