const pipelineDefinitions = [
  {
    id: "story",
    label: "Story",
    detail: "Expand the brief into a complete dramatic arc."
  },
  {
    id: "bible",
    label: "Character Bible",
    detail: "Lock identity anchors, wardrobe, props, and emotional trajectory."
  },
  {
    id: "keyframes",
    label: "Keyframes",
    detail: "Generate one continuity-safe keyframe per scene."
  },
  {
    id: "clips",
    label: "Video",
    detail: "Generate one clip per scene using DashScope 720P."
  },
  {
    id: "assembly",
    label: "Assembly",
    detail: "Stitch clips into a fixed 180s, 720p deliverable."
  }
];

const state = {
  result: null,
  upstreamBaseUrl: "",
  runtimeConfig: null,
  progress: { done: 0, total: 1 },
  workflowRunning: false,
  transportCooldownUntil: 0,
  transportFailureCount: 0
};

const els = {
  brief: document.getElementById("brief"),
  runWorkflow: document.getElementById("runWorkflow"),
  workflowTab: document.getElementById("workflowTab"),
  showcaseTab: document.getElementById("showcaseTab"),
  workflowView: document.getElementById("workflowView"),
  showcaseView: document.getElementById("showcaseView"),
  liveLog: document.getElementById("liveLog"),
  pipeline: document.getElementById("pipeline"),
  statusBanner: document.getElementById("statusBanner"),
  promptStructure: document.getElementById("promptStructure"),
  runtimeMetric: document.getElementById("runtimeMetric"),
  finalOutputPanel: document.getElementById("finalOutputPanel"),
  finalVideoPlayer: document.getElementById("finalVideoPlayer"),
  finalVideoDownload: document.getElementById("finalVideoDownload"),
  finalAudioDownload: document.getElementById("finalAudioDownload"),
  saveExampleOutput: document.getElementById("saveExampleOutput"),
  demoEmpty: document.getElementById("demoEmpty"),
  demoContent: document.getElementById("demoContent"),
  demoStatusBanner: document.getElementById("demoStatusBanner"),
  demoProgressFill: document.getElementById("demoProgressFill"),
  demoProgressText: document.getElementById("demoProgressText"),
  demoProgressDetail: document.getElementById("demoProgressDetail"),
  demoBrief: document.getElementById("demoBrief"),
  demoFinalOutputPanel: document.getElementById("demoFinalOutputPanel"),
  demoFinalVideo: document.getElementById("demoFinalVideo"),
  demoFinalVideoDownload: document.getElementById("demoFinalVideoDownload"),
  demoFinalAudioDownload: document.getElementById("demoFinalAudioDownload"),
  demoNarrationAudio: document.getElementById("demoNarrationAudio"),
  demoImage: document.getElementById("demoImage"),
  demoPipeline: document.getElementById("demoPipeline"),
  demoShotPlan: document.getElementById("demoShotPlan"),
  demoPromptStructure: document.getElementById("demoPromptStructure"),
  shotPlan: document.getElementById("shotPlan"),
  progressFill: document.getElementById("progressFill"),
  progressText: document.getElementById("progressText"),
  progressDetail: document.getElementById("progressDetail")
};

const PREMADE_KEY = "short_drama_premade";
const EXAMPLE_OUTPUT_PATH = "/example-output.json";
const KEYFRAME_SUBMIT_CONCURRENCY = 1;
const KEYFRAME_SUBMIT_RETRIES = 4;
const VIDEO_ACTIVE_TASK_LIMIT = 2;
const SCENE_TTS_CONCURRENCY = 2;
const VIDEO_TASK_TIMEOUT_MS = 43200000;
const MEDIA_FETCH_RETRIES = 3;
const VIDEO_SUBMIT_RETRIES = 4;

function defaultRuntimeConfig() {
  return {
    mode: "official-api",
    dashscope_endpoint: "",
    image_model: "qwen-image",
    tts_model: "qwen3-tts-flash",
    video_resolution: "720P",
    video_duration_seconds: 5,
    video_model_sequence: [
      "wan2.1-i2v-plus",
      "wan2.1-i2v-turbo",
      "wan2.2-i2v-flash",
      "wan2.5-i2v-preview",
      "wan2.6-i2v",
      "wan2.6-i2v-flash"
    ],
    video_model_capabilities: {}
  };
}

function getRuntimeConfig() {
  return state.runtimeConfig || defaultRuntimeConfig();
}

function renderPipelineInto(target, activeId = null, doneIds = []) {
  if (!target) return;
  target.innerHTML = pipelineDefinitions.map((step, index) => {
    const classNames = ["pipeline-step"];
    if (doneIds.includes(step.id)) classNames.push("done");
    if (activeId === step.id) classNames.push("active");

    return `
      <article class="${classNames.join(" ")}">
        <small>0${index + 1}</small>
        <strong>${step.label}</strong>
        <span>${step.detail}</span>
      </article>
    `;
  }).join("");
}

function renderPipeline(activeId = null, doneIds = []) {
  renderPipelineInto(els.pipeline, activeId, doneIds);
}

function updateStatusBanner(kind, text) {
  els.statusBanner.className = `status-banner ${kind}`;
  els.statusBanner.textContent = text;
}

function setStatus(kind, text) {
  updateStatusBanner(kind, text);
  appendLiveLog(text, kind);
}

function setTtsStatus(text, kind = "idle") {
  // TTS status panel removed from UI; keep this as a no-op hook.
  void text;
  void kind;
}

function appendLiveLog(message, kind = "idle") {
  if (!els.liveLog) return;
  const item = document.createElement("li");
  item.className = `live-item live-${kind}`;
  const now = new Date();
  const stamp = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  item.textContent = `[${stamp}] ${message}`;
  els.liveLog.prepend(item);
}

function clearLiveLog() {
  if (!els.liveLog) return;
  els.liveLog.innerHTML = "";
}

function resetProgress(total, detail = "Idle") {
  state.progress.total = Math.max(1, Number(total) || 1);
  state.progress.done = 0;
  setProgress(0, detail);
}

function setProgress(done, detail = "") {
  state.progress.done = Math.max(0, Math.min(done, state.progress.total));
  const pct = Math.round((state.progress.done / state.progress.total) * 100);
  if (els.progressFill) els.progressFill.style.width = `${pct}%`;
  if (els.progressText) els.progressText.textContent = `${pct}%`;
  if (els.progressDetail) els.progressDetail.textContent = detail || "Running";
}

function bumpProgress(detail = "") {
  setProgress(state.progress.done + 1, detail);
}

async function flushUi() {
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function chooseRecorderMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  const limit = Math.max(1, Math.min(concurrency || 1, list.length));
  let cursor = 0;
  let firstError = null;

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < list.length) {
      if (firstError) return;
      const index = cursor++;
      try {
        await worker(list[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
        return;
      }
    }
  });

  await Promise.all(runners);
  if (firstError) throw firstError;
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

function deriveFromBrief(brief) {
  const safeBrief = brief || "Short drama about urgent trust during a crisis.";
  const title = safeBrief.split(".")[0].trim().slice(0, 48) || "Short Drama";
  const logline = safeBrief.length > 180 ? safeBrief.slice(0, 180) + "..." : safeBrief;
  const genre = /thriller|suspense|blackout|crisis|escape/i.test(safeBrief) ? "Emotional thriller" : "Character drama";
  const tone = /hope|reconcile|forgive|family/i.test(safeBrief) ? "Intimate, hopeful" : "Urgent, cinematic";
  const protagonist = "Dr. Mira Chen, 29, East Asian woman, sharp bob haircut, tired observant eyes, navy ER scrubs under a dark raincoat, silver analog watch.";
  const secondary = "Elias Chen, 34, East Asian man, lean build, hooded charcoal jacket, worn messenger bag, controlled voice, carries guilt, same eyes as Mira.";
  const visualWorld = "Rain-slick night, emergency lighting, reflective glass, handheld tension, cyan and amber palette.";
  const narration = `${title}. ${logline}`;

  return {
    title,
    logline,
    genre,
    tone,
    protagonist,
    secondary,
    visualWorld,
    narration
  };
}

function inputPayload() {
  els.runtimeMetric.textContent = "3-minute 720p short drama";
  const brief = els.brief.value.trim();
  const derived = deriveFromBrief(brief);

  return {
    brief,
    ...derived,
    runtime: 180,
    resolution: "1280x720",
    audioUrl: ""
  };
}

function buildScenes(payload) {
  return buildScenesFromBeats(payload, defaultBeats(payload));
}

