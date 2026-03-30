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
COPY example-output.deploy.json ./example-output.json
COPY example-assets ./example-assets
COPY run_pipeline.js ./
COPY plan.txt ./

RUN mkdir -p /app/persist/.runtime/final /app/persist/example-assets

ENV PORT=3000 \
    HOST=0.0.0.0 \
    PERSIST_ROOT=/app/persist \
    FFMPEG_PATH=/usr/bin/ffmpeg

EXPOSE 3000

CMD ["node", "server.js"]
