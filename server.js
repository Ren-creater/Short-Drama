const http = require("http");
const { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require("fs/promises");
const { createReadStream, existsSync, readFileSync } = require("fs");
const { execFile } = require("child_process");
const { tmpdir } = require("os");
const { basename, extname, join, resolve } = require("path");

function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (_) {
    // Optional local convenience only.
  }
}

loadDotEnv();

const BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com").replace(/\/+$/, "");
const API_KEY = (process.env.DASHSCOPE_API_KEY || "").trim();
const REGION = (process.env.DASHSCOPE_REGION || "").trim();
const FORCE_ASYNC = (process.env.DASHSCOPE_ASYNC || "true").toLowerCase() !== "false";
const IS_LOCAL_GATEWAY = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?($|\/)/i.test(BASE_URL);
const KIMI_BASE_URL = (process.env.KIMI_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const KIMI_MODEL = (process.env.KIMI_MODEL || "moonshotai/kimi-k2.5").trim();
const KIMI_API_KEY = (process.env.KIMI_API_KEY || process.env.NVIDIA_API_KEY || "").trim();
const IMAGE_MODEL = (process.env.IMAGE_MODEL || "qwen-image").trim();
const TTS_MODEL = (process.env.TTS_MODEL || "qwen3-tts-flash").trim();
const VIDEO_RESOLUTION = (process.env.VIDEO_RESOLUTION || "720P").trim().toUpperCase();
const VIDEO_DURATION_SECONDS = Math.max(3, Number(process.env.VIDEO_DURATION_SECONDS || 5) || 5);
const VIDEO_MODEL_SEQUENCE = String(
  process.env.VIDEO_MODEL_SEQUENCE ||
  "wan2.1-i2v-plus,wan2.1-i2v-turbo,wan2.2-i2v-flash,wan2.5-i2v-preview,wan2.6-i2v,wan2.6-i2v-flash"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PORTABLE_FFMPEG_PATH = resolve(process.cwd(), ".runtime", "tools", "ffmpeg", "ffmpeg-8.1-essentials_build", "bin", "ffmpeg.exe");
const FFMPEG_PATH = (process.env.FFMPEG_PATH || PORTABLE_FFMPEG_PATH).trim();
const FINAL_OUTPUT_DIR = resolve(process.cwd(), ".runtime", "final");
const EXAMPLE_ASSETS_DIR = resolve(process.cwd(), "example-assets");
const EXAMPLE_OUTPUT_FILE = resolve(process.cwd(), "example-output.json");
const UPSTREAM_LIMITS = {
  tts: Math.max(1, Number(process.env.TTS_CONCURRENCY || 3) || 3),
  image: Math.max(1, Number(process.env.IMAGE_CONCURRENCY || 2) || 2),
  video: Math.max(1, Number(process.env.VIDEO_CONCURRENCY || 2) || 2),
  default: Math.max(1, Number(process.env.API_CONCURRENCY || 7) || 7),
};

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

const VIDEO_MODEL_CAPABILITIES = {
  "wan2.1-i2v-plus": {
    supportsDuration: false,
    silentDefault: true,
    supportedResolutions: ["480P", "720P"],
  },
  "wan2.1-i2v-turbo": {
    supportsDuration: true,
    silentDefault: true,
    supportedResolutions: ["480P", "720P"],
  },
  "wan2.2-i2v-flash": {
    supportsDuration: false,
    silentDefault: true,
    supportedResolutions: ["480P", "720P", "1080P"],
  },
  "wan2.5-i2v-preview": {
    supportsDuration: true,
    silentDefault: true,
    supportedResolutions: ["720P", "1080P"],
  },
  "wan2.6-i2v": {
    supportsDuration: true,
    silentDefault: false,
    supportedResolutions: ["720P", "1080P"],
  },
  "wan2.6-i2v-flash": {
    supportsDuration: true,
    supportsAudioFlag: true,
    silentDefault: false,
    supportedResolutions: ["720P", "1080P"],
  },
};

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(concurrency) {
  const limit = Math.max(1, Number(concurrency) || 1);
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= limit || !queue.length) return;
    const entry = queue.shift();
    active += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

const upstreamLimiters = {
  tts: createLimiter(UPSTREAM_LIMITS.tts),
  image: createLimiter(UPSTREAM_LIMITS.image),
  video: createLimiter(UPSTREAM_LIMITS.video),
  default: createLimiter(UPSTREAM_LIMITS.default),
};

function getLimiterKey(url) {
  if (url.includes("/multimodal-generation/generation")) return "tts";
  if (url.includes("/text2image/image-synthesis")) return "image";
  if (url.includes("/video-generation/video-synthesis") || url.includes("/image2video/video-synthesis")) return "video";
  return "default";
}

function shouldForceAsync(url) {
  if (!FORCE_ASYNC) return false;
  return (
    url.includes("/text2image/image-synthesis") ||
    url.includes("/video-generation/video-synthesis") ||
    url.includes("/image2video/video-synthesis")
  );
}

function getRetryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.max(1000, Number(retryAfter) * 1000);
  }
  return Math.min(8000, 1000 * Math.pow(2, attempt));
}

