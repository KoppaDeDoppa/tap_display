# Multi-stage build for smaller final image
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY server.js payment-display.js estimated-keg.js ./
COPY public/ ./public/

# Production stage
FROM node:22-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Use existing node user (uid/gid 1000) from node:alpine base image
# No need to create new user/group

# Copy built app from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server.js /app/payment-display.js /app/estimated-keg.js ./
COPY --from=builder /app/public ./public

# Copy config (will be overridden by docker-compose volume mount)
COPY config.json ./

# Change ownership
RUN chown -R node:node /app

USER node

EXPOSE 3005

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
