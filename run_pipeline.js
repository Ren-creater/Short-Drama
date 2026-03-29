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

const BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope-intl.aliyuncs.com/api/v1").replace(/\/+$/, "");
const API_KEY = (process.env.DASHSCOPE_API_KEY || "").trim();
const TTS_MODEL = (process.env.TTS_MODEL || "qwen3-tts-flash").trim();
const IMAGE_MODEL = (process.env.IMAGE_MODEL || "qwen-image").trim();
const VIDEO_MODEL = (process.env.VIDEO_MODEL || "wan2.1-i2v-plus").trim();

if (!API_KEY) {
  console.error("Missing DASHSCOPE_API_KEY");
  process.exit(1);
}

async function request(pathname, payload) {
  const resp = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
      "X-DashScope-Async": "enable"
    },
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
        "Authorization": `Bearer ${API_KEY}`,
        "X-DashScope-Async": "enable"
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
  console.log("TTS submit...");
  const ttsPayload = {
    model: TTS_MODEL,
    input: {
      text: "The backup lights died one by one. Mira heard the call before she trusted it. You still listen to the silence, Elias said, and the ward breathed again."
    },
    parameters: {
      voice: "Cherry",
      language_type: "English",
      format: "wav",
      stream: false
    }
  };
  const ttsResp = await request("/services/aigc/multimodal-generation/generation", ttsPayload);
  let audioUrl = ttsResp?.output?.task_result?.audio_url;
  if (!audioUrl) {
    const ttsTask = ttsResp?.output?.task_id || ttsResp?.request_id;
    if (!ttsTask) throw new Error("No TTS task id");
    const ttsStatus = await poll(ttsTask, "TTS");
    audioUrl = ttsStatus?.output?.task_result?.audio_url;
  }
  if (!audioUrl) throw new Error("TTS audio_url missing");
  console.log("Audio URL:", audioUrl);

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
      prompt: "Cinematic shot continuation from the reference frame, grounded motion, stable character identity, 720p"
    },
    parameters: { resolution: "720P", duration: 5, prompt_extend: false, watermark: false }
  };
  const vidResp = await request("/services/aigc/video-generation/video-synthesis", vidPayload);
  const vidTask = vidResp?.output?.task_id || vidResp?.request_id;
  if (!vidTask) throw new Error("No Image2Video task id");
  const vidStatus = await poll(vidTask, "Image2Video", 3600000);
  const videoUrl = vidStatus?.output?.results?.video_url;
  if (!videoUrl) throw new Error("Video URL missing");
  console.log("Video URL:", videoUrl);

  const premade = { image: imageUrl, video: videoUrl };
  fs.writeFileSync("premade.json", JSON.stringify(premade, null, 2));
  console.log("Saved premade.json");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