function defaultBeats(payload) {
  return [
    {
      title: "Blackout Trigger",
      purpose: "Launch the crisis and isolate the protagonist.",
      summary: `${payload.brief} The hospital plunges into backup power as Mira gets the first call.`,
      location: "Hospital corridor",
      camera: "handheld push-in",
      emotion: "suppressed panic"
    },
    {
      title: "Voice in the Dark",
      purpose: "Reveal the anonymous guide is personal, not random.",
      summary: "The caller predicts the next failure. Mira recognizes the voice as Elias.",
      location: "Stairwell landing",
      camera: "tight medium close-up",
      emotion: "shock under control"
    },
    {
      title: "Broken Trust",
      purpose: "Place emotional history against the operational crisis.",
      summary: "Elias admits he has tracked the sabotage for months. Mira refuses to trust him without proof.",
      location: "Split between hospital and parked van",
      camera: "cross-cutting with slow lateral drift",
      emotion: "resentment colliding with necessity"
    },
    {
      title: "First Switch",
      purpose: "Deliver the first tactical win while increasing pressure.",
      summary: "Mira restores one backup line but locks down the pediatric lift. A second relay is deeper below.",
      location: "Utility room",
      camera: "low-angle close action shots",
      emotion: "determined strain"
    },
    {
      title: "Storm Crossing",
      purpose: "Move both characters toward collision.",
      summary: "Elias crosses the flooded street with stolen access cards as Mira races the failing tannoy.",
      location: "Exterior street and service tunnel",
      camera: "tracking with lens flares in rain",
      emotion: "forward momentum"
    },
    {
      title: "Confession at the Relay",
      purpose: "Pay off the family fracture.",
      summary: "At the second relay, Elias admits why he disappeared. Mira confronts his guilt.",
      location: "Basement relay chamber",
      camera: "two-shot turning into over-the-shoulder reverses",
      emotion: "raw honesty"
    },
    {
      title: "Power Return",
      purpose: "Resolve the practical objective.",
      summary: "They reset the main bypass together. The neonatal ward powers back up seconds before failure.",
      location: "Relay chamber to neonatal ward",
      camera: "crescendo montage with stabilizing frames",
      emotion: "earned release"
    },
    {
      title: "Dawn Answer",
      purpose: "End on emotional resolution, not just restored electricity.",
      summary: "At dawn, Mira finally asks why Elias called her. He says she was the only one who would answer.",
      location: "Hospital roof at first light",
      camera: "wide shot resolving into still portrait",
      emotion: "quiet reconciliation"
    }
  ];
}

function sanitizeBeat(beat, index) {
  const idx = index + 1;
  return {
    title: String(beat?.title || `Scene ${idx}`),
    purpose: String(beat?.purpose || "Advance the dramatic arc."),
    summary: String(beat?.summary || "Continue the story progression with continuity-safe character actions."),
    location: String(beat?.location || "Primary story location"),
    camera: String(beat?.camera || "cinematic medium shot"),
    emotion: String(beat?.emotion || "rising tension")
  };
}

async function requestLlmSceneBeats(payload) {
  const response = await fetchJson("/api/local/story-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      brief: payload.brief,
      title: payload.title,
      logline: payload.logline,
      genre: payload.genre,
      tone: payload.tone,
      protagonist: payload.protagonist,
      secondary: payload.secondary,
      visualWorld: payload.visualWorld,
      runtime: payload.runtime,
      scene_count: 8
    })
  });
  const scenes = Array.isArray(response?.scenes) ? response.scenes.slice(0, 8).map(sanitizeBeat) : [];
  if (scenes.length < 8) {
    throw new Error("Kimi returned insufficient scene beats");
  }
  return { scenes, model: response?.model || "" };
}

function buildScenesFromBeats(payload, beats) {
  const durations = [22, 22, 22, 22, 23, 23, 23, 23];
  let total = 0;
  return beats.map((beat, index) => {
    const safeBeat = sanitizeBeat(beat, index);
    const duration = durations[index];
    total += duration;
    return {
      ...safeBeat,
      sceneNumber: index + 1,
      duration,
      cumulative: total,
      keyframePrompt: buildKeyframePrompt(payload, safeBeat, index + 1),
      videoPrompt: buildVideoPrompt(payload, safeBeat, index + 1),
      narrationText: buildSceneNarration(payload, safeBeat, index + 1),
      keyframeStatus: "pending",
      videoStatus: "pending",
      audioStatus: "pending",
      audioUrl: "",
      videoModel: ""
    };
  });
}

function buildSceneNarration(payload, beat, sceneNumber) {
  return [
    `Scene ${sceneNumber}, ${beat.title}.`,
    beat.summary,
    `The scene unfolds in ${beat.location.toLowerCase()}, framed with ${beat.camera}.`,
    `Emotionally, it plays with ${beat.emotion}, while the dramatic purpose is to ${beat.purpose.toLowerCase()}.`,
    `This moment pushes ${payload.protagonist.split(",")[0]} deeper into the crisis and keeps the story moving toward the final resolution.`
  ].join(" ");
}

function buildKeyframePrompt(payload, beat, sceneNumber) {
  return [
    `Scene ${sceneNumber} keyframe for "${payload.title}".`,
    `Brief: ${payload.brief}`,
    `Character anchor: ${payload.protagonist}`,
    `Secondary anchor: ${payload.secondary}`,
    `World style: ${payload.visualWorld}`,
    `Scene action: ${beat.summary}`,
    `Camera: ${beat.camera}.`,
    `Lighting and palette: moody cinematic realism, controlled contrast, amber emergency lights against cyan rain reflections.`,
    `Consistency rules: preserve facial identity, hair silhouette, wardrobe colors, silver watch on Mira, charcoal jacket and messenger bag on Elias, no age drift, no costume drift.`
  ].join(" ");
}

function buildVideoPrompt(payload, beat, sceneNumber) {
  return [
    `Generate a 720p cinematic video clip for scene ${sceneNumber} of "${payload.title}".`,
    `Start from the approved keyframe image and keep both characters on-model.`,
    `Performance beat: ${beat.emotion}.`,
    `Action beat: ${beat.summary}`,
    `Shot design: ${beat.camera}, natural motion blur, grounded handheld realism, no surreal transitions.`,
    `Pacing direction: movement and camera timing should support a ${beat.duration}-second clip with clean entry/exit frames for later narration mix.`,
    `Safety constraints: stable anatomy, stable wardrobe, same props, no sudden background swaps, no subtitle burn-in, no extra characters.`
  ].join(" ");
}

function buildPromptStructure(payload, scenes, bible) {
  const runtimeConfig = getRuntimeConfig();
  const primaryVideoModel = runtimeConfig.video_model_sequence?.[0] || "wan2.1-i2v-plus";
  const systemPrompt = [
    "You are a short-drama workflow planner for text, image, and video generation.",
    "Produce outputs that are cinematic, emotionally coherent, and practical for downstream media models.",
    "All scene assets must preserve character identity, wardrobe, props, and environment continuity.",
    `Final target: runtime = ${payload.runtime} seconds, resolution ${payload.resolution}, episodic short-drama pacing.`
  ].join("\n");

  const storyPrompt = [
    `BRIEF: ${payload.brief}`,
    `TITLE: ${payload.title}`,
    `LOGLINE: ${payload.logline}`,
    `GENRE: ${payload.genre}`,
    `TONE: ${payload.tone}`,
    `TARGET_RUNTIME_SECONDS: ${payload.runtime}`,
    `PRIMARY_CHARACTER: ${payload.protagonist}`,
    `SECONDARY_CHARACTER: ${payload.secondary}`,
    `VISUAL_WORLD: ${payload.visualWorld}`,
    "TASK: Write an eight-scene short-drama outline with escalating stakes, emotional reversals, and a final visual resolution.",
    "OUTPUT FORMAT: JSON with scenes, each scene including purpose, duration_seconds, summary, camera, emotion, and continuity notes."
  ].join("\n");

  const imagePromptTemplate = [
    "[BRIEF]",
    "[SUBJECT_IDENTITY]",
    "[WARDROBE_AND_PROPS]",
    "[LOCATION_AND_TIME]",
    "[DRAMATIC_ACTION]",
    "[CAMERA_AND_COMPOSITION]",
    "[LIGHTING_AND_COLOR]",
    "[CONSISTENCY_RULES]",
    "[NEGATIVE_CONSTRAINTS: no age drift, no extra fingers, no costume swap, no text overlays]"
  ].join("\n");

  const videoPromptTemplate = [
    "[APPROVED_KEYFRAME_REFERENCE]",
    "[VIDEO_PROMPT_TEXT]",
    "[CHARACTER_PERFORMANCE_BEAT]",
    "[MOTION_DIRECTION_AND_CAMERA_MOVE]",
    "[PACING_FOR_LATER_NARRATION_MIX]",
    "[ENVIRONMENT_CONTINUITY]",
    "[DURATION_AND_RESOLUTION_TARGET]",
    "[FAILURE_AVOIDANCE: stable anatomy, stable props, avoid sudden shot morphs]"
  ].join("\n");

  const continuity = [
    `Primary anchor summary: ${bible.protagonist.anchors.join('; ')}.`,
    `Secondary anchor summary: ${bible.secondary.anchors.join('; ')}.`,
    `World anchors: ${bible.worldAnchors.join('; ')}.`,
    "Operational rule: each scene gets one hero keyframe, and its video job launches as soon as that keyframe is ready.",
    "If a character changes pose or wardrobe across scenes, issue an image-edit correction pass before launching the corresponding video clip."
  ].join("\n");

  const ttsPayloadExample = JSON.stringify({
    model: runtimeConfig.tts_model,
    input: { text: scenes[0].narrationText },
    parameters: {
      voice: "Cherry",
      language_type: "English",
      format: "wav",
      stream: false
    }
  }, null, 2);

  const imagePayloadExample = JSON.stringify({
    model: runtimeConfig.image_model,
    input: { prompt: scenes[0].keyframePrompt },
    parameters: { size: "1280*720", prompt_extend: false }
  }, null, 2);

  const videoPayloadExample = JSON.stringify({
    model: primaryVideoModel,
    input: {
      img_url: "<scene_keyframe_url>",
      prompt: scenes[0].videoPrompt
    },
    parameters: {
      resolution: runtimeConfig.video_resolution,
      duration: runtimeConfig.video_duration_seconds,
      prompt_extend: false,
      watermark: false
    }
  }, null, 2);

  return {
    systemPrompt,
    storyPrompt,
    imagePromptTemplate,
    videoPromptTemplate,
    continuity,
    ttsPayloadExample,
    imagePayloadExample,
    videoPayloadExample,
    sampleImagePrompt: scenes[0].keyframePrompt,
    sampleVideoPrompt: scenes[0].videoPrompt
  };
}