async function fetchWithRetry(url, options, maxAttempts = 2) {
  let response = null;
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await fetch(url, options);
      lastError = null;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1) {
        throw error;
      }
      await sleep(Math.min(8000, 1000 * Math.pow(2, attempt)));
      continue;
    }
    if (response.status !== 429 && response.status !== 503) {
      return response;
    }
    if (attempt === maxAttempts - 1) {
      return response;
    }
    await sleep(getRetryDelayMs(response, attempt));
  }
  if (lastError) {
    throw lastError;
  }
  return response;
}

async function callKimiStoryPlanner(payload) {
  const sceneCount = Number(payload?.scene_count || 8) || 8;
  const runtime = Number(payload?.runtime || 180) || 180;
  const brief = String(payload?.brief || "").trim();
  if (!brief) {
    throw new Error("brief is required");
  }

  const system = "You are a production screenplay planner for short drama generation. Return strict JSON only.";
  const user = [
    `Create ${sceneCount} scenes for a ${runtime}-second short drama.`,
    `Brief: ${brief}`,
    `Title: ${String(payload?.title || "").trim()}`,
    `Logline: ${String(payload?.logline || "").trim()}`,
    `Genre: ${String(payload?.genre || "").trim()}`,
    `Tone: ${String(payload?.tone || "").trim()}`,
    `Primary character: ${String(payload?.protagonist || "").trim()}`,
    `Secondary character: ${String(payload?.secondary || "").trim()}`,
    `Visual world: ${String(payload?.visualWorld || "").trim()}`,
    "Return JSON with this exact schema:",
    "{\"scenes\":[{\"title\":\"...\",\"purpose\":\"...\",\"summary\":\"...\",\"location\":\"...\",\"camera\":\"...\",\"emotion\":\"...\"}]}",
    "No markdown. No prose. JSON only."
  ].join("\n");

  const requestPayload = {
    model: KIMI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.4,
    top_p: 0.9,
    max_tokens: 2400,
    response_format: { type: "json_object" },
  };

  const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${KIMI_API_KEY}`,
    },
    body: JSON.stringify(requestPayload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Kimi HTTP ${response.status}: ${text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error("Kimi returned non-JSON response");
  }

  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Kimi response did not include message content");
  }

  let plan;
  try {
    plan = JSON.parse(content);
  } catch (_) {
    throw new Error("Kimi content was not valid JSON");
  }

  if (!Array.isArray(plan?.scenes) || !plan.scenes.length) {
    throw new Error("Kimi response missing scenes[]");
  }

  return {
    model: KIMI_MODEL,
    scenes: plan.scenes,
  };
}

async function ensureFfmpegAvailable() {
  try {
    await access(FFMPEG_PATH);
  } catch (_) {
    throw new Error(`FFmpeg binary not found at ${FFMPEG_PATH}`);
  }
}

async function downloadToFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, data);
}

function fileExtensionFromUrl(url, fallbackExt = "") {
  try {
    const parsed = new URL(String(url));
    const match = (parsed.pathname || "").match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : fallbackExt;
  } catch (_) {
    const clean = String(url || "").split("?")[0];
    const match = clean.match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : fallbackExt;
  }
}

async function persistExampleOutput(payload) {
  const manifest = payload && typeof payload === "object" ? JSON.parse(JSON.stringify(payload)) : null;
  if (!manifest) {
    throw new Error("Example output payload is required");
  }

  await rm(EXAMPLE_ASSETS_DIR, { recursive: true, force: true });
  await mkdir(EXAMPLE_ASSETS_DIR, { recursive: true });

  const saveAsset = async (sourceUrl, filenameBase, fallbackExt) => {
    if (!sourceUrl || typeof sourceUrl !== "string") return "";
    if (sourceUrl.startsWith("blob:")) {
      throw new Error(`Cannot persist browser blob URL for ${filenameBase}. Use server-side final assembly before saving example output.`);
    }
    const ext = fileExtensionFromUrl(sourceUrl, fallbackExt);
    const fileName = `${filenameBase}${ext}`;
    const outputPath = join(EXAMPLE_ASSETS_DIR, fileName);
    await downloadToFile(sourceUrl, outputPath);
    return `/example-assets/${fileName}`;
  };

  manifest.finalVideoUrl = await saveAsset(manifest.finalVideoUrl, "video", ".mp4");

  if (manifest.payload && typeof manifest.payload === "object") {
    manifest.payload.audioUrl = await saveAsset(manifest.payload.audioUrl, "audio", ".wav");
  }

  if (Array.isArray(manifest.scenes)) {
    for (const scene of manifest.scenes) {
      const sceneNumber = Number(scene?.sceneNumber || 0) || 0;
      if (!sceneNumber) continue;
      scene.keyframeUrl = await saveAsset(scene.keyframeUrl, `scene-${sceneNumber}-image`, ".png");
      scene.videoUrl = await saveAsset(scene.videoUrl, `scene-${sceneNumber}-video`, ".mp4");
    }
  }

  manifest.savedAt = new Date().toISOString();
  await writeFile(EXAMPLE_OUTPUT_FILE, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error((stderr || stdout || error.message || "ffmpeg failed").trim()));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function assembleFinalVideo(payload) {
  const clipUrls = Array.isArray(payload?.clip_urls) ? payload.clip_urls.filter((value) => typeof value === "string" && value.trim()) : [];
  const sceneAudioUrls = Array.isArray(payload?.scene_audio_urls)
    ? payload.scene_audio_urls.filter((value) => typeof value === "string" && value.trim())
    : [];
  const sceneDurations = Array.isArray(payload?.scene_durations)
    ? payload.scene_durations.map((value) => Math.max(1, Number(value) || 0))
    : [];
  if (!clipUrls.length || !sceneAudioUrls.length) {
    throw new Error("clip_urls[] and scene_audio_urls[] are required");
  }
  if (clipUrls.length !== sceneAudioUrls.length) {
    throw new Error("clip_urls[] and scene_audio_urls[] must have the same length");
  }
  if (sceneDurations.length && sceneDurations.length !== clipUrls.length) {
    throw new Error("scene_durations[] must match clip_urls[] length");
  }

  await ensureFfmpegAvailable();
  await mkdir(FINAL_OUTPUT_DIR, { recursive: true });

  const workDir = await mkdtemp(join(tmpdir(), "short-drama-assemble-"));
  const outputName = `final-${Date.now()}.mp4`;
  const outputPath = join(FINAL_OUTPUT_DIR, outputName);

  try {
    const clipFiles = [];
    const audioFiles = [];
    for (const [index, clipUrl] of clipUrls.entries()) {
      const clipPath = join(workDir, `clip-${index + 1}.mp4`);
      await downloadToFile(clipUrl, clipPath);
      clipFiles.push(clipPath);
      const audioPath = join(workDir, `audio-${index + 1}.wav`);
      await downloadToFile(sceneAudioUrls[index], audioPath);
      audioFiles.push(audioPath);
    }

    const muxedFiles = [];
    const paddedAudioFiles = [];
    for (const [index, clipPath] of clipFiles.entries()) {
      const targetDuration = sceneDurations[index] || VIDEO_DURATION_SECONDS;
      const muxedPath = join(workDir, `muxed-${index + 1}.mp4`);
      await execFileAsync(FFMPEG_PATH, [
        "-y",
        "-stream_loop", "-1",
        "-i", clipPath,
        "-i", audioFiles[index],
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-af", "apad",
        "-c:a", "aac",
        "-ar", "24000",
        "-t", String(targetDuration),
        muxedPath,
      ], { windowsHide: true });
      muxedFiles.push(muxedPath);

      const paddedAudioPath = join(workDir, `narration-${index + 1}.wav`);
      await execFileAsync(FFMPEG_PATH, [
        "-y",
        "-i", audioFiles[index],
        "-af", "apad",
        "-t", String(targetDuration),
        "-c:a", "pcm_s16le",
        paddedAudioPath,
      ], { windowsHide: true });
      paddedAudioFiles.push(paddedAudioPath);
    }

    const concatPath = join(workDir, "clips.txt");
    const concatBody = muxedFiles
      .map((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `file '${normalizedPath}'`;
      })
      .join("\n");
    await writeFile(concatPath, concatBody, "utf8");

    const audioConcatPath = join(workDir, "audio.txt");
    const audioConcatBody = paddedAudioFiles
      .map((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `file '${normalizedPath}'`;
      })
      .join("\n");
    await writeFile(audioConcatPath, audioConcatBody, "utf8");

    const outputAudioName = `audio-${Date.now()}.wav`;
    const outputAudioPath = join(FINAL_OUTPUT_DIR, outputAudioName);
    await execFileAsync(FFMPEG_PATH, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", audioConcatPath,
      "-c:a", "pcm_s16le",
      outputAudioPath,
    ], { windowsHide: true });

    await execFileAsync(FFMPEG_PATH, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatPath,
      "-c", "copy",
      outputPath,
    ], { windowsHide: true });

    return {
      url: `/.runtime/final/${basename(outputPath)}`,
      audio_url: `/.runtime/final/${basename(outputAudioPath)}`,
      path: outputPath,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function proxyMediaFetch(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only absolute http/https URLs are supported");
  }
  const response = await fetchWithRetry(url, {}, 3);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    buffer,
    contentType: response.headers.get("content-type") || "application/octet-stream",
  };
}

function toAbsoluteUpstreamMediaUrl(url) {
  if (!url || typeof url !== "string") return "";
  if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
  if (url.startsWith("/")) {
    return `${BASE_URL.replace(/\/+$/, "")}${url}`;
  }
  return url;
}

function shouldInlineVideoImage(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("data:")) return false;
  const absUrl = toAbsoluteUpstreamMediaUrl(url);
  return /\/result\//i.test(absUrl) && IS_LOCAL_GATEWAY;
}

async function rewriteVideoPayloadForGateway(bodyBuffer) {
  if (!bodyBuffer?.length) return bodyBuffer;
  let payload;
  try {
    payload = JSON.parse(bodyBuffer.toString("utf8"));
  } catch (_) {
    return bodyBuffer;
  }

  const imageUrl = payload?.input?.image_url;
  if (!shouldInlineVideoImage(imageUrl)) {
    return bodyBuffer;
  }

  const targetUrl = toAbsoluteUpstreamMediaUrl(imageUrl);
  const media = await proxyMediaFetch(targetUrl);
  const dataUrl = `data:${media.contentType};base64,${media.buffer.toString("base64")}`;
  payload.input.image_url = dataUrl;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (req.url === "/api/health") {
    const payload = {
      ok: IS_LOCAL_GATEWAY || Boolean(API_KEY),
      region: REGION,
      base_url: BASE_URL,
      ffmpeg: {
        available: existsSync(FFMPEG_PATH),
        path: FFMPEG_PATH,
      },
      llm: {
        enabled: Boolean(KIMI_API_KEY),
        provider: "nvidia",
        model: KIMI_MODEL,
      },
      runtime: {
        mode: IS_LOCAL_GATEWAY ? "local-gateway" : "official-api",
        dashscope_endpoint: BASE_URL,
        image_model: IMAGE_MODEL,
        tts_model: TTS_MODEL,
        video_resolution: VIDEO_RESOLUTION,
        video_duration_seconds: VIDEO_DURATION_SECONDS,
        video_model_sequence: VIDEO_MODEL_SEQUENCE,
        video_model_capabilities: VIDEO_MODEL_CAPABILITIES,
      },
      upstream_limits: UPSTREAM_LIMITS,
      message: IS_LOCAL_GATEWAY
        ? "Local gateway proxy ready"
        : API_KEY
          ? "DashScope proxy ready"
          : "Missing DASHSCOPE_API_KEY",
    };
    const body = JSON.stringify(payload);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  if (req.url === "/api/local/assemble" && req.method === "POST") {
    try {
      const payload = await readJsonRequest(req);
      const result = await assembleFinalVideo(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/local/example-output" && req.method === "POST") {
    try {
      const payload = await readJsonRequest(req);
      const persisted = await persistExampleOutput(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        path: EXAMPLE_OUTPUT_FILE,
        assets_dir: EXAMPLE_ASSETS_DIR,
        finalVideoUrl: persisted.finalVideoUrl,
      }));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url.startsWith("/api/local/fetch-media") && req.method === "GET") {
    try {
      const requestUrl = new URL(req.url, "http://localhost");
      const targetUrl = requestUrl.searchParams.get("url") || "";
      const result = await proxyMediaFetch(targetUrl);
      res.writeHead(200, { "Content-Type": result.contentType });
      res.end(result.buffer);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url === "/api/local/story-plan" && req.method === "POST") {
    if (!KIMI_API_KEY) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing KIMI_API_KEY" }));
      return;
    }

    try {
      const payload = await readJsonRequest(req);
      const result = await callKimiStoryPlanner(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
    return;
  }

  if (req.url.startsWith("/api/") || req.url.startsWith("/result/")) {
    if (!IS_LOCAL_GATEWAY && !API_KEY) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing DASHSCOPE_API_KEY" }));
      return;
    }

    const upstream = `${BASE_URL}${req.url}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = chunks.length ? Buffer.concat(chunks) : undefined;

    const headers = {
      "Content-Type": req.headers["content-type"] || "application/json",
    };
    if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
    if (shouldForceAsync(req.url)) headers["X-DashScope-Async"] = "enable";

    const limiter = upstreamLimiters[getLimiterKey(req.url)] || upstreamLimiters.default;
    try {
      const upstreamResp = await limiter(() => fetchWithRetry(upstream, {
        method: req.method,
        headers,
        body,
      }, 3));

      const respBody = Buffer.from(await upstreamResp.arrayBuffer());
      res.writeHead(upstreamResp.status, {
        "Content-Type": upstreamResp.headers.get("content-type") || "application/json",
      });
      res.end(respBody);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "Upstream request failed",
        message: String(error?.message || error),
        code: error?.code || "",
      }));
    }
    return;
  }

  const filePath = req.url === "/" ? "index.html" : req.url.slice(1);
  const resolved = join(process.cwd(), filePath);
  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(resolved)] || "application/octet-stream" });
    createReadStream(resolved).pipe(res);
  } catch (_) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Short Drama Studio running on http://localhost:${port}`);
});
