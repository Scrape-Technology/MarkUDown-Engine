FROM node:20-slim

# Install Patchright/Chromium system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production=false

# Install Patchright Chromium (anti-detection Playwright fork)
RUN npx patchright install chromium

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies
RUN npm prune --production

CMD ["node", "dist/index.js"]