function buildOpsPlan(payload, scenes) {
  const timeline = scenes.map((scene) => `${scene.sceneNumber}. ${scene.title}: ${scene.duration}s`).join("\n");
  const runtimeConfig = getRuntimeConfig();

  return {
    endpointPlan: [
      "Step 1: user enters one brief; app calls Kimi 2.5 to derive title-aligned 8 scene beats.",
      "Step 2: app derives one narration segment per scene and submits scene-level TTS jobs.",
      "Step 3: app submits scene keyframes first, with conservative retry and backoff.",
      "Step 4: after keyframes are ready, scene video jobs are queued in small batches against the official DashScope video endpoint.",
      "Step 5: server-side FFmpeg muxes each clip with its scene narration, normalizes to 1280x720, and concatenates the final MP4."
    ],
    assemblyChecklist: [
      `Fixed runtime: ${scenes.reduce((sum, scene) => sum + scene.duration, 0)} seconds.`,
      `Narration audio is generated scene-by-scene via ${runtimeConfig.tts_model}.`,
      `Scene video fallback order: ${runtimeConfig.video_model_sequence.join(" -> ")}.`,
      `Every finished clip is normalized to 1280x720 before final concat.`,
      "Final deliverable: 1280x720 H.264 MP4 with audio."
    ],
    concreteExecution: [
      "TTS endpoint: POST /api/v1/services/aigc/multimodal-generation/generation",
      "Image endpoint: POST /api/v1/services/aigc/text2image/image-synthesis",
      "Video endpoint: POST /api/v1/services/aigc/video-generation/video-synthesis",
      "Polling endpoint: GET /api/v1/tasks/{task_id}",
      "Execution pattern: scene TTS runs in parallel with keyframes; video starts after keyframes succeed and flows through a bounded queue.",
      "Result URLs consumed in-chain: keyframe URL -> video; scene audio URLs -> per-scene mux -> final assembly"
    ],
    timeline
  };
}

function buildNarrationScript(payload, scenes) {
  const intro = `${payload.title}. ${payload.logline}`;
  const sceneLines = scenes.map((scene) => {
    return [
      `Scene ${scene.sceneNumber}, ${scene.title}.`,
      scene.summary,
      `The emotional beat is ${scene.emotion}, and the dramatic purpose is to ${scene.purpose.toLowerCase()}.`
    ].join(" ");
  });
  const outro = "The final cut should play as one continuous short drama, with clear scene transitions and a steady narrative voice.";
  return [intro, ...sceneLines, outro].join(" ");
}

function buildCombinedSceneNarration(result) {
  return result.scenes.map((scene) => scene.narrationText).filter(Boolean).join(" ");
}

async function buildResult(payload) {
  let scenes;
  let llmModel = "";
  try {
    setStatus("processing", "Generating scene beats with Kimi 2.5...");
    const planned = await requestLlmSceneBeats(payload);
    scenes = buildScenesFromBeats(payload, planned.scenes);
    llmModel = planned.model || "";
    appendLiveLog(`Scene plan generated by ${llmModel || "Kimi"}.`, "ready");
  } catch (error) {
    appendLiveLog(`Kimi planner unavailable, using fallback scene template: ${error.message}`, "failed");
    scenes = buildScenesFromBeats(payload, defaultBeats(payload));
  }
  const bible = buildCharacterBible(payload);
  const promptStructure = buildPromptStructure(payload, scenes, bible);
  const ops = buildOpsPlan(payload, scenes);
  const enrichedPayload = {
    ...payload,
    narration: buildNarrationScript(payload, scenes)
  };

  return {
    payload: enrichedPayload,
    scenes,
    bible,
    llmModel,
    promptStructure,
    ops,
    totalRuntime: scenes.reduce((sum, scene) => sum + scene.duration, 0)
  };
}

function buildCharacterBible(payload) {
  return {
    protagonist: {
      identity: payload.protagonist,
      anchors: [
        "navy scrubs remain visible under outerwear",
        "silver analog watch always on left wrist",
        "sharp bob haircut and tired observant eyes stay constant",
        "emotion moves from controlled detachment to vulnerable trust"
      ]
    },
    secondary: {
      identity: payload.secondary,
      anchors: [
        "charcoal hooded jacket and messenger bag remain constant",
        "same eye shape as Mira to preserve sibling resemblance",
        "voice and body language practical rather than theatrical",
        "emotion moves from guarded guilt to direct honesty"
      ]
    },
    worldAnchors: [
      payload.visualWorld,
      "lens language alternates between pressure close-ups and short bursts of wide spatial relief",
      "rain, wet glass, and failing emergency lights repeat as continuity motifs"
    ]
  };
}

function renderOverview(result) {
  if (!els.storySummary || !els.characterSummary || !els.renderSummary || !els.sceneStrip) return;
  els.storySummary.innerHTML = `
    <p><strong>${result.payload.title}</strong> is structured as an eight-scene ${result.payload.genre.toLowerCase()} with a total runtime of <strong>${result.totalRuntime}s</strong>.</p>
    <p>${result.payload.logline}</p>
  `;

  els.characterSummary.innerHTML = `
    <p><strong>Mira anchor:</strong> ${result.bible.protagonist.identity}</p>
    <p><strong>Elias anchor:</strong> ${result.bible.secondary.identity}</p>
    <p>Consistency is enforced by preserving hair silhouette, wardrobe, props, sibling facial resemblance, and recurring rain-and-emergency-light motifs.</p>
  `;

  els.renderSummary.innerHTML = `
    <p>Render as <strong>${result.payload.resolution}</strong>, target one approved keyframe per scene, then turn each keyframe into a clip using text + image -> video generation.</p>
    <p>Final assembly combines 8 clips, dialogue audio, score, subtitles, and a single 180s timeline.</p>
  `;

  els.sceneStrip.innerHTML = result.scenes.map((scene) => `
    <article class="scene-card">
      <h3>Scene ${scene.sceneNumber}: ${scene.title}</h3>
      <p>${scene.summary}</p>
      <ul>
        <li><strong>Duration:</strong> ${scene.duration}s</li>
        <li><strong>Camera:</strong> ${scene.camera}</li>
        <li><strong>Emotion:</strong> ${scene.emotion}</li>
      </ul>
    </article>
  `).join("");
}

function renderPromptStructureInto(target, result) {
  if (!target) return;
  const sections = [
    { title: "1. System Prompt (story planner)", body: result.promptStructure.systemPrompt },
    { title: "2. Story Planning Prompt (derived from user brief)", body: result.promptStructure.storyPrompt },
    { title: "3. Image Prompt Template", body: result.promptStructure.imagePromptTemplate },
    { title: "4. Video Prompt Template", body: result.promptStructure.videoPromptTemplate },
    { title: "5. Character Consistency Rules", body: result.promptStructure.continuity },
    { title: "6. Concrete TTS Request Payload", body: result.promptStructure.ttsPayloadExample },
    { title: "7. Concrete Text-to-Image Payload", body: result.promptStructure.imagePayloadExample },
    { title: "8. Concrete Image-to-Video Payload", body: result.promptStructure.videoPayloadExample },
    { title: "9. Concrete Scene Image Prompt", body: result.promptStructure.sampleImagePrompt },
    { title: "10. Concrete Scene Video Prompt", body: result.promptStructure.sampleVideoPrompt }
  ];

  target.innerHTML = sections.map((section) => `
    <section class="prose-section">
      <h3>${section.title}</h3>
      <pre>${escapeHtml(section.body)}</pre>
    </section>
  `).join("");
}

function renderPromptStructure(result) {
  renderPromptStructureInto(els.promptStructure, result);
}

function sceneAssetFilename(sceneNumber, kind, fallbackExt = "") {
  const ext = fallbackExt || (kind === "image" ? ".png" : kind === "audio" ? ".wav" : ".mp4");
  return `scene-${sceneNumber}-${kind}${ext}`;
}

