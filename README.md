# Short Drama Workflow Studio

Short Drama Workflow Studio is a production-oriented demo web app that turns one short drama brief into:
- a story plan and character bible
- one keyframe per scene
- one short video clip per scene through the official DashScope API
- scene-level narration audio
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
- show live workflow progress
- render prompts, shot cards, and final output
- save a completed run into `example-assets/`

## Current production decisions

- Official DashScope base URL: `https://dashscope-intl.aliyuncs.com`
- Official video endpoint: `POST /api/v1/services/aigc/video-generation/video-synthesis`
- Official task polling endpoint: `GET /api/v1/tasks/{task_id}`
- TTS model: `qwen3-tts-flash`
- Image model: `qwen-image`
- Video resolution target: `720P`
- Video duration target per request: `5s`
- Video fallback order:
  - `wan2.1-i2v-plus`
  - `wan2.1-i2v-turbo`
  - `wan2.2-i2v-flash`
  - `wan2.5-i2v-preview`
  - `wan2.6-i2v`
  - `wan2.6-i2v-flash`

Note: `wan2.2-i2v-plus` is intentionally excluded from the default fallback chain because the official docs do not list `720P` for that model. Mixing 1080P-only and 720P clips complicates final concat for no upside in this project.

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
IMAGE_MODEL=qwen-image
TTS_MODEL=qwen3-tts-flash
VIDEO_RESOLUTION=720P
VIDEO_DURATION_SECONDS=5
VIDEO_MODEL_SEQUENCE=wan2.1-i2v-plus,wan2.1-i2v-turbo,wan2.2-i2v-flash,wan2.5-i2v-preview,wan2.6-i2v,wan2.6-i2v-flash
TTS_CONCURRENCY=2
IMAGE_CONCURRENCY=1
VIDEO_CONCURRENCY=2
API_CONCURRENCY=5
```

## Saving a permanent example output

After a strong completed run:
1. click `Use This Run As Example Output`
2. the server copies media into `example-assets/`
3. the manifest is written to `example-output.json`
4. the `Example Output` tab then becomes frontend-backed and self-contained

## Smoke test script

```powershell
node run_pipeline.js
```

This submits one TTS request, one keyframe request, and one I2V request directly to DashScope using the same official endpoint family the app uses.

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the recommended production setup and platform comparison.
