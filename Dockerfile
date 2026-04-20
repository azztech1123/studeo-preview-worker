FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# ffmpeg gives us ffprobe for the ogre validator
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
