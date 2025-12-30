FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Set cache volume
VOLUME /cache
ENV CACHE_DIR=/cache

# Expose port (default 24242, can be overridden via PORT env var)
EXPOSE 24242

# Run the server
CMD ["bun", "run", "index.ts"]