function fileExtensionFromUrl(url, fallbackExt = "") {
  if (!url || typeof url !== "string") return fallbackExt;
  try {
    const parsed = new URL(toAbsoluteMediaUrl(url), window.location.origin);
    const pathname = parsed.pathname || "";
    const match = pathname.match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : fallbackExt;
  } catch (_) {
    const clean = String(url).split("?")[0];
    const match = clean.match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : fallbackExt;
  }
}

function renderShotPlanInto(target, result) {
  if (!target) return;
  target.innerHTML = result.scenes.map((scene) => {
    const keyframeStatus = renderStatus(scene.keyframeStatus, scene.keyframeJobId);
    const videoStatus = renderStatus(scene.videoStatus, scene.videoJobId);
    const audioStatus = renderStatus(scene.audioStatus || "pending", "");
    const keyframeImage = scene.keyframeUrl
      ? `<img class="shot-image" src="${scene.keyframeUrl}" alt="Scene ${scene.sceneNumber} keyframe">`
      : "";
    const videoPreview = scene.videoUrl
      ? `<video class="shot-image" src="${scene.videoUrl}" controls playsinline preload="metadata"></video>`
      : "";
    const imageDownloadName = sceneAssetFilename(scene.sceneNumber, "image", fileExtensionFromUrl(scene.keyframeUrl, ".png"));
    const videoDownloadName = sceneAssetFilename(scene.sceneNumber, "video", fileExtensionFromUrl(scene.videoUrl, ".mp4"));
    const links = [
      scene.keyframeUrl ? `<a href="${scene.keyframeUrl}" target="_blank" rel="noopener" download="${imageDownloadName}">Download keyframe</a>` : "",
      scene.videoUrl ? `<a href="${scene.videoUrl}" target="_blank" rel="noopener" download="${videoDownloadName}">Download clip</a>` : ""
    ].filter(Boolean).join(" | ");

    return `
      <article class="shot-card">
        <h3>Scene ${scene.sceneNumber}: ${scene.title}</h3>
        <div class="shot-meta">
          <span>${scene.duration}s</span>
          <span>${scene.location}</span>
          <span>${scene.emotion}</span>
        </div>
        <div class="shot-status">
          <div><strong>Keyframe:</strong> ${keyframeStatus}</div>
          <div><strong>Narration:</strong> ${audioStatus}</div>
          <div><strong>Video:</strong> ${videoStatus}</div>
        </div>
        ${keyframeImage}
        ${videoPreview}
        ${links ? `<div class="shot-links">${links}</div>` : ""}
        ${scene.videoError ? `<div class="hint">Video error: ${escapeHtml(scene.videoError)}</div>` : ""}
        ${scene.audioError ? `<div class="hint">Narration error: ${escapeHtml(scene.audioError)}</div>` : ""}
        ${scene.keyframeError ? `<div class="hint">Keyframe error: ${escapeHtml(scene.keyframeError)}</div>` : ""}
        ${scene.videoModel ? `<div class="hint">Video model: ${escapeHtml(scene.videoModel)}</div>` : ""}
        <div><strong>Scene Purpose:</strong> ${scene.purpose}</div>
        <div><strong>Keyframe Prompt:</strong><br>${escapeHtml(scene.keyframePrompt)}</div>
        <div style="margin-top:12px;"><strong>Video Prompt:</strong><br>${escapeHtml(scene.videoPrompt)}</div>
      </article>
    `;
  }).join("");
}

function renderShotPlan(result) {
  renderShotPlanInto(els.shotPlan, result);
}

function renderStatus(status, jobId) {
  const label = status === "ready"
    ? "Ready"
    : status === "skipped"
      ? "Skipped"
      : status === "failed"
        ? "Failed"
        : status === "processing"
          ? "Processing"
          : status === "queued"
            ? "Queued"
            : "Pending";
  const suffix = jobId ? ` (${jobId})` : "";
  return `<span class="status-pill status-${status}">${label}${suffix}</span>`;
}

function renderOpsInto(target, result) {
  if (!target) return;
  const ops = result.ops;
  const workflowExplanation = `
Workflow Process (Concrete)
${ops.endpointPlan.map((item, idx) => `${idx + 1}. ${item}`).join("\n")}

Execution Contracts
${ops.concreteExecution.map((item) => `- ${item}`).join("\n")}

Assembly Checklist
${ops.assemblyChecklist.map((item) => `- ${item}`).join("\n")}

Scene Timeline
${ops.timeline}
  `.trim();

  const node = document.createElement("section");
  node.className = "prose-section";
  node.innerHTML = `<h3>11. Overall Workflow (Concrete)</h3><pre>${escapeHtml(workflowExplanation)}</pre>`;
  target.appendChild(node);
}

function renderOps(result) {
  renderOpsInto(els.promptStructure, result);
}

function renderAll(result) {
  renderPromptStructure(result);
  renderOps(result);
  renderShotPlan(result);
}

function normalizeStoredScene(scene, index) {
  const durations = [22, 22, 22, 22, 23, 23, 23, 23];
  const sceneNumber = Number(scene?.sceneNumber || index + 1) || index + 1;
  return {
    sceneNumber,
    title: String(scene?.title || `Scene ${sceneNumber}`),
    purpose: String(scene?.purpose || "Advance the dramatic arc."),
    summary: String(scene?.summary || "Continue the story progression with continuity-safe character actions."),
    location: String(scene?.location || "Primary story location"),
    camera: String(scene?.camera || "cinematic medium shot"),
    emotion: String(scene?.emotion || "rising tension"),
    duration: Number(scene?.duration || durations[index] || 22),
    keyframePrompt: String(scene?.keyframePrompt || ""),
    videoPrompt: String(scene?.videoPrompt || ""),
    keyframeStatus: scene?.keyframeStatus || (scene?.keyframeUrl ? "ready" : "pending"),
    videoStatus: scene?.videoStatus || (scene?.videoUrl ? "ready" : "pending"),
    audioStatus: scene?.audioStatus || (scene?.audioUrl ? "ready" : "pending"),
    keyframeJobId: scene?.keyframeJobId || "",
    videoJobId: scene?.videoJobId || "",
    keyframeUrl: String(scene?.keyframeUrl || ""),
    videoUrl: String(scene?.videoUrl || ""),
    audioUrl: String(scene?.audioUrl || ""),
    videoModel: String(scene?.videoModel || ""),
    narrationText: String(scene?.narrationText || ""),
    keyframeError: String(scene?.keyframeError || ""),
    audioError: String(scene?.audioError || ""),
    videoError: String(scene?.videoError || "")
  };
}

function buildStoredManifest(result, payload) {
  return {
    version: 2,
    kind: "short-drama-example-output",
    savedAt: new Date().toISOString(),
    payload: {
      brief: payload?.brief || result?.payload?.brief || "",
      title: payload?.title || result?.payload?.title || "",
      logline: payload?.logline || result?.payload?.logline || "",
      genre: payload?.genre || result?.payload?.genre || "",
      tone: payload?.tone || result?.payload?.tone || "",
      protagonist: payload?.protagonist || result?.payload?.protagonist || "",
      secondary: payload?.secondary || result?.payload?.secondary || "",
      visualWorld: payload?.visualWorld || result?.payload?.visualWorld || "",
      narration: payload?.narration || result?.payload?.narration || "",
      runtime: result?.totalRuntime || payload?.runtime || 180,
      resolution: payload?.resolution || result?.payload?.resolution || "1280x720",
      audioUrl: payload?.audioUrl || result?.payload?.audioUrl || ""
    },
    totalRuntime: result?.totalRuntime || payload?.runtime || 180,
    llmModel: result?.llmModel || "",
    finalVideoUrl: result?.finalVideoUrl || "",
    scenes: Array.isArray(result?.scenes) ? result.scenes.map((scene, index) => normalizeStoredScene(scene, index)) : [],
    bible: result?.bible || null,
    promptStructure: result?.promptStructure || null,
    ops: result?.ops || null
  };
}

function absolutizeManifestMediaUrls(manifest) {
  if (!manifest || typeof manifest !== "object") return manifest;
  const clone = JSON.parse(JSON.stringify(manifest));
  if (clone.finalVideoUrl) {
    clone.finalVideoUrl = toAbsoluteMediaUrl(clone.finalVideoUrl);
  }
  if (clone.payload?.audioUrl) {
    clone.payload.audioUrl = toAbsoluteMediaUrl(clone.payload.audioUrl);
  }
  if (Array.isArray(clone.scenes)) {
    clone.scenes = clone.scenes.map((scene) => ({
      ...scene,
      keyframeUrl: scene?.keyframeUrl ? toAbsoluteMediaUrl(scene.keyframeUrl) : "",
      videoUrl: scene?.videoUrl ? toAbsoluteMediaUrl(scene.videoUrl) : "",
      audioUrl: scene?.audioUrl ? toAbsoluteMediaUrl(scene.audioUrl) : "",
      videoModel: scene?.videoModel || ""
    }));
  }
  return clone;
}

