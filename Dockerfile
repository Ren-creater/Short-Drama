FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server.js ./
COPY app.js ./
COPY index.html ./
COPY styles.css ./
COPY example-output.json ./
COPY run_pipeline.js ./
COPY showcase.html ./
COPY showcase.js ./
COPY plan.txt ./

RUN mkdir -p /app/.runtime/final /app/example-assets

ENV PORT=3000 \
    HOST=0.0.0.0 \
    FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

CMD ["node", "server.js"]
