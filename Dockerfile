FROM node:20-bookworm-slim

# Apply security patches for all base packages before anything else
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    wget \ 
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

# Store Patchright/Chromium inside /app so non-root user can access it
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.browsers
RUN npx patchright install chromium

# Build TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune devDependencies
RUN npm prune --production

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies and add the Google Chrome repository
RUN apt-get update && apt-get install -y \
    wget gnupg \
    fonts-liberation libasound2 libatk-bridge2.0-0 \
    libcups2 libgbm1 libgtk-3-0 libnss3 \
    xdg-utils --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*


# Run as non-root (node user exists in node:slim images)
RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