function hydrateStoredResult(data) {
  if (!data) return null;

  const sourcePayload = data.payload && typeof data.payload === "object"
    ? data.payload
    : {
        brief: data.brief || "",
        title: data.title || "",
        runtime: data.runtime || 180,
        resolution: data.resolution || "1280x720",
        audioUrl: data.audio || ""
      };
  const derived = deriveFromBrief(sourcePayload.brief || data.brief || "");
  const payload = {
    ...derived,
    ...sourcePayload,
    runtime: Number(sourcePayload.runtime || data.runtime || 180) || 180,
    resolution: String(sourcePayload.resolution || data.resolution || "1280x720"),
    audioUrl: String(sourcePayload.audioUrl || data.audio || "")
  };

  const scenes = Array.isArray(data.scenes) ? data.scenes.map(normalizeStoredScene) : buildScenes(payload);
  const bible = data.bible || buildCharacterBible(payload);
  const promptStructure = data.promptStructure || buildPromptStructure(payload, scenes, bible);
  const ops = data.ops || buildOpsPlan(payload, scenes);
  const totalRuntime = Number(data.totalRuntime || scenes.reduce((sum, scene) => sum + scene.duration, 0)) || payload.runtime;

  return {
    payload,
    scenes,
    bible,
    promptStructure,
    ops,
    llmModel: data.llmModel || "",
    totalRuntime,
    finalVideoUrl: String(data.finalVideoUrl || data.finalVideo || data.video || "")
  };
}

function escapeHtml(value) {
  const text = value == null ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSchedulerRetryableError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("qosmaxsubmitjobperuserlimit") ||
    text.includes("scheduler policy/resource limits") ||
    text.includes("slurm submission rejected") ||
    text.includes("assigning requested gpu/s") ||
    text.includes("gres/gpu:1") ||
    text.includes("job violates accounting/qos policy")
  );
}

function isTransportRetryableError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("fetch failed") ||
    text.includes("upstream request failed") ||
    text.includes("failed to fetch media") ||
    text.includes("econnreset") ||
    text.includes("socket hang up")
  );
}

function getVideoRetryDelayMs(attempt) {
  return Math.min(300000, 30000 * Math.max(1, attempt));
}

function getKeyframeRetryDelayMs(attempt) {
  return Math.min(300000, 45000 * Math.max(1, attempt));
}

function getTransportCooldownMs() {
  const failures = Math.max(1, state.transportFailureCount);
  return Math.min(300000, 45000 * failures);
}

function isVideoModelFallbackError(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("quota") ||
    text.includes("free quota") ||
    text.includes("insufficientbalance") ||
    text.includes("insufficient balance") ||
    text.includes("billable") ||
    text.includes("model not") ||
    text.includes("not enabled") ||
    text.includes("unsupported model") ||
    text.includes("model code") ||
    text.includes("http 403") ||
    text.includes("http 429")
  );
}

function getVideoModelOptions(model) {
  const runtimeConfig = getRuntimeConfig();
  const capabilities = runtimeConfig.video_model_capabilities?.[model] || {};
  const parameters = {
    resolution: runtimeConfig.video_resolution,
    prompt_extend: false,
    watermark: false
  };
  if (capabilities.supportsDuration) {
    parameters.duration = runtimeConfig.video_duration_seconds;
  }
  if (capabilities.supportsAudioFlag) {
    parameters.audio = false;
  }
  return parameters;
}

async function waitForTransportCooldown(reason = "Cluster connection unstable") {
  const now = Date.now();
  if (state.transportCooldownUntil <= now) return;
  const waitMs = state.transportCooldownUntil - now;
  appendLiveLog(`${reason}. Pausing submissions for ${Math.ceil(waitMs / 1000)}s to let the connection recover.`, "processing");
  await sleep(waitMs);
}

function markTransportFailure(message) {
  state.transportFailureCount = Math.min(state.transportFailureCount + 1, 6);
  const cooldownMs = getTransportCooldownMs();
  state.transportCooldownUntil = Date.now() + cooldownMs;
  return cooldownMs;
}

function clearTransportPressure() {
  state.transportFailureCount = 0;
  state.transportCooldownUntil = 0;
}

function summarizeWorkflowFailures(result) {
  const failedKeyframes = result.scenes.filter((scene) => scene.keyframeStatus === "failed").map((scene) => scene.sceneNumber);
  const failedVideos = result.scenes.filter((scene) => scene.videoStatus === "failed" || !scene.videoUrl).map((scene) => scene.sceneNumber);
  return { failedKeyframes, failedVideos };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }
  return response.json();
}

async function pollTask(taskId, label, timeoutMs = 900000, onProgress = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await fetchJson(`/api/v1/tasks/${taskId}`);
    const taskStatus = status?.output?.task_status;
    const elapsedSec = Math.floor((Date.now() - start) / 1000);
    if (typeof onProgress === "function") {
      onProgress({ taskStatus, elapsedSec, taskId, label, status });
    }
    if (taskStatus === "SUCCEEDED") return status;
    if (taskStatus === "FAILED") throw new Error(`${label} failed: ${status?.output?.message || "unknown error"}`);
    await sleep(2000);
  }
  throw new Error(`${label} timed out`);
}

function resolveImageUrl(task, fallbackId) {
  const url = task?.output?.results?.[0]?.url;
  if (url) return toAbsoluteMediaUrl(url);
  return toAbsoluteMediaUrl(`/result/${fallbackId}`);
}

function resolveVideoUrl(task, fallbackId) {
  const url = task?.output?.results?.video_url;
  if (url) return toAbsoluteMediaUrl(url);
  return toAbsoluteMediaUrl(`/result/${fallbackId}`);
}

function resolveAudioUrl(task, fallbackId) {
  const url = task?.output?.task_result?.audio_url;
  if (url) return toAbsoluteMediaUrl(url);
  return toAbsoluteMediaUrl(`/result/${fallbackId}`);
}

function toAbsoluteMediaUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("data:")) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) {
    const localPrefixes = ["/.runtime/", "/example-assets/", "/example-output.json"];
    const useLocalOrigin = localPrefixes.some((prefix) => url.startsWith(prefix));
    const base = useLocalOrigin
      ? window.location.origin
      : (state.upstreamBaseUrl || window.location.origin);
    return `${base.replace(/\/+$/, "")}${url}`;
  }
  return url;
}

function isClusterResultUrl(url) {
  if (!url || typeof url !== "string") return false;
  return (
    url.includes("/result/") &&
    (url.includes("localhost:8001") || url.includes("127.0.0.1:8001") || url.startsWith("/result/"))
  );
}

async function fetchAsDataUrl(url) {
  const absUrl = toAbsoluteMediaUrl(url);
  let lastError = null;
  for (let attempt = 1; attempt <= MEDIA_FETCH_RETRIES; attempt += 1) {
    try {
      const proxyUrl = `/api/local/fetch-media?url=${encodeURIComponent(absUrl)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch media ${absUrl}: HTTP ${response.status}`);
      }
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error(`Failed to convert media ${absUrl} to data URL`));
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      lastError = error;
      if (attempt < MEDIA_FETCH_RETRIES) {
        appendLiveLog(`Retrying media fetch (${attempt}/${MEDIA_FETCH_RETRIES}) for ${absUrl}`, "processing");
        await sleep(1000 * attempt);
      }
    }
  }
  throw new Error(`Failed to fetch media after ${MEDIA_FETCH_RETRIES} attempts: ${lastError?.message || absUrl}`);
}

async function prepareVideoInputRef(url, label) {
  const absUrl = toAbsoluteMediaUrl(url);
  void label;
  return absUrl;
}

