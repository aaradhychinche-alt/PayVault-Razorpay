FROM node:18-bullseye-slim

WORKDIR /app

# Install Python 3 and build dependencies for local ML inference
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python ML requirements
COPY src/ml/requirements.txt /app/src/ml/requirements.txt
RUN pip3 install --no-cache-dir -r /app/src/ml/requirements.txt

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source code
COPY . .

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
