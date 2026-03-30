# Short Drama Workflow Studio

Short Drama Workflow Studio is a production-oriented web app that turns one short drama brief into:
- a story plan and character bible
- one keyframe per planned shot
- one native-audio video clip per planned shot through the official DashScope API
- a final stitched MP4 with audio
- a permanent example-output snapshot for the frontend

## Production shape

This repo is now designed around the official DashScope API, not the local cluster gateway.

Backend responsibilities:
- keep API keys server-side
- proxy official DashScope requests
- apply rate limits
- choose video model fallbacks when one model is unavailable or out of free quota
- assemble the final MP4 with FFmpeg
- save permanent example-output assets

Frontend responsibilities:
- collect one brief
- run the full production pipeline
- show live workflow progress
- render shot cards and final output
- save a completed run into `example-assets/`

## Shipped UI

The frontend now ships in one production mode only:
- `Production · 180s`
- `1280x720`
- 12 stitched 15-second clips with native audio

Planner-only and one-shot validation flows still exist in the codebase for internal testing, but they are no longer exposed in the main UI.

## Spend guard

The server now enforces a persistent production run cap before any paid workflow starts.

- Default cap: `MAX_PRODUCTION_RUNS=3`
- State file: `.runtime/run-guard.json`
- Enforcement point: the frontend must reserve a server-issued run token before Kimi planning or DashScope media calls begin

Once the cap is reached, the production button is disabled and new runs are blocked until the cap is raised or the guard file is reset intentionally.

## Current production decisions

- Official DashScope base URL: `https://dashscope-intl.aliyuncs.com`
- Official video endpoint: `POST /api/v1/services/aigc/video-generation/video-synthesis`
- Official task polling endpoint: `GET /api/v1/tasks/{task_id}`
- Image fallback order on the current async path:
  - `qwen-image-plus`
  - `qwen-image`
- Video resolution target: `720P`
- Video duration target per request: `15s`
- Video fallback order:
  - `wan2.6-i2v`
  - `wan2.6-i2v-flash`
- Audio strategy: rely on Wan 2.6 native diegetic audio in the returned video clip, not a separate TTS narration track

## Local run

1. Create an env file from the template:

```powershell
cd c:\Users\ren\Downloads\Short-Drama
Copy-Item .env.example .env
```

2. Set real secrets in `.env` or your shell:

```powershell
$env:DASHSCOPE_API_KEY="<dashscope key>"
$env:KIMI_API_KEY="<nvidia kimi key>"
```

3. Start the app:

```powershell
node server.js
```

4. Open:

```text
http://localhost:3000
```

## Docker run

```powershell
docker build -t short-drama-studio .
docker run --rm -p 3000:3000 --env-file .env short-drama-studio
```

The container includes FFmpeg, so final assembly works in the same way as production.

## Required production environment variables

```text
DASHSCOPE_API_KEY
DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com
KIMI_API_KEY
KIMI_MODEL=moonshotai/kimi-k2.5
KIMI_REQUEST_TIMEOUT_MS=60000
KIMI_RETRY_DELAY_MS=2500
KIMI_SCENE_BATCH_SIZE=2
IMAGE_MODEL=qwen-image-plus
IMAGE_MODEL_SEQUENCE=qwen-image-plus,qwen-image
VIDEO_RESOLUTION=720P
VIDEO_DURATION_SECONDS=15
MAX_PRODUCTION_RUNS=3
PERSIST_ROOT=/app/persist
VIDEO_MODEL_SEQUENCE=wan2.6-i2v,wan2.6-i2v-flash
IMAGE_CONCURRENCY=1
VIDEO_CONCURRENCY=2
API_CONCURRENCY=5
```

## Saving a permanent example output

After a strong completed run:
1. click `Save As Example Output`
2. the server copies media into `example-assets/`
3. the manifest is written into `example-assets/` and served at `/example-output.json`
4. the `Example Output` tab then becomes frontend-backed and self-contained

This capture control is intended for development only. In the default production configuration, the button is hidden unless `ENABLE_EXAMPLE_CAPTURE=true`.

## Smoke test script

```powershell
node run_pipeline.js
```

This submits one keyframe request and one native-audio I2V request directly to DashScope using the same official endpoint family the app uses.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the recommended production setup and platform comparison.

