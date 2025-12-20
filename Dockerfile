FROM oven/bun:latest

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Expose port (default 3000, can be overridden via PORT env var)
EXPOSE 3000

# Run the server
CMD ["bun", "run", "index.ts"]
