# Deployment Guide

## Recommended production target

Recommended choice: a single Dockerized Node service on Railway with a small persistent volume.

Why this is the best fit for this repo:
- the app is already one Node server serving both static frontend and backend proxy
- FFmpeg is required for final assembly
- example-output assets and final MP4s benefit from persistent disk
- deployment stays simple: one service, one env set, one URL

Recommended layout:
- Railway web service running this Dockerfile
- volume mounted for `/app/.runtime/final` and `/app/example-assets`
- frontend served by the same Node process
- DashScope + Kimi secrets configured as service environment variables

## Platform comparison

### Option 1: Railway single service (recommended)
Use when you want the fewest moving parts.

Pros:
- simple Docker deployment
- persistent volume support
- one URL for frontend + backend
- FFmpeg in container is straightforward

Cons:
- not free in the long term
- less globally distributed than a static CDN frontend

### Option 2: Cloudflare Pages or Vercel for frontend + Railway for backend
Use when you want a CDN frontend, but still need a real backend process.

Pros:
- static frontend is fast and cheap
- backend stays a normal Node process with FFmpeg

Cons:
- two deployments instead of one
- you must set `API_BASE_URL` / CORS carefully if you split them later

### Option 3: Linux VPS
Use when you want the lowest predictable monthly cost and full control.

Pros:
- cheap fixed pricing
- full control over disk, ffmpeg, and process manager

Cons:
- more ops work
- you own patching, process supervision, TLS, and rollback

## Why not Vercel-only

This repo is a poor fit for a frontend-only or serverless-only deployment because:
- final assembly uses FFmpeg
- example-output assets need persistent filesystem storage
- long-running workflow polling is easier with a normal Node process

## Docker vs no Docker on Linux

If deploying to Linux:
- Docker is recommended
- it removes Node/FFmpeg drift between local and production
- it makes future migration between Railway and a VPS much easier

You do not strictly need Docker if you deploy to a VPS, but then you must manage:
- Node 20+
- FFmpeg installation
- process management (systemd/pm2)
- reverse proxy (Nginx/Caddy)

## Railway deployment steps

1. Push this repo to GitHub.
2. Create a new Railway project from the repo.
3. Let Railway build from `Dockerfile`.
4. Add environment variables from `.env.example`.
5. Add a persistent volume and mount it so `/app/.runtime/final` and `/app/example-assets` survive restarts.
6. Deploy.

## Production secrets

Do not hardcode keys in the repo.

Set them in the platform environment UI:
- `DASHSCOPE_API_KEY`
- `KIMI_API_KEY`
- optional model overrides like `VIDEO_MODEL_SEQUENCE`

For local shell testing, these are fine:

```powershell
$env:KIMI_API_KEY="<kimi key>"
$env:KIMI_MODEL="moonshotai/kimi-k2.5"
$env:DASHSCOPE_API_KEY="<dashscope key>"
$env:DASHSCOPE_BASE_URL="https://dashscope-intl.aliyuncs.com"
node server.js
```

For production, put the same values into the host's environment-variable panel instead of the codebase.

## Persistence expectations

Persist these paths in production:
- `/app/.runtime/final`
- `/app/example-assets`
- `/app/example-output.json`

That gives you:
- durable stitched final videos
- durable example-output assets for the frontend demo tab

## Operational defaults

Suggested initial limits:
- `TTS_CONCURRENCY=2`
- `IMAGE_CONCURRENCY=1`
- `VIDEO_CONCURRENCY=2`
- `API_CONCURRENCY=5`

These are conservative enough for free-quota and retry safety, while still allowing the workflow to move.