async function submitKeyframe(scene) {
  await waitForTransportCooldown("Keyframe submissions paused");
  const runtimeConfig = getRuntimeConfig();
  const payload = {
    model: runtimeConfig.image_model,
    input: { prompt: scene.keyframePrompt },
    parameters: { size: "1280*720", prompt_extend: false }
  };
  const response = await fetchJson(`/api/v1/services/aigc/text2image/image-synthesis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return {
    taskId: response?.output?.task_id || response?.request_id || "",
    immediateUrl: response?.output?.results?.[0]?.url || ""
  };
}

async function submitVideo(scene, imageUrl) {
  await waitForTransportCooldown("Video submissions paused");
  const runtimeConfig = getRuntimeConfig();
  const modelSequence = Array.isArray(runtimeConfig.video_model_sequence) && runtimeConfig.video_model_sequence.length
    ? runtimeConfig.video_model_sequence
    : defaultRuntimeConfig().video_model_sequence;
  let lastError = null;

  for (const model of modelSequence) {
    const payload = {
      model,
      input: {
        img_url: toAbsoluteMediaUrl(imageUrl),
        prompt: scene.videoPrompt
      },
      parameters: getVideoModelOptions(model)
    };

    try {
      const response = await fetchJson(`/api/v1/services/aigc/video-generation/video-synthesis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      scene.videoModel = model;
      return {
        taskId: response?.output?.task_id || response?.request_id || "",
        immediateUrl: response?.output?.results?.video_url || "",
        model
      };
    } catch (error) {
      lastError = error;
      if (model !== modelSequence[modelSequence.length - 1] && isVideoModelFallbackError(error.message)) {
        appendLiveLog(`Video model ${model} unavailable or out of quota for scene ${scene.sceneNumber}. Trying next fallback model...`, "processing");
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No video model available");
}

async function submitTts(payload) {
  const text = typeof payload === "string" ? payload : payload?.narration;
  if (!text) {
    throw new Error("Narration text is required for TTS");
  }
  const runtimeConfig = getRuntimeConfig();

  const ttsPayload = {
    model: runtimeConfig.tts_model,
    input: { text },
    parameters: {
      voice: "Cherry",
      language_type: "English",
      format: "wav",
      stream: false
    }
  };

  const response = await fetchJson(`/api/v1/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ttsPayload)
  });

  const immediateAudio = response?.output?.task_result?.audio_url;
  if (immediateAudio) {
    return toAbsoluteMediaUrl(immediateAudio);
  }

  const taskId = response?.output?.task_id || response?.request_id;
  if (!taskId) {
    throw new Error("No task id returned from TTS");
  }

  const task = await pollTask(taskId, "TTS generation", 5400000, ({ taskStatus, elapsedSec }) => {
    updateStatusBanner("processing", `Generating narration audio (TTS)... ${taskStatus} (${elapsedSec}s)`);
    setProgress(state.progress.done, `TTS ${taskStatus} (${elapsedSec}s)`);
  });
  return resolveAudioUrl(task, taskId);
}

async function generateSceneNarration(result, scene) {
  scene.audioStatus = "processing";
  renderShotPlan(result);
  const audioUrl = await submitTts(scene.narrationText);
  scene.audioUrl = audioUrl;
  scene.audioStatus = "ready";
  renderShotPlan(result);
}

async function generateSceneNarrations(result) {
  appendLiveLog("Submitting scene narration audio jobs...", "processing");
  await mapWithConcurrency(result.scenes, SCENE_TTS_CONCURRENCY, async (scene) => {
    try {
      await generateSceneNarration(result, scene);
    } catch (error) {
      scene.audioStatus = "failed";
      scene.audioError = error.message;
      renderShotPlan(result);
      appendLiveLog(`Scene ${scene.sceneNumber} narration failed: ${error.message}`, "failed");
    }
  });
}

async function generateSceneKeyframe(result, scene) {
  setStatus("processing", `Generating keyframe for scene ${scene.sceneNumber}...`);
  scene.keyframeStatus = "processing";
  scene.keyframeError = "";
  renderShotPlan(result);

  let lastError = null;
  for (let attempt = 1; attempt <= KEYFRAME_SUBMIT_RETRIES; attempt += 1) {
    try {
      if (attempt > 1) {
        appendLiveLog(`Retrying scene ${scene.sceneNumber} keyframe submission (${attempt}/${KEYFRAME_SUBMIT_RETRIES})...`, "processing");
      }
      const keyframeResult = await submitKeyframe(scene);
      clearTransportPressure();
      scene.keyframeJobId = keyframeResult.taskId || "sync";
      if (keyframeResult.immediateUrl) {
        scene.keyframeStatus = "ready";
        scene.keyframeUrl = keyframeResult.immediateUrl;
      } else if (keyframeResult.taskId) {
        const task = await pollTask(
          keyframeResult.taskId,
          `Keyframe scene ${scene.sceneNumber}`,
          5400000,
          ({ taskStatus, elapsedSec }) => {
            updateStatusBanner("processing", `Scene ${scene.sceneNumber} keyframe: ${taskStatus} (${elapsedSec}s)`);
            setProgress(state.progress.done, `Scene ${scene.sceneNumber} keyframe: ${taskStatus} (${elapsedSec}s)`);
          }
        );
        scene.keyframeStatus = "ready";
        scene.keyframeUrl = resolveImageUrl(task, keyframeResult.taskId);
      } else {
        throw new Error("Keyframe generation did not return a task id or URL");
      }
      bumpProgress(`Scene ${scene.sceneNumber} keyframe ready`);
      renderShotPlan(result);
      return;
    } catch (error) {
      lastError = error;
      if (isTransportRetryableError(error.message)) {
        const cooldownMs = markTransportFailure(error.message);
        appendLiveLog(
          `Scene ${scene.sceneNumber} keyframe hit a transport failure. Cooling down for ${Math.round(cooldownMs / 1000)}s before retry...`,
          "processing"
        );
        scene.keyframeStatus = "pending";
        scene.keyframeError = "";
        renderShotPlan(result);
        if (attempt === KEYFRAME_SUBMIT_RETRIES) {
          throw error;
        }
        await sleep(cooldownMs);
        continue;
      }
      if (!isSchedulerRetryableError(error.message) || attempt === KEYFRAME_SUBMIT_RETRIES) {
        throw error;
      }
      const delayMs = getKeyframeRetryDelayMs(attempt);
      appendLiveLog(
        `Scene ${scene.sceneNumber} keyframe hit scheduler limits. Waiting ${Math.round(delayMs / 1000)}s before retry...`,
        "processing"
      );
      scene.keyframeStatus = "pending";
      scene.keyframeError = "";
      renderShotPlan(result);
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`Keyframe scene ${scene.sceneNumber} failed after retries`);
}

async function generateSceneVideo(result, scene) {
  setStatus("processing", `Generating video clip for scene ${scene.sceneNumber}...`);
  await flushUi();
  scene.videoStatus = "processing";
  scene.videoError = "";
  renderShotPlan(result);
  const imageInputRef = await prepareVideoInputRef(scene.keyframeUrl, `scene ${scene.sceneNumber} keyframe`);
  let lastError = null;

  for (let attempt = 1; attempt <= VIDEO_SUBMIT_RETRIES; attempt += 1) {
    try {
      if (attempt > 1) {
        appendLiveLog(`Retrying scene ${scene.sceneNumber} video submission (${attempt}/${VIDEO_SUBMIT_RETRIES})...`, "processing");
      }

      const videoResult = await submitVideo(scene, imageInputRef);
      clearTransportPressure();
      scene.videoJobId = videoResult.taskId || "sync";
      if (videoResult.immediateUrl) {
        scene.videoStatus = "ready";
        scene.videoUrl = videoResult.immediateUrl;
        bumpProgress(`Scene ${scene.sceneNumber} video ready`);
        renderShotPlan(result);
        return;
      }
      if (!videoResult.taskId) {
        throw new Error("Video generation did not return a task id or URL");
      }

      const task = await pollTask(
        videoResult.taskId,
        `Video scene ${scene.sceneNumber}`,
        VIDEO_TASK_TIMEOUT_MS,
        ({ taskStatus, elapsedSec }) => {
          updateStatusBanner("processing", `Scene ${scene.sceneNumber} video: ${taskStatus} (${elapsedSec}s)`);
          setProgress(state.progress.done, `Scene ${scene.sceneNumber} video: ${taskStatus} (${elapsedSec}s)`);
        }
      );
      scene.videoStatus = "ready";
      scene.videoUrl = resolveVideoUrl(task, videoResult.taskId);
      bumpProgress(`Scene ${scene.sceneNumber} video ready`);
      renderShotPlan(result);
      return;
    } catch (error) {
      lastError = error;
      if (isTransportRetryableError(error.message)) {
        const cooldownMs = markTransportFailure(error.message);
        appendLiveLog(
          `Scene ${scene.sceneNumber} video hit a transport failure. Cooling down for ${Math.round(cooldownMs / 1000)}s before retry...`,
          "processing"
        );
        scene.videoStatus = "pending";
        scene.videoError = "";
        renderShotPlan(result);
        if (attempt === VIDEO_SUBMIT_RETRIES) {
          throw error;
        }
        await sleep(cooldownMs);
        continue;
      }
      if (!isSchedulerRetryableError(error.message) || attempt === VIDEO_SUBMIT_RETRIES) {
        throw error;
      }
      const delayMs = getVideoRetryDelayMs(attempt);
      appendLiveLog(
        `Scene ${scene.sceneNumber} video hit scheduler limits. Waiting ${Math.round(delayMs / 1000)}s before retry...`,
        "processing"
      );
      scene.videoStatus = "pending";
      scene.videoError = "";
      renderShotPlan(result);
      await sleep(delayMs);
    }
  }

  throw lastError || new Error(`Video scene ${scene.sceneNumber} failed after retries`);
}

async function retryFailedVideosBeforeAssembly(result) {
  const retryScenes = result.scenes.filter((scene) => scene.keyframeUrl && !scene.videoUrl);
  if (!retryScenes.length) return;

  appendLiveLog(`Retry pass: attempting ${retryScenes.length} missing scene video ${retryScenes.length === 1 ? "job" : "jobs"} before final assembly.`, "processing");
  for (const scene of retryScenes) {
    try {
      await generateSceneVideo(result, scene);
    } catch (error) {
      scene.videoStatus = "failed";
      scene.videoError = error.message;
      renderShotPlan(result);
      appendLiveLog(`Retry pass failed for scene ${scene.sceneNumber}: ${error.message}`, "failed");
    }
  }
}

async function runWorkflow(result) {
  const done = [];
  renderPipeline("story", done);
  setStatus("processing", "Building story plan and character bible...");
  await flushUi();
  await sleep(200);
  renderAll(result);

  done.push("story", "bible");
  renderPipeline("keyframes", done);

  await flushUi();
  appendLiveLog(
    `Scene pipeline started: reliability mode runs keyframes first, then scene videos enter a small queue.`,
    "processing"
  );
  const keyframeSubmitConcurrency = KEYFRAME_SUBMIT_CONCURRENCY;
  await mapWithConcurrency(result.scenes, keyframeSubmitConcurrency, async (scene) => {
    try {
      await generateSceneKeyframe(result, scene);
    } catch (error) {
      scene.keyframeStatus = "failed";
      scene.keyframeError = error.message;
      renderShotPlan(result);
      appendLiveLog(`Scene ${scene.sceneNumber} keyframe failed: ${error.message}`, "failed");
      return;
    }
    if (!done.includes("keyframes") && result.scenes.every((item) => item.keyframeStatus === "ready")) {
      done.push("keyframes");
    }
    renderPipeline("keyframes", done);
  });

  if (!done.includes("keyframes")) {
    done.push("keyframes");
  }
  renderPipeline("clips", done);

  const readyScenes = result.scenes.filter((scene) => scene.keyframeStatus === "ready" && scene.keyframeUrl);
  const videoSubmitConcurrency = Math.min(VIDEO_ACTIVE_TASK_LIMIT, readyScenes.length || VIDEO_ACTIVE_TASK_LIMIT);
  appendLiveLog(
    `Video queue cap active: up to ${videoSubmitConcurrency} scene video ${videoSubmitConcurrency === 1 ? "job" : "jobs"} will be active at once to avoid scheduler submit limits.`,
    "processing"
  );
  readyScenes.forEach((scene) => {
    scene.videoStatus = "queued";
  });
  renderShotPlan(result);

  await mapWithConcurrency(readyScenes, videoSubmitConcurrency, async (scene) => {
    try {
      await generateSceneVideo(result, scene);
    } catch (error) {
      scene.videoStatus = "failed";
      scene.videoError = error.message;
      renderShotPlan(result);
      appendLiveLog(`Scene ${scene.sceneNumber} video failed: ${error.message}`, "failed");
    }
  });

  done.push("clips", "assembly");
  renderPipeline(null, done);
  return result;
}

function storePremade(result, payload) {
  const manifest = buildStoredManifest(result, payload);
  localStorage.setItem(PREMADE_KEY, JSON.stringify(manifest));
  renderPremade(manifest);
}

function renderPremade(payload) {
  const manifest = hydrateStoredResult(payload);
  if (!manifest) return;
  renderShowcase(manifest);
}

function clearCurrentFinalOutput() {
  if (els.finalOutputPanel) els.finalOutputPanel.style.display = "none";
  if (els.finalVideoPlayer) els.finalVideoPlayer.removeAttribute("src");
  if (els.finalVideoDownload) {
    els.finalVideoDownload.href = "#";
    els.finalVideoDownload.style.display = "none";
  }
  if (els.finalAudioDownload) {
    els.finalAudioDownload.href = "#";
    els.finalAudioDownload.style.display = "none";
  }
  if (els.saveExampleOutput) {
    els.saveExampleOutput.style.display = "none";
  }
}

function renderCurrentFinalOutput(result) {
  const manifest = hydrateStoredResult(result);
  if (!manifest || !manifest.finalVideoUrl) {
    clearCurrentFinalOutput();
    return;
  }

  if (els.finalOutputPanel) els.finalOutputPanel.style.display = "block";
  if (els.finalVideoPlayer) els.finalVideoPlayer.src = toAbsoluteMediaUrl(manifest.finalVideoUrl);
  if (els.finalVideoDownload) {
    els.finalVideoDownload.href = toAbsoluteMediaUrl(manifest.finalVideoUrl);
    els.finalVideoDownload.download = `video${fileExtensionFromUrl(manifest.finalVideoUrl, ".mp4")}`;
    els.finalVideoDownload.style.display = "";
  }
  if (els.finalAudioDownload) {
    const audioUrl = manifest.payload?.audioUrl || "";
    els.finalAudioDownload.href = audioUrl ? toAbsoluteMediaUrl(audioUrl) : "#";
    els.finalAudioDownload.download = `audio${fileExtensionFromUrl(audioUrl, ".wav")}`;
    els.finalAudioDownload.style.display = audioUrl ? "" : "none";
  }
  if (els.saveExampleOutput) {
    els.saveExampleOutput.style.display = "block";
  }
}

function renderShowcase(data) {
  if (!els.demoEmpty || !els.demoContent || !els.demoBrief) return;
  const result = hydrateStoredResult(data);
  const hasRenderableExample = result && (result.finalVideoUrl || result.scenes.some((scene) => scene.keyframeUrl || scene.videoUrl));
  if (!hasRenderableExample) {
    els.demoEmpty.style.display = "block";
    els.demoContent.style.display = "none";
    els.demoBrief.innerHTML = "<p class=\"hint\">No permanent example output yet.</p>";
    return;
  }

  els.demoEmpty.style.display = "none";
  els.demoContent.style.display = "block";
  els.demoBrief.innerHTML = `
    <strong>${escapeHtml(result.payload.title || "Short Drama Example Output")}</strong>
    <p class="hint" style="margin-top:10px;">${escapeHtml(result.payload.brief || "No brief stored.")}</p>
    <p class="hint">Runtime: ${escapeHtml(result.totalRuntime)}s | Resolution: ${escapeHtml(result.payload.resolution)}</p>
  `;

  if (els.demoStatusBanner) {
    els.demoStatusBanner.className = "status-banner complete";
    els.demoStatusBanner.textContent = `Workflow complete. Planned ${result.totalRuntime}s short drama at ${result.payload.resolution}.`;
  }
  if (els.demoProgressFill) els.demoProgressFill.style.width = "100%";
  if (els.demoProgressText) els.demoProgressText.textContent = "100%";
  if (els.demoProgressDetail) els.demoProgressDetail.textContent = "Workflow complete";

  if (els.demoFinalOutputPanel) {
    els.demoFinalOutputPanel.style.display = (result.finalVideoUrl || result.payload.audioUrl) ? "block" : "none";
  }
  if (els.demoFinalVideo) els.demoFinalVideo.src = toAbsoluteMediaUrl(result.finalVideoUrl || "");
  if (els.demoFinalVideoDownload) {
    els.demoFinalVideoDownload.href = result.finalVideoUrl ? toAbsoluteMediaUrl(result.finalVideoUrl) : "#";
    els.demoFinalVideoDownload.download = `video${fileExtensionFromUrl(result.finalVideoUrl, ".mp4")}`;
    els.demoFinalVideoDownload.style.display = result.finalVideoUrl ? "" : "none";
  }
  if (els.demoFinalAudioDownload) {
    const audioUrl = result.payload.audioUrl || "";
    els.demoFinalAudioDownload.href = audioUrl ? toAbsoluteMediaUrl(audioUrl) : "#";
    els.demoFinalAudioDownload.download = `audio${fileExtensionFromUrl(audioUrl, ".wav")}`;
    els.demoFinalAudioDownload.style.display = audioUrl ? "" : "none";
  }
  if (els.demoNarrationAudio) els.demoNarrationAudio.src = toAbsoluteMediaUrl(result.payload.audioUrl || "");
  if (els.demoImage) {
    const firstImage = result.scenes.find((scene) => scene.keyframeUrl)?.keyframeUrl || "";
    els.demoImage.src = toAbsoluteMediaUrl(firstImage);
  }

  renderPipelineInto(els.demoPipeline, null, pipelineDefinitions.map((step) => step.id));
  renderShotPlanInto(els.demoShotPlan, result);
  renderPromptStructureInto(els.demoPromptStructure, result);
  renderOpsInto(els.demoPromptStructure, result);
}

function setActiveView(view) {
  const showWorkflow = view !== "showcase";
  if (els.workflowView) els.workflowView.style.display = showWorkflow ? "" : "none";
  if (els.showcaseView) els.showcaseView.style.display = showWorkflow ? "none" : "";
  if (els.workflowTab) els.workflowTab.classList.toggle("active", showWorkflow);
  if (els.showcaseTab) els.showcaseTab.classList.toggle("active", !showWorkflow);
}

async function loadPremadeFromServer() {
  try {
    const response = await fetch(EXAMPLE_OUTPUT_PATH, { cache: "no-store" });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    renderPremade(payload);
    return true;
  } catch (_) {
    return false;
  }
}

async function loadFallbackPremadeFromServer() {
  try {
    const response = await fetch("/premade.json", { cache: "no-store" });
    if (!response.ok) return false;
    const payload = await response.json();
    renderPremade(payload);
    return true;
  } catch (_) {
    return false;
  }
}

async function saveCurrentRunAsExample() {
  if (!state.result) {
    appendLiveLog("No completed workflow run available to save as example output.", "failed");
    return;
  }
  if (!state.result.finalVideoUrl) {
    appendLiveLog("Cannot save example output until the stitched final video is ready.", "failed");
    return;
  }
  const payload = absolutizeManifestMediaUrls(buildStoredManifest(state.result, state.result.payload || inputPayload()));
  try {
    const response = await fetchJson("/api/local/example-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    appendLiveLog("Current run saved as permanent example output assets.", "ready");
    const persisted = await fetchJson(EXAMPLE_OUTPUT_PATH, { cache: "no-store" });
    renderShowcase(persisted);
  } catch (error) {
    appendLiveLog(`Failed to save example output: ${error.message}`, "failed");
  }
}

async function loadRuntimeConfig() {
  try {
    const health = await fetchJson("/api/health");
    const base = health?.base_url;
    if (typeof base === "string" && base.trim()) {
      state.upstreamBaseUrl = base.replace(/\/+$/, "");
    }
    state.runtimeConfig = {
      ...defaultRuntimeConfig(),
      ...(health?.runtime || {})
    };
  } catch (_) {
    state.upstreamBaseUrl = "";
    state.runtimeConfig = defaultRuntimeConfig();
  }
}

async function waitForMediaEvent(element, eventName) {
  await new Promise((resolve, reject) => {
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`Media event failed: ${eventName}`));
    };
    const cleanup = () => {
      element.removeEventListener(eventName, onDone);
      element.removeEventListener("error", onError);
    };
    element.addEventListener(eventName, onDone, { once: true });
    element.addEventListener("error", onError, { once: true });
  });
}

async function assembleFinalVideoInBrowser(result, sceneAudioUrls) {
  const clipUrls = result.scenes.map((scene) => scene.videoUrl).filter(Boolean);
  const audioUrls = (Array.isArray(sceneAudioUrls) ? sceneAudioUrls : result.scenes.map((scene) => scene.audioUrl)).filter(Boolean);
  if (!clipUrls.length || !audioUrls.length) {
    throw new Error("Missing clip URLs or narration audio for final assembly");
  }
  if (typeof document === "undefined" || typeof MediaRecorder === "undefined" || typeof AudioContext === "undefined") {
    throw new Error("Browser does not support in-page final video assembly");
  }

  const mimeType = chooseRecorderMimeType();
  if (!mimeType) {
    throw new Error("No supported MediaRecorder MIME type for final assembly");
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable");
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  const audio = document.createElement("audio");
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.src = toAbsoluteMediaUrl(audioUrls[0]);

  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const audioSource = audioContext.createMediaElementSource(audio);
  audioSource.connect(destination);
  audioSource.connect(audioContext.destination);

  const stream = canvas.captureStream(30);
  destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));

  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  let drawHandle = 0;
  const drawFrame = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawHandle = requestAnimationFrame(drawFrame);
  };

  const finalBlob = await new Promise(async (resolve, reject) => {
    recorder.onerror = () => reject(new Error("MediaRecorder failed during final assembly"));
    recorder.onstop = () => {
      cancelAnimationFrame(drawHandle);
      resolve(new Blob(chunks, { type: mimeType }));
    };

    try {
      appendLiveLog("Assembling final video in browser...", "processing");
      await audioContext.resume();
      recorder.start(1000);

      const audioReady = waitForMediaEvent(audio, "canplaythrough");
      audio.load();
      await audioReady;
      const audioPlay = audio.play().catch(() => null);

      for (const [index, clipUrl] of clipUrls.entries()) {
        appendLiveLog(`Assembly pass: scene ${index + 1}/${clipUrls.length}`, "processing");
        video.src = toAbsoluteMediaUrl(clipUrl);
        video.load();
        await waitForMediaEvent(video, "loadedmetadata");
        if (!drawHandle) {
          drawHandle = requestAnimationFrame(drawFrame);
        }
        await video.play();
        await waitForMediaEvent(video, "ended");
      }

      await audioPlay;
      recorder.stop();
    } catch (error) {
      cancelAnimationFrame(drawHandle);
      try { recorder.stop(); } catch (_) { void 0; }
      reject(error);
    }
  });

  try {
    audio.pause();
    video.pause();
    audioContext.close();
  } catch (_) {
    void 0;
  }

  return URL.createObjectURL(finalBlob);
}

async function assembleFinalVideo(result, sceneAudioUrls) {
  const assemblyScenes = result.scenes.filter((scene) => scene.videoUrl && scene.audioUrl);
  const clipUrls = assemblyScenes.map((scene) => scene.videoUrl);
  const audioUrls = assemblyScenes.map((scene) => scene.audioUrl);
  if (!clipUrls.length || !audioUrls.length) {
    throw new Error("Missing clip URLs or narration audio for final assembly");
  }

  try {
    appendLiveLog("Assembling final video on local server...", "processing");
    const response = await fetchJson("/api/local/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clip_urls: clipUrls.map((url) => toAbsoluteMediaUrl(url)),
        scene_audio_urls: assemblyScenes.map((scene) => toAbsoluteMediaUrl(scene.audioUrl)),
        scene_durations: assemblyScenes.map((scene) => scene.duration)
      })
    });
    if (response?.audio_url) {
      result.payload.audioUrl = toAbsoluteMediaUrl(response.audio_url);
    }
    return toAbsoluteMediaUrl(response?.url || "");
  } catch (serverError) {
    appendLiveLog(`Server-side assembly unavailable, falling back to browser assembly: ${serverError.message}`, "failed");
    return await assembleFinalVideoInBrowser(result, audioUrls);
  }
}

async function handleRun() {
  const payload = inputPayload();
  const sceneCount = buildScenes(payload).length;
  resetProgress(1 + sceneCount * 2, "Starting workflow...");
  clearTransportPressure();
  state.workflowRunning = true;
  els.runWorkflow.disabled = true;
  els.runWorkflow.textContent = "Running...";
  clearLiveLog();
  appendLiveLog("Workflow started.", "processing");
  appendLiveLog("Official DashScope image and video tasks can take time. Keep this page open while jobs run and final assembly completes.", "processing");

  try {
    const result = await buildResult(payload);
    const plannedPayload = result.payload;
    plannedPayload.narration = buildCombinedSceneNarration(result);

    const ttsPromise = (async () => {
      setTtsStatus("Generating...", "processing");
      await flushUi();
      await generateSceneNarrations(result);
      setTtsStatus("Ready", "ready");
      appendLiveLog("Scene narration audio ready.", "ready");
      bumpProgress("Scene narration audio ready");
      return result.scenes.map((scene) => scene.audioUrl).filter(Boolean);
    })();

    const workflowPromise = runWorkflow(result);
    const [sceneAudioUrls] = await Promise.all([ttsPromise, workflowPromise]);
    plannedPayload.audioUrl = sceneAudioUrls[0] || "";
    plannedPayload.sceneAudioUrls = sceneAudioUrls;

    await retryFailedVideosBeforeAssembly(result);

    try {
      result.finalVideoUrl = await assembleFinalVideo(result, sceneAudioUrls);
      appendLiveLog("Final stitched video ready.", "ready");
    } catch (assemblyError) {
      appendLiveLog(`Final assembly skipped: ${assemblyError.message}`, "failed");
    }
    state.result = result;
    renderCurrentFinalOutput(result);
    renderAll(result);
    storePremade(result, plannedPayload);
    const failures = summarizeWorkflowFailures(result);
    const hasFailures = failures.failedKeyframes.length || failures.failedVideos.length;
    if (result.finalVideoUrl && !hasFailures) {
      setStatus("complete", `Workflow complete. Planned ${result.totalRuntime}s short drama at ${plannedPayload.resolution}.`);
      setProgress(state.progress.total, "Workflow complete");
    } else if (result.finalVideoUrl) {
      setStatus("processing", `Workflow completed with failures. Missing or failed scenes: ${failures.failedVideos.join(", ") || "none"}. Final video was assembled from available clips.`);
      setProgress(state.progress.done, "Workflow completed with failures");
    } else {
      const failedScenes = failures.failedVideos.length ? failures.failedVideos.join(", ") : "unknown";
      setStatus("idle", `Workflow incomplete. Final assembly failed; missing scene videos: ${failedScenes}.`);
      setProgress(state.progress.done, "Workflow incomplete");
    }
  } catch (error) {
    renderPipeline();
    setStatus("idle", `Workflow failed: ${error.message}`);
    appendLiveLog(`Workflow failed: ${error.message}`, "failed");
    setProgress(state.progress.done, "Workflow failed");
  } finally {
    state.workflowRunning = false;
    els.runWorkflow.disabled = false;
    els.runWorkflow.textContent = "Run Workflow";
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!state.workflowRunning) return;
  event.preventDefault();
  event.returnValue = "";
});

function init() {
  renderPipeline();
  resetProgress(1, "Idle");
  clearCurrentFinalOutput();
  els.runWorkflow.addEventListener("click", handleRun);
  if (els.workflowTab) els.workflowTab.addEventListener("click", () => setActiveView("workflow"));
  if (els.showcaseTab) els.showcaseTab.addEventListener("click", () => setActiveView("showcase"));
  if (els.saveExampleOutput) els.saveExampleOutput.addEventListener("click", saveCurrentRunAsExample);

  const cached = localStorage.getItem(PREMADE_KEY);
  if (cached) {
    try {
      renderPremade(JSON.parse(cached));
    } catch (_) {
      renderShowcase(null);
    }
  } else {
    renderShowcase(null);
  }

  loadRuntimeConfig().then(async () => {
    const loadedExample = await loadPremadeFromServer();
    if (!loadedExample) {
      await loadFallbackPremadeFromServer();
    }
  });
}

init();
