const http = require("http");
const { randomUUID } = require("crypto");
const { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } = require("fs/promises");
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

function parseModelSequence(value) {
  const seen = new Set();
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

const BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com").replace(/\/+$/, "");
const API_KEY = (process.env.DASHSCOPE_API_KEY || "").trim();
const REGION = (process.env.DASHSCOPE_REGION || "").trim();
const FORCE_ASYNC = (process.env.DASHSCOPE_ASYNC || "true").toLowerCase() !== "false";
const IS_LOCAL_GATEWAY = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?($|\/)/i.test(BASE_URL);
const KIMI_BASE_URL = (process.env.KIMI_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const KIMI_MODEL = (process.env.KIMI_MODEL || "moonshotai/kimi-k2.5").trim();
const KIMI_API_KEY = (process.env.KIMI_API_KEY || process.env.NVIDIA_API_KEY || "").trim();
const IMAGE_MODEL_SEQUENCE = parseModelSequence(process.env.IMAGE_MODEL_SEQUENCE || "qwen-image-plus,qwen-image");
const IMAGE_MODEL = IMAGE_MODEL_SEQUENCE[0] || (process.env.IMAGE_MODEL || "qwen-image-plus").trim();
const VIDEO_RESOLUTION = (process.env.VIDEO_RESOLUTION || "720P").trim().toUpperCase();
const VIDEO_DURATION_SECONDS = Math.max(5, Number(process.env.VIDEO_DURATION_SECONDS || 15) || 15);
const ENABLE_EXAMPLE_CAPTURE = (process.env.ENABLE_EXAMPLE_CAPTURE || "").toLowerCase() === "true";
const MAX_PRODUCTION_RUNS = (() => {
  const parsed = Number(process.env.MAX_PRODUCTION_RUNS || 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(0, Math.floor(parsed));
})();
const VIDEO_MODEL_SEQUENCE = parseModelSequence(
  process.env.VIDEO_MODEL_SEQUENCE ||
  "wan2.6-i2v,wan2.6-i2v-flash"
);
const APP_ROOT = resolve(process.cwd());
const PERSIST_ROOT = resolve(process.env.PERSIST_ROOT || APP_ROOT);
const PORTABLE_FFMPEG_PATH = resolve(APP_ROOT, ".runtime", "tools", "ffmpeg", "ffmpeg-8.1-essentials_build", "bin", "ffmpeg.exe");
const FFMPEG_PATH = (process.env.FFMPEG_PATH || PORTABLE_FFMPEG_PATH).trim();
const RUNTIME_DIR = resolve(PERSIST_ROOT, ".runtime");
const RUN_GUARD_FILE = resolve(RUNTIME_DIR, "run-guard.json");
const FINAL_OUTPUT_DIR = resolve(RUNTIME_DIR, "final");
const EXAMPLE_ASSETS_DIR = resolve(PERSIST_ROOT, "example-assets");
const EXAMPLE_OUTPUT_FILE = resolve(APP_ROOT, "example-output.json");
const PERSISTED_EXAMPLE_OUTPUT_FILE = resolve(EXAMPLE_ASSETS_DIR, "example-output.json");
const BUNDLED_EXAMPLE_ASSETS_DIR = resolve(APP_ROOT, "example-assets");
const KIMI_REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.KIMI_REQUEST_TIMEOUT_MS || 60000) || 60000);
const KIMI_RETRY_DELAY_MS = Math.max(1000, Number(process.env.KIMI_RETRY_DELAY_MS || 2500) || 2500);
const KIMI_SCENE_BATCH_SIZE = Math.max(1, Number(process.env.KIMI_SCENE_BATCH_SIZE || 2) || 2);
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

function normalizeRunGuardState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const activeTokens = source.activeTokens && typeof source.activeTokens === "object"
    ? Object.fromEntries(
      Object.entries(source.activeTokens)
        .filter(([token, meta]) => typeof token === "string" && token.trim() && meta && typeof meta === "object")
        .map(([token, meta]) => [token, { createdAt: String(meta.createdAt || "") }])
    )
    : {};
  return {
    version: 1,
    reservedRuns: Math.max(0, Number(source.reservedRuns || 0) || 0),
    activeTokens,
  };
}

async function readRunGuardState() {
  try {
    const raw = await readFile(RUN_GUARD_FILE, "utf8");
    return normalizeRunGuardState(JSON.parse(raw));
  } catch (_) {
    return normalizeRunGuardState(null);
  }
}

async function writeRunGuardState(state) {
  await mkdir(RUNTIME_DIR, { recursive: true });
  await writeFile(RUN_GUARD_FILE, JSON.stringify(normalizeRunGuardState(state), null, 2), "utf8");
}

