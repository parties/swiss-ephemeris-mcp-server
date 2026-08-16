# Use Node.js 18 LTS as base image
FROM node:18-alpine

# Install build dependencies and git
RUN apk add --no-cache \
    git \
    build-base \
    make \
    gcc \
    g++ \
    libc-dev

# Set working directory
WORKDIR /app

# Build Swiss Ephemeris from source and copy data files
RUN git clone https://github.com/aloistr/swisseph.git /tmp/swisseph && \
    cd /tmp/swisseph && \
    make && \
    cp swetest /usr/local/bin/ && \
    rm -rf /tmp/swisseph

# Copy package files
COPY package*.json ./

# Install Node.js dependencies. --ignore-scripts because the `prepare` script runs husky,
# which is a devDependency and so is absent from a production install - without this the
# build dies at `sh -c husky` with exit 127. Neither runtime dependency has an install script.
RUN npm ci --omit=dev --ignore-scripts

# Copy application code. index.js imports every module in lib/, so lib/ is not optional -
# omitting it builds an image that dies on the first import with ERR_MODULE_NOT_FOUND.
COPY index.js ./
COPY lib/ ./lib/

# Copy vendor directory with ephemeris data files
COPY vendor/ ./vendor/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port for HTTP mode
EXPOSE 8000

# Health check. Only HTTP mode has something to probe, so the check is mode-aware: it hits
# the /health route when MCP_HTTP_MODE=true and is a deliberate no-op otherwise. In stdio
# mode the server owns no socket, so process liveness is the only signal there is - and
# Docker already reports that by itself. The previous check ran `node -e console.log(...)`,
# which passed no matter what the server was doing and duly reported this very image as
# healthy while it was too broken to start at all.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD [ "$MCP_HTTP_MODE" != "true" ] || wget -qO- "http://127.0.0.1:${PORT:-8000}/health" > /dev/null || exit 1

# Default to stdio mode, can be overridden with environment variables
ENV MCP_HTTP_MODE=false
ENV NODE_ENV=production
ENV SE_EPHE_PATH=/app/vendor/swisseph

# Start the MCP server
CMD ["node", "index.js"] 