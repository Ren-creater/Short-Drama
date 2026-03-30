const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (_) {
    // Optional local convenience only.
  }
}

loadDotEnv();

const RAW_BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com").replace(/\/+$/, "");
const BASE_URL = /\/api\/v1$/i.test(RAW_BASE_URL) ? RAW_BASE_URL : `${RAW_BASE_URL}/api/v1`;
const API_KEY = (process.env.DASHSCOPE_API_KEY || "").trim();
const IMAGE_MODEL = (process.env.IMAGE_MODEL || "qwen-image").trim();
const VIDEO_MODEL = (process.env.VIDEO_MODEL || "wan2.6-i2v").trim();
const VIDEO_DURATION_SECONDS = Math.max(5, Number(process.env.VIDEO_DURATION_SECONDS || 15) || 15);

if (!API_KEY) {
  console.error("Missing DASHSCOPE_API_KEY");
  process.exit(1);
}

function shouldUseAsync(pathname) {
  return pathname.includes("/text2image/") || pathname.includes("/video-generation/");
}

async function request(pathname, payload) {
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`
  };
  if (shouldUseAsync(pathname)) {
    headers["X-DashScope-Async"] = "enable";
  }
  const resp = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function poll(taskId, label, timeoutMs = 1800000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await fetch(`${BASE_URL}/tasks/${taskId}`, {
      headers: {
        "Authorization": `Bearer ${API_KEY}`
      }
    });
    const data = await resp.json();
    const status = data?.output?.task_status;
    if (status === "SUCCEEDED") return data;
    if (status === "FAILED") throw new Error(`${label} failed: ${JSON.stringify(data)}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} timed out`);
}

async function main() {
  console.log("Text2Image submit...");
  const t2iPayload = {
    model: IMAGE_MODEL,
    input: { prompt: "Cinematic hospital corridor at night, emergency lights, rain reflections, 16:9" },
    parameters: { size: "1280*720", prompt_extend: false }
  };
  const t2iResp = await request("/services/aigc/text2image/image-synthesis", t2iPayload);
  const t2iTask = t2iResp?.output?.task_id || t2iResp?.request_id;
  if (!t2iTask) throw new Error("No Text2Image task id");
  const t2iStatus = await poll(t2iTask, "Text2Image", 2400000);
  const imageUrl = t2iStatus?.output?.results?.[0]?.url;
  if (!imageUrl) throw new Error("Text2Image URL missing");
  console.log("Image URL:", imageUrl);

  console.log("Image2Video (I2V) submit...");
  const vidPayload = {
    model: VIDEO_MODEL,
    input: {
      img_url: imageUrl,
      prompt: "Cinematic shot continuation from the reference frame, grounded motion, stable character identity, 720p. Native audio direction: hospital room tone, rain on glass, distant alarms, rolling cart wheels, urgent footsteps. Keep sound realistic and synchronized, no voice-over, no music."
    },
    parameters: { resolution: "720P", duration: VIDEO_DURATION_SECONDS, prompt_extend: false, watermark: false, audio: true }
  };
  const vidResp = await request("/services/aigc/video-generation/video-synthesis", vidPayload);
  const vidTask = vidResp?.output?.task_id || vidResp?.request_id;
  if (!vidTask) throw new Error("No Image2Video task id");
  const vidStatus = await poll(vidTask, "Image2Video", 3600000);
  const videoUrl = vidStatus?.output?.video_url || vidStatus?.output?.results?.video_url;
  if (!videoUrl) throw new Error("Video URL missing");
  console.log("Video URL:", videoUrl);

  const premade = {
    title: "Short Drama Example Output",
    brief: "A junior emergency doctor discovers the anonymous caller guiding her through a citywide blackout is her estranged brother.",
    image: imageUrl,
    video: videoUrl
  };
  fs.writeFileSync("premade.json", JSON.stringify(premade, null, 2));
  console.log("Saved premade.json");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
