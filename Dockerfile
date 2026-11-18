FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir -U yt-dlp opencv-python-headless numpy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV NODE_ENV=production
ENV PYTHON_BIN=python3
ENV FFMPEG_THREADS=1
ENV PORT=10000

EXPOSE 10000
CMD ["npm", "start"]
