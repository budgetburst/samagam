# ==========================================
# Dockerfile for Render.com Background Worker
# Base: Official Microsoft Playwright image (Noble/Ubuntu 24.04)
# ==========================================

FROM mcr.microsoft.com/playwright:v1.50.1-noble

# Set non-interactive debian frontend
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# Install Xvfb to provide virtual display for headed Chrome execution (bypasses Cloudflare Turnstile)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first to leverage Docker layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Create directory for persistent browser context state
RUN mkdir -p /app/.kvs_render_profile && chown -R pwuser:pwuser /app

# Switch to non-root pwuser provided by the official Playwright image
USER pwuser

# Expose HTTP port (10000 for Render, 7860 for Hugging Face Spaces)
EXPOSE 10000 7860

# Run via xvfb-run to provide virtual display :99 for Cloudflare Turnstile evaluation
CMD ["xvfb-run", "--server-args=-screen 0 1366x768x24 -ac", "node", "server.js"]