async function ensurePersistentStorageSeed() {
  if (PERSIST_ROOT === APP_ROOT) {
    await mkdir(RUNTIME_DIR, { recursive: true });
    await mkdir(EXAMPLE_ASSETS_DIR, { recursive: true });
    return;
  }

  await mkdir(RUNTIME_DIR, { recursive: true });
  await mkdir(EXAMPLE_ASSETS_DIR, { recursive: true });

  if (existsSync(BUNDLED_EXAMPLE_ASSETS_DIR)) {
    await cp(BUNDLED_EXAMPLE_ASSETS_DIR, EXAMPLE_ASSETS_DIR, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }

  if (!existsSync(PERSISTED_EXAMPLE_OUTPUT_FILE) && existsSync(EXAMPLE_OUTPUT_FILE)) {
    await writeFile(PERSISTED_EXAMPLE_OUTPUT_FILE, await readFile(EXAMPLE_OUTPUT_FILE));
  }
}

function resolveExampleAssetPath(assetUrl) {
  if (!assetUrl || typeof assetUrl !== "string") return "";
  if (!assetUrl.startsWith("/example-assets/")) return "";
  const assetPath = resolve(EXAMPLE_ASSETS_DIR, assetUrl.slice("/example-assets/".length));
  if (!assetPath.startsWith(EXAMPLE_ASSETS_DIR)) return "";
  return assetPath;
}

function sanitizeExampleOutputForPublic(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  const scenes = Array.isArray(clone.scenes) ? clone.scenes : [];
  for (const scene of scenes) {
    if (!scene || typeof scene !== "object") continue;
    const keyframePath = resolveExampleAssetPath(scene.keyframeUrl);
    const videoPath = resolveExampleAssetPath(scene.videoUrl);
    if (scene.keyframeUrl && keyframePath && !existsSync(keyframePath)) {
      scene.keyframeUrl = "";
    }
    if (scene.videoUrl && videoPath && !existsSync(videoPath)) {
      scene.videoUrl = "";
      if (String(scene.videoStatus || "").toLowerCase() === "ready") {
        scene.videoStatus = "pending";
      }
    }
  }
  return clone;
}

function summarizeRunGuard(state) {
  const used = Math.max(0, Number(state?.reservedRuns || 0) || 0);
  const remaining = Math.max(0, MAX_PRODUCTION_RUNS - used);
  return {
    enabled: true,
    max_runs: MAX_PRODUCTION_RUNS,
    used_runs: used,
    remaining_runs: remaining,
    exhausted: remaining <= 0,
  };
}

async function reserveProductionRun() {
  const state = await readRunGuardState();
  const summary = summarizeRunGuard(state);
  if (summary.exhausted) {
    const error = new Error(`Production run limit reached (${summary.used_runs}/${summary.max_runs}). New runs are blocked.`);
    error.statusCode = 403;
    throw error;
  }
  const token = randomUUID();
  state.reservedRuns = summary.used_runs + 1;
  state.activeTokens[token] = { createdAt: new Date().toISOString() };
  await writeRunGuardState(state);
  return {
    token,
    ...summarizeRunGuard(state),
  };
}

async function validateRunToken(token) {
  if (!token || typeof token !== "string") return false;
  const state = await readRunGuardState();
  return Boolean(state.activeTokens[token]);
}

function isWorkflowSpendPath(url) {
  return url === "/api/local/story-plan"
    || url.includes("/text2image/image-synthesis")
    || url.includes("/video-generation/video-synthesis")
    || url.includes("/image2video/video-synthesis");
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

  const useCompactProductionPlanner = sceneCount >= 8;
  const approxSecondsPerShot = Math.max(2, Math.round(runtime / sceneCount));
  const schema = "{\"story\":{\"title\":\"...\",\"logline\":\"...\",\"genre\":\"...\",\"tone\":\"...\",\"visualWorld\":\"...\",\"primary\":\"...\",\"secondary\":\"...\"},\"scenes\":[{\"title\":\"...\",\"purpose\":\"...\",\"summary\":\"...\",\"location\":\"...\",\"camera\":\"...\",\"emotion\":\"...\",\"audio\":\"...\"}]}";
  const compactSchema = "{\"story\":{\"title\":\"...\",\"logline\":\"...\",\"genre\":\"...\",\"tone\":\"...\",\"visualWorld\":\"...\",\"primary\":\"...\",\"secondary\":\"...\"},\"scenes\":[{\"prompt\":\"...\",\"audio\":\"...\"}]}";
  const normalTokenBudget = Math.max(1200, Math.min(3000, 260 * sceneCount));
  const relaxedTokenBudget = Math.max(1000, Math.min(2600, 220 * sceneCount));
  const strictTokenBudget = Math.max(900, Math.min(2200, 180 * sceneCount));
  const compactProductionTokenBudget = Math.max(5000, Math.min(6500, 350 * sceneCount + 1000));
  const plannerTimeoutMs = Math.max(KIMI_REQUEST_TIMEOUT_MS, useCompactProductionPlanner ? 240000 : 120000);
  const plannerExample = JSON.stringify({
    story: {
      title: "Last Light",
      logline: "A lone lighthouse keeper saves an injured gull before the storm swallows the coast.",
      genre: "Poetic Drama",
      tone: "Lonely, tender",
      visualWorld: "Salt-dark coast, lantern glow, wet stone",
      primary: "Lighthouse keeper",
      secondary: "Injured gull"
    },
    scenes: [
      {
        title: "Storm Glass",
        purpose: "Establish isolation and danger",
        summary: "Keeper spots the gull through rain and rushes down the slick spiral stairs.",
        location: "Lighthouse stairwell",
        camera: "handheld descent",
        emotion: "urgent concern",
        audio: "Wind, rain, metal steps"
      },
      {
        title: "Lantern Warmth",
        purpose: "Resolve with fragile trust",
        summary: "Inside the lamp room, keeper wraps the gull in cloth as dawn softens the sea.",
        location: "Lantern room",
        camera: "close two-shot",
        emotion: "quiet relief",
        audio: "Soft surf, cloth rustle, calm breath"
      }
    ]
  });
  const compactPlannerExample = JSON.stringify({
    story: {
      title: "Last Light",
      logline: "A lone lighthouse keeper saves an injured gull as a storm closes over the coast.",
      genre: "Poetic Drama",
      tone: "Lonely, tender",
      visualWorld: "Salt-dark coast, lantern glow, wet stone",
      primary: "Lighthouse keeper",
      secondary: "Injured gull"
    },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      prompt: `Example scene ${index + 1}: concrete coast action beat ${index + 1}, cinematic realism, continuity preserved.`,
      audio: index < Math.ceil(sceneCount * 0.66) ? "Wind, rain, distant surf" : "Soft surf, calm wind, breath"
    }))
  });
  const storyRepairExampleInput = JSON.stringify({
    title: "Something evocative about loss/light",
    logline: "One sentence about hope after the storm",
    genre: "Drama/Poetry/Survival",
    tone: "Sad, but uplifting",
    visualWorld: "storm coast",
    primary: "",
    secondary: ""
  });
  const storyRepairExampleOutput = JSON.stringify({
    title: "Last Light",
    logline: "A lone keeper saves an injured gull as dawn returns to the storm coast.",
    genre: "Poetic Drama",
    tone: "Lonely, hopeful",
    visualWorld: "Salt-dark coast, lantern glow, wet stone",
    primary: "Lighthouse keeper",
    secondary: "Injured gull"
  });
  const sceneBatchSchema = "{\"scenes\":[{\"title\":\"...\",\"purpose\":\"...\",\"summary\":\"...\",\"location\":\"...\",\"camera\":\"...\",\"emotion\":\"...\",\"audio\":\"...\"}]}";

  const cleanField = (value, fallback = "") => {
    let text = String(value || fallback)
      .replace(/\s+/g, " ")
      .trim();
    const letsUseMatches = [...text.matchAll(/let'?s use\s+"([^"]{1,120})"/gi)];
    if (letsUseMatches.length) {
      text = letsUseMatches[letsUseMatches.length - 1][1];
    }
    text = text
      .replace(/^["'`“”]+|["'`“”]+$/g, "")
      .replace(/^max\s+\d+\s+words?\s*[-:]?\s*/gi, "")
      .replace(/^ok\s*[-:.]?\s*/gi, "")
      .replace(/\s*\(\d+\s+words?\)[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*ok\b[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*good\b[^.,;:!?)]*/gi, "")
      .replace(/\s*or\s+"[^"]{1,120}"/gi, "")
      .replace(/^[^"]{0,40}"([^"]{1,120})"[^"]*$/i, "$1")
      .replace(/[)"'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  };

  const normalizeField = (value, fallback = "") => {
    const text = cleanField(value, fallback);
    if (/^(string|number|boolean|array|object|null|undefined|n\/a|na|\.\.\.)$/i.test(text)) {
      return cleanField(fallback, "");
    }
    return text;
  };

  const isInstructionLikeStoryField = (text) => {
    const value = String(text || "").trim();
    if (!value) return false;
    return /something\s+(?:\w+\s+)*(?:like|about)|one\s+sentence(?:\s+\w+)*|or\s+just|max\s+\d+\s+words?|^example\b|^placeholder\b|for\s+example|capturing\s+the\s+essence/i.test(value);
  };

  const normalizeStoryField = (value, fallback = "") => {
    const text = normalizeField(value, fallback);
    if (isInstructionLikeStoryField(text)) {
      return normalizeField(fallback, "");
    }
    return text;
  };

  const hasUsableStoryPackage = (story) => {
    const candidate = story && typeof story === "object" ? story : {};
    const title = normalizeStoryField(candidate.title, "");
    const logline = normalizeStoryField(candidate.logline, "");
    const genre = normalizeStoryField(candidate.genre, "");
    const briefLower = brief.toLowerCase().trim();
    const titleLower = title.toLowerCase().trim();
    const loglineLower = logline.toLowerCase().trim();
    const titleIsRawBrief = Boolean(titleLower && briefLower && titleLower === briefLower);
    const loglineIsRawBrief = Boolean(loglineLower && briefLower && loglineLower === briefLower);
    const genreLooksPlaceholderList = /.+\/.+\/.+/.test(genre) || /\bor\b/i.test(genre);
    return Boolean(title && logline && !titleIsRawBrief && !loglineIsRawBrief && !genreLooksPlaceholderList);
  };

  const buildTitleFromScenes = (scenes) => {
    const usableTitles = (Array.isArray(scenes) ? scenes : [])
      .map((scene) => normalizeField(scene?.title, ""))
      .filter((title) => title && !/^beat\s+\d+$/i.test(title) && !/^scene\s+\d+$/i.test(title));
    if (!usableTitles.length) return "";
    const first = usableTitles[0];
    const second = usableTitles[1];
    if (!second || first.toLowerCase() === second.toLowerCase()) {
      return first;
    }
    const compact = `${first} / ${second}`;
    return compact.length <= 48 ? compact : first;
  };

  const normalizeSceneObject = (scene, index) => {
    const sharedPrompt = normalizeField(scene?.prompt, "");
    return {
      title: normalizeField(scene?.title, sharedPrompt ? "" : `Beat ${index + 1}`),
      purpose: normalizeField(scene?.purpose, sharedPrompt ? "" : "Advance story"),
      summary: normalizeField(scene?.summary || sharedPrompt, ""),
      location: normalizeField(scene?.location, sharedPrompt ? "" : "Story world"),
      camera: normalizeField(scene?.camera, sharedPrompt ? "" : "Cinematic framing"),
      emotion: normalizeField(scene?.emotion, sharedPrompt ? "" : "Tense"),
      audio: normalizeField(scene?.audio, ""),
      prompt: sharedPrompt
    };
  };

  const parseReasoningScenes = (reasoningText) => {
    const text = String(reasoningText || "").trim();
    if (!text) return [];
    const blocks = text
      .split(/(?:^|\n)\s*(?:Scene|Beat)\s+\d+\s*:/i)
      .slice(1);
    const scenes = blocks.map((block, index) => {
      const fields = {};
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:[-*]\s*)?(Title|Purpose|Summary|Prompt|Location|Camera|Emotion|Audio)\s*:\s*(.+?)\s*$/i);
        if (!match) continue;
        fields[match[1].toLowerCase()] = normalizeField(match[2]);
      }
      return {
        title: fields.title || `Beat ${index + 1}`,
        purpose: fields.purpose || "",
        summary: fields.summary || fields.prompt || "",
        location: fields.location || "",
        camera: fields.camera || "",
        emotion: fields.emotion || "",
        audio: fields.audio || ""
      };
    }).filter((scene) => scene.summary);
    return scenes.length >= sceneCount ? scenes.slice(0, sceneCount) : [];
  };

  const parseReasoningStory = (reasoningText) => {
    const text = String(reasoningText || "");
    const pick = (label) => {
      const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${label}\\s*:\\s*(.+?)\\s*(?=\\n|$)`, "i"));
      return normalizeStoryField(match?.[1] || "");
    };
    const title = pick("Title");
    const logline = pick("Logline") || brief;
    const genre = pick("Genre");
    const tone = pick("Tone");
    const visualWorld = pick("Visual world") || pick("World");
    const primary = pick("Primary character") || pick("Primary subject");
    const secondary = pick("Secondary character") || pick("Secondary subject");
    if (!title && !logline && !genre && !tone && !visualWorld && !primary && !secondary) {
      return null;
    }
    return { title, logline, genre, tone, visualWorld, primary, secondary };
  };

  const parsePlan = (text) => {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      throw new Error("Kimi returned non-JSON response");
    }

    const rawContent = parsed?.choices?.[0]?.message?.content;
    const content = typeof rawContent === "string"
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent
            .map((item) => {
              if (typeof item === "string") return item;
              if (typeof item?.text === "string") return item.text;
              if (typeof item?.content === "string") return item.content;
              return "";
            })
            .join("\n")
        : "";
    const reasoning = [
      parsed?.choices?.[0]?.message?.reasoning,
      parsed?.choices?.[0]?.message?.reasoning_content
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .trim();
    if (typeof content !== "string" || !content.trim()) {
      const rescuedScenes = parseReasoningScenes(reasoning);
      if (rescuedScenes.length) {
        return { story: parseReasoningStory(reasoning), scenes: rescuedScenes };
      }
      const error = new Error("Kimi response did not include message content");
      if (reasoning) {
        error.reasoning = reasoning;
      }
      throw error;
    }

    let plan;
    try {
      plan = JSON.parse(content);
    } catch (_) {
      const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fenced?.[1] || content;
      const firstBrace = candidate.indexOf("{");
      const lastBrace = candidate.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
          plan = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
        } catch (_) {
          const rescuedScenes = parseReasoningScenes(reasoning);
          if (rescuedScenes.length) {
            return { story: parseReasoningStory(reasoning), scenes: rescuedScenes };
          }
          const error = new Error("Kimi content was not valid JSON");
          if (reasoning) {
            error.reasoning = reasoning;
          }
          throw error;
        }
      } else {
        const rescuedScenes = parseReasoningScenes(reasoning);
        if (rescuedScenes.length) {
          return { story: parseReasoningStory(reasoning), scenes: rescuedScenes };
        }
        const error = new Error("Kimi content was not valid JSON");
        if (reasoning) {
          error.reasoning = reasoning;
        }
        throw error;
      }
    }
    const rawStory = plan?.story && typeof plan.story === "object" ? plan.story : {};
    const story = {
      title: normalizeStoryField(rawStory.title, brief),
      logline: normalizeStoryField(rawStory.logline, brief),
      genre: normalizeStoryField(rawStory.genre, ""),
      tone: normalizeStoryField(rawStory.tone, ""),
      visualWorld: normalizeStoryField(rawStory.visualWorld, ""),
      primary: normalizeStoryField(rawStory.primary, ""),
      secondary: normalizeStoryField(rawStory.secondary, "")
    };
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    return { story, scenes };
  };

  const postKimi = async (requestPayload, timeoutMs = plannerTimeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${KIMI_API_KEY}`,
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Kimi HTTP ${response.status}: ${text}`);
      }
      return text;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Kimi request timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const attemptCompactProductionPlanRequest = async () => {
    const requestPayload = {
      model: KIMI_MODEL,
      messages: [
        {
          role: "system",
          content: "Return JSON only. No markdown. No text before or after the JSON object."
        },
        {
          role: "user",
          content: [
            `Create exactly ${sceneCount} scenes for a ${runtime}-second short drama.`,
            `Story brief: ${brief}`,
            "Normalize the brief into a sensible concise story premise without asking questions.",
            "Each scene only needs one shared media prompt that both image and video generation can reuse, plus short diegetic audio guidance.",
            "Do not include scene title, purpose, location, camera, or emotion as separate fields; fold useful details into prompt.",
            "Each scene prompt should be concrete, cinematic, and continuity-safe. Avoid generic planner language.",
            `Example of a good final JSON answer: ${compactPlannerExample}`,
            `Return exactly this JSON schema and nothing else: ${compactSchema}`
          ].join("\n")
        }
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: compactProductionTokenBudget,
      extra_body: { thinking: { type: "disabled" } }
    };
    const text = await postKimi(requestPayload, plannerTimeoutMs);
    return parsePlan(text);
  };

  const attemptPlanRequest = async ({ strict, useResponseFormat = true, maxTokensOverride = 0, systemOverride = "", userOverride = "" }) => {
    const system = systemOverride || (strict
      ? "Return JSON only. No markdown. No text before or after the JSON object."
      : "You are a short-drama shot planner. Return JSON only.");
    const user = userOverride || (strict
      ? [
          `Create exactly ${sceneCount} visual beats for a ${runtime}-second short drama.`,
          `Each beat should cover about ${approxSecondsPerShot} seconds.`,
          `Story brief: ${brief}`,
          "The brief may be vague, fragmentary, surreal, or low-quality. Normalize it into a sensible concise story premise without asking questions.",
          "Also derive a compact story package from the brief.",
          "story.title max 6 words; story.logline max 24 words; story.genre max 3 words; story.tone max 4 words; story.visualWorld max 14 words; story.primary max 12 words; story.secondary max 12 words.",
          "Keep all fields short and practical for image/video generation.",
          "title max 5 words; purpose max 10 words; summary max 20 words; location max 6 words; camera max 6 words; emotion max 3 words; audio max 12 words.",
          `Example of a good final JSON answer: ${plannerExample}`,
          `Return exactly this JSON schema and nothing else: ${schema}`
        ].filter(Boolean).join("\n")
      : [
          `Create ${sceneCount} visual beats for a ${runtime}-second short drama.`,
          `Each beat should cover about ${approxSecondsPerShot} seconds.`,
          `Story brief: ${brief}`,
          "The brief may be vague, fragmentary, surreal, or low-quality. Normalize it into a sensible concise story premise without asking questions.",
          "Also derive a compact story package from the brief.",
          `Good example: ${plannerExample}`,
          `Return JSON with this exact schema only: ${schema}`,
          "Keep all fields short and cinematic."
        ].filter(Boolean).join("\n"));

    const requestPayload = {
      model: KIMI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: strict ? 0.2 : 0.4,
      top_p: 0.95,
      max_tokens: maxTokensOverride || (strict ? normalTokenBudget : Math.max(normalTokenBudget, 1400)),
      extra_body: { thinking: { type: "disabled" } },
    };
    if (useResponseFormat) {
      requestPayload.response_format = { type: "json_object" };
    }
    const text = await postKimi(requestPayload);
    return parsePlan(text);
  };

  const attemptReasoningRescue = async (reasoningText) => {
    const condensedReasoning = String(reasoningText || "").replace(/\s+/g, " ").trim().slice(0, 5000);
    if (!condensedReasoning) {
      throw new Error("Kimi reasoning rescue had no usable reasoning text");
    }
    return attemptPlanRequest({
      strict: true,
      useResponseFormat: true,
      maxTokensOverride: relaxedTokenBudget,
      systemOverride: "Convert the planning notes into the exact JSON schema. Return JSON only.",
      userOverride: [
        `Convert the following short-drama planning notes into exactly ${sceneCount} scenes and a compact story package using this schema: ${schema}`,
        "Use only the information already present in the notes.",
        "Keep every field short.",
        "title: max 5 words",
        "purpose: max 10 words",
        "summary: max 20 words",
        "location: max 6 words",
        "camera: max 6 words",
        "emotion: max 3 words",
        "audio: max 12 words",
        "Return JSON only.",
        `Planning notes: ${condensedReasoning}`
      ].join("\n")
    });
  };

  const attemptStoryRepair = async (story, scenes) => {
    const condensedScenes = (Array.isArray(scenes) ? scenes : []).slice(0, sceneCount).map((scene, index) => {
      const safe = scene && typeof scene === "object" ? scene : {};
      return [
        `Scene ${index + 1}`,
        `title=${normalizeField(safe.title, `Beat ${index + 1}`)}`,
        `purpose=${normalizeField(safe.purpose, "Advance story")}`,
        `summary=${normalizeField(safe.summary || safe.prompt, "")}`,
        `location=${normalizeField(safe.location, "Story world")}`,
        `emotion=${normalizeField(safe.emotion, "Tense")}`
      ].join(" | ");
    }).join("\n");

    const repairPayload = {
      model: KIMI_MODEL,
      messages: [
        {
          role: "system",
          content: "Return JSON only. No markdown. Build only a compact story package from the brief and scene beats."
        },
        {
          role: "user",
          content: [
            "Return only this JSON object schema:",
            "{\"title\":\"...\",\"logline\":\"...\",\"genre\":\"...\",\"tone\":\"...\",\"visualWorld\":\"...\",\"primary\":\"...\",\"secondary\":\"...\"}",
            `Brief: ${brief}`,
            "The existing story fields may contain placeholder or editorial text. Replace them with clean final values.",
            `Bad draft example: ${storyRepairExampleInput}`,
            `Good repaired example: ${storyRepairExampleOutput}`,
            `Existing story draft: ${JSON.stringify(story || {})}`,
            `Scene beats:\n${condensedScenes}`,
            "Keep values concise and usable for image/video generation.",
            "title max 6 words; logline max 24 words; genre max 3 words; tone max 4 words; visualWorld max 14 words; primary max 12 words; secondary max 12 words."
          ].join("\n")
        }
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: relaxedTokenBudget,
      response_format: { type: "json_object" },
      extra_body: { thinking: { type: "disabled" } }
    };

    try {
      const text = await postKimi(repairPayload);
      const parsed = JSON.parse(text);
      const content = typeof parsed?.choices?.[0]?.message?.content === "string"
        ? parsed.choices[0].message.content
        : "";
      if (!content.trim()) {
        throw new Error("Kimi story repair returned empty content");
      }
      const repaired = JSON.parse(content);
      return {
        title: normalizeStoryField(repaired?.title, ""),
        logline: normalizeStoryField(repaired?.logline, ""),
        genre: normalizeStoryField(repaired?.genre, ""),
        tone: normalizeStoryField(repaired?.tone, ""),
        visualWorld: normalizeStoryField(repaired?.visualWorld, ""),
        primary: normalizeStoryField(repaired?.primary, ""),
        secondary: normalizeStoryField(repaired?.secondary, "")
      };
    } finally {}
  };

  const attemptStoryOnlyRequest = async () => {
    const requestPayload = {
      model: KIMI_MODEL,
      messages: [
        {
          role: "system",
          content: "Return JSON only. No markdown. Build only a compact story package from the brief."
        },
        {
          role: "user",
          content: [
            "Return only this JSON object schema:",
            "{\"title\":\"...\",\"logline\":\"...\",\"genre\":\"...\",\"tone\":\"...\",\"visualWorld\":\"...\",\"primary\":\"...\",\"secondary\":\"...\"}",
            `Brief: ${brief}`,
            `Good example: ${storyRepairExampleOutput}`,
            "Keep values concise and usable for image/video generation.",
            "title max 6 words; logline max 24 words; genre max 3 words; tone max 4 words; visualWorld max 14 words; primary max 12 words; secondary max 12 words."
          ].join("\n")
        }
      ],
      temperature: 0.2,
      top_p: 0.95,
      max_tokens: relaxedTokenBudget,
      response_format: { type: "json_object" },
      extra_body: { thinking: { type: "disabled" } }
    };
    const text = await postKimi(requestPayload);
    const parsed = JSON.parse(text);
    const content = typeof parsed?.choices?.[0]?.message?.content === "string"
      ? parsed.choices[0].message.content
      : "";
    if (!content.trim()) {
      throw new Error("Kimi story-only request returned empty content");
    }
    const story = JSON.parse(content);
    return {
      title: normalizeStoryField(story?.title, ""),
      logline: normalizeStoryField(story?.logline, ""),
      genre: normalizeStoryField(story?.genre, ""),
      tone: normalizeStoryField(story?.tone, ""),
      visualWorld: normalizeStoryField(story?.visualWorld, ""),
      primary: normalizeStoryField(story?.primary, ""),
      secondary: normalizeStoryField(story?.secondary, "")
    };
  };

  const attemptSceneBatchRequest = async (story, batchStart, batchCount) => {
    const batchEnd = batchStart + batchCount;
    const storyJson = JSON.stringify(story || {});
    const batchExample = JSON.stringify({ scenes: plannerExample ? JSON.parse(plannerExample).scenes.slice(0, Math.min(2, batchCount)) : [] });
    const requestPayload = {
      model: KIMI_MODEL,
      messages: [
        {
          role: "system",
          content: "Return JSON only. No markdown. Build only the requested scene batch."
        },
        {
          role: "user",
          content: [
            `Create scenes ${batchStart + 1} to ${batchEnd} of a ${sceneCount}-scene short drama.`,
            `Each scene should cover about ${approxSecondsPerShot} seconds.`,
            `Brief: ${brief}`,
            `Story package: ${storyJson}`,
            "Keep continuity with previous and future scenes; do not reset the story.",
            "Return only this JSON schema:",
            sceneBatchSchema,
            `Good example: ${batchExample}`,
            "title max 5 words; purpose max 10 words; summary max 20 words; location max 6 words; camera max 6 words; emotion max 3 words; audio max 12 words."
          ].join("\n")
        }
      ],
      temperature: 0.25,
      top_p: 0.95,
      max_tokens: Math.max(900, Math.min(2200, 260 * batchCount)),
      response_format: { type: "json_object" },
      extra_body: { thinking: { type: "disabled" } }
    };
    const text = await postKimi(requestPayload);
    const parsed = JSON.parse(text);
    const content = typeof parsed?.choices?.[0]?.message?.content === "string"
      ? parsed.choices[0].message.content
      : "";
    if (!content.trim()) {
      throw new Error(`Kimi scene-batch ${batchStart + 1}-${batchEnd} returned empty content`);
    }
    const batch = JSON.parse(content);
    const scenes = Array.isArray(batch?.scenes) ? batch.scenes : [];
    if (scenes.length !== batchCount) {
      throw new Error(`Kimi scene-batch ${batchStart + 1}-${batchEnd} returned ${scenes.length} scenes`);
    }
    return scenes.map((scene, index) => normalizeSceneObject(scene, batchStart + index));
  };

  const retryableKimiError = (error) => /message content|valid JSON|non-JSON|timed out|HTTP 5\d\d|HTTP 429/i.test(String(error?.message || error));
  const getKimiRetryDelayMs = (error, index) => {
    const message = String(error?.message || error || "");
    if (/HTTP 429/i.test(message)) {
      return 20000 * (index + 1);
    }
    return KIMI_RETRY_DELAY_MS * (index + 1);
  };
  const plannerAttempts = [
    { strict: false, useResponseFormat: true, maxTokensOverride: normalTokenBudget },
    { strict: true, useResponseFormat: true, maxTokensOverride: normalTokenBudget },
    { strict: true, useResponseFormat: false, maxTokensOverride: relaxedTokenBudget },
    { strict: true, useResponseFormat: false, maxTokensOverride: strictTokenBudget },
  ];

  let plan = null;
  let lastPlannerError = null;
  if (useCompactProductionPlanner) {
    try {
      plan = await attemptCompactProductionPlanRequest();
      lastPlannerError = null;
    } catch (error) {
      lastPlannerError = new Error(`Kimi compact production planner failed: ${error.message}`);
    }
  }

  if (!plan && !useCompactProductionPlanner && sceneCount > KIMI_SCENE_BATCH_SIZE) {
    try {
      const story = await attemptStoryOnlyRequest();
      const scenes = [];
      for (let batchStart = 0; batchStart < sceneCount; batchStart += KIMI_SCENE_BATCH_SIZE) {
        const batchCount = Math.min(KIMI_SCENE_BATCH_SIZE, sceneCount - batchStart);
        let batchScenes = null;
        let batchError = null;
        for (let batchTry = 0; batchTry < 2; batchTry += 1) {
          try {
            batchScenes = await attemptSceneBatchRequest(story, batchStart, batchCount);
            batchError = null;
            break;
          } catch (error) {
            batchError = error;
            if (batchTry === 0) {
              await sleep(KIMI_RETRY_DELAY_MS * (batchTry + 1));
            }
          }
        }
        if (!batchScenes) {
          const message = batchError?.message || `Failed to build scene batch ${batchStart + 1}`;
          throw new Error(`Kimi scene batch ${batchStart + 1}-${batchStart + batchCount} failed: ${message}`);
        }
        scenes.push(...batchScenes);
      }
      plan = { story, scenes };
      lastPlannerError = null;
    } catch (error) {
      lastPlannerError = new Error(`Kimi production planner failed during batched planning: ${error.message}`);
    }
  }

  for (let index = 0; !useCompactProductionPlanner && index < plannerAttempts.length; index += 1) {
    if (plan) break;
    try {
      plan = await attemptPlanRequest(plannerAttempts[index]);
      lastPlannerError = null;
      break;
    } catch (error) {
      lastPlannerError = error;
      if (error?.reasoning) {
        try {
          plan = await attemptReasoningRescue(error.reasoning);
          lastPlannerError = null;
          break;
        } catch (rescueError) {
          lastPlannerError = rescueError;
        }
      }
      if (!retryableKimiError(error) || index === plannerAttempts.length - 1) {
        break;
      }
      await sleep(getKimiRetryDelayMs(error, index));
    }
  }

  if (!plan) {
    throw new Error(`Kimi planning failed after ${plannerAttempts.length} attempts: ${lastPlannerError?.message || "unknown error"}`);
  }

  const scenes = Array.isArray(plan?.scenes)
    ? plan.scenes
    : Array.isArray(plan?.shots)
      ? plan.shots
      : Array.isArray(plan)
        ? plan
        : [];

  if (!scenes.length) {
    throw new Error("Kimi response missing scenes[]");
  }

  const story = plan?.story || null;
  const repairedStory = hasUsableStoryPackage(story)
    ? story
    : await attemptStoryRepair(story, scenes).catch(() => story);
  const normalizedFinalStory = repairedStory && typeof repairedStory === "object" ? { ...repairedStory } : {};
  const repairedTitle = normalizeStoryField(normalizedFinalStory.title, "");
  const briefLower = brief.toLowerCase().trim();
  if (!repairedTitle || repairedTitle.toLowerCase().trim() === briefLower) {
    const sceneDerivedTitle = buildTitleFromScenes(scenes);
    if (sceneDerivedTitle) {
      normalizedFinalStory.title = sceneDerivedTitle;
    }
  }

  return {
    model: KIMI_MODEL,
    story: normalizedFinalStory,
    scenes,
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

  await rm(EXAMPLE_ASSETS_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
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
  const encoded = JSON.stringify(manifest, null, 2);
  await writeFile(PERSISTED_EXAMPLE_OUTPUT_FILE, encoded, "utf8");
  try {
    await writeFile(EXAMPLE_OUTPUT_FILE, encoded, "utf8");
  } catch (_) {
    // The repo-root snapshot is a convenience copy only.
  }
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
  const sceneDurations = Array.isArray(payload?.scene_durations)
    ? payload.scene_durations.map((value) => Math.max(1, Number(value) || 0))
    : [];
  if (!clipUrls.length) {
    throw new Error("clip_urls[] are required");
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
    for (const [index, clipUrl] of clipUrls.entries()) {
      const clipPath = join(workDir, `clip-${index + 1}.mp4`);
      await downloadToFile(clipUrl, clipPath);
      clipFiles.push(clipPath);
    }

    const normalizedFiles = [];
    for (const [index, clipPath] of clipFiles.entries()) {
      const targetDuration = sceneDurations[index] || VIDEO_DURATION_SECONDS;
      const normalizedPath = join(workDir, `normalized-${index + 1}.mp4`);
      await execFileAsync(FFMPEG_PATH, [
        "-y",
        "-stream_loop", "-1",
        "-i", clipPath,
        "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-t", String(targetDuration),
        normalizedPath,
      ], { windowsHide: true });
      normalizedFiles.push(normalizedPath);
    }

    const concatPath = join(workDir, "clips.txt");
    const concatBody = normalizedFiles
      .map((filePath) => {
        const normalizedPath = String(filePath).replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `file '${normalizedPath}'`;
      })
      .join("\n");
    await writeFile(concatPath, concatBody, "utf8");

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

  const imageUrl = payload?.input?.img_url || payload?.input?.image_url;
  if (!shouldInlineVideoImage(imageUrl)) {
    return bodyBuffer;
  }

  const targetUrl = toAbsoluteUpstreamMediaUrl(imageUrl);
  const media = await proxyMediaFetch(targetUrl);
  const dataUrl = `data:${media.contentType};base64,${media.buffer.toString("base64")}`;
  if (!payload.input || typeof payload.input !== "object") {
    payload.input = {};
  }
  payload.input.img_url = dataUrl;
  delete payload.input.image_url;
  return Buffer.from(JSON.stringify(payload), "utf8");
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (req.url === "/api/health") {
    const runGuard = summarizeRunGuard(await readRunGuardState());
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
        image_model_sequence: IMAGE_MODEL_SEQUENCE,
        video_resolution: VIDEO_RESOLUTION,
        video_duration_seconds: VIDEO_DURATION_SECONDS,
        enable_example_capture: ENABLE_EXAMPLE_CAPTURE,
        video_model_sequence: VIDEO_MODEL_SEQUENCE,
        video_model_capabilities: VIDEO_MODEL_CAPABILITIES,
      },
      upstream_limits: UPSTREAM_LIMITS,
      run_guard: runGuard,
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

  if (req.url === "/api/local/run-guard" && req.method === "GET") {
    const summary = summarizeRunGuard(await readRunGuardState());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(summary));
    return;
  }

  if (req.url === "/api/local/run-guard/start" && req.method === "POST") {
    try {
      const reservation = await reserveProductionRun();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reservation));
    } catch (error) {
      res.writeHead(error?.statusCode || 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
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
    const runToken = Array.isArray(req.headers["x-workflow-run-token"]) ? req.headers["x-workflow-run-token"][0] : req.headers["x-workflow-run-token"];
    if (!(await validateRunToken(runToken))) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Production run token required or invalid." }));
      return;
    }

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
    if (isWorkflowSpendPath(req.url)) {
      const runToken = Array.isArray(req.headers["x-workflow-run-token"]) ? req.headers["x-workflow-run-token"][0] : req.headers["x-workflow-run-token"];
      if (!(await validateRunToken(runToken))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Production run token required or invalid." }));
        return;
      }
    }
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

  if (req.url === "/example-output.json") {
    const preferred = existsSync(PERSISTED_EXAMPLE_OUTPUT_FILE) ? PERSISTED_EXAMPLE_OUTPUT_FILE : EXAMPLE_OUTPUT_FILE;
    try {
      const fileStat = await stat(preferred);
      if (fileStat.isDirectory()) {
        res.writeHead(403);
        res.end();
        return;
      }
      const payload = sanitizeExampleOutputForPublic(JSON.parse(await readFile(preferred, "utf8")));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    } catch (_) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
    return;
  }

  if (req.url.startsWith("/example-assets/")) {
    const assetPath = resolveExampleAssetPath(req.url);
    if (!assetPath) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const fileStat = await stat(assetPath);
      if (fileStat.isDirectory()) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[extname(assetPath)] || "application/octet-stream" });
      createReadStream(assetPath).pipe(res);
    } catch (_) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
    return;
  }

  const filePath = req.url === "/" ? "index.html" : req.url.slice(1);
  const resolved = join(APP_ROOT, filePath);
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
server.requestTimeout = Math.max(server.requestTimeout || 0, 15 * 60 * 1000);
server.headersTimeout = Math.max(server.headersTimeout || 0, 16 * 60 * 1000);
server.keepAliveTimeout = Math.max(server.keepAliveTimeout || 0, 65 * 1000);
(async () => {
  try {
    await ensurePersistentStorageSeed();
    server.listen(port, "0.0.0.0", () => {
      console.log(`Short Drama Studio running on http://localhost:${port}`);
    });
  } catch (error) {
    console.error(`Failed to prepare persistent storage: ${error?.message || error}`);
    process.exit(1);
  }
})();
