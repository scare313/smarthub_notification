FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Create persistent storage directories
RUN mkdir -p src/storage screenshots logs

# Expose port for local mock server/analytics dashboard
EXPOSE 3000

# Spin up both mock server (for verification) and the scheduler/monitoring app
CMD ["sh", "-c", "npm run mock-server & npm start"]
