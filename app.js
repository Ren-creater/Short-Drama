const pipelineDefinitions = [
  {
    id: "story",
    label: "Story",
    detail: "Expand the brief into a full runtime-matched shot list."
  },
  {
    id: "bible",
    label: "Character Bible",
    detail: "Lock identity anchors, wardrobe, props, and emotional trajectory."
  },
  {
    id: "keyframes",
    label: "Keyframes",
    detail: "Generate one continuity-safe keyframe per shot."
  },
  {
    id: "clips",
    label: "Video",
    detail: "Generate one 15-second native-audio clip per shot using DashScope 720P."
  },
  {
    id: "assembly",
    label: "Assembly",
    detail: "Normalize and stitch native-audio clips into one final 720p deliverable."
  }
];

const state = {
  result: null,
  upstreamBaseUrl: "",
  runtimeConfig: null,
  runToken: "",
  runGuard: null,
  progress: { done: 0, total: 1 },
  workflowRunning: false,
  transportCooldownUntil: 0,
  transportFailureCount: 0
};

const els = {
  brief: document.getElementById("brief"),
  runWorkflow: document.getElementById("runWorkflow"),
  runMode: document.getElementById("runMode"),
  workflowTab: document.getElementById("workflowTab"),
  showcaseTab: document.getElementById("showcaseTab"),
  workflowView: document.getElementById("workflowView"),
  showcaseView: document.getElementById("showcaseView"),
  liveLog: document.getElementById("liveLog"),
  pipeline: document.getElementById("pipeline"),
  statusBanner: document.getElementById("statusBanner"),
  promptStructure: document.getElementById("promptStructure"),
  runtimeMetric: document.getElementById("runtimeMetric"),
  runtime: document.getElementById("runtime"),
  finalOutputPanel: document.getElementById("finalOutputPanel"),
  finalVideoPlayer: document.getElementById("finalVideoPlayer"),
  finalVideoDownload: document.getElementById("finalVideoDownload"),
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
const VIDEO_TASK_TIMEOUT_MS = 43200000;
const MEDIA_FETCH_RETRIES = 3;
const VIDEO_SUBMIT_RETRIES = 4;

function getRunProfile(modeValue) {
  const clipDuration = getClipDurationSeconds();
  const normalized = String(modeValue || "production").toLowerCase();
  if (normalized === "planner") {
    return {
      id: "planner-production",
      runtime: 180,
      shotCountOverride: 0,
      plannerOnly: true,
      label: "Planner-only production - 180s",
      detail: "Run the full production planner path without calling image/video APIs."
    };
  }
  if (normalized === "plannerpreview") {
    const runtime = Math.max(30, clipDuration * 2);
    return {
      id: "planner-preview",
      runtime,
      shotCountOverride: Math.max(2, Math.ceil(runtime / clipDuration)),
      plannerOnly: true,
      label: `Planner-only preview - ${runtime}s`,
      detail: "Build story plan, prompts, and shot cards without calling image/video APIs."
    };
  }
  if (normalized === "oneshot") {
    return {
      id: "oneshot",
      runtime: clipDuration,
      shotCountOverride: 1,
      plannerOnly: false,
      label: `One-shot validation - ${clipDuration}s`,
      detail: "Call the real image/video pipeline for a single shot only."
    };
  }
  if (normalized === "60" || normalized === "30" || normalized === "180") {
    const runtime = Math.max(30, Number(normalized) || 180);
    return {
      id: runtime === 180 ? "production" : `legacy-${runtime}`,
      runtime,
      shotCountOverride: 0,
      plannerOnly: false,
      label: runtime === 180 ? "3-minute 720p short drama" : `${runtime}s validation run at 720p`,
      detail: runtime === 180 ? "Full production run." : "Legacy validation mode."
    };
  }
  return {
    id: "production",
    runtime: 180,
    shotCountOverride: 0,
    plannerOnly: false,
    label: "3-minute 720p short drama",
    detail: "Full production run."
  };
}

function getRequestedShotCount(payload) {
  const override = Number(payload?.shotCountOverride || 0) || 0;
  if (override > 0) return override;
  return getShotCountForRuntime(payload?.runtime);
}

function defaultRuntimeConfig() {
  return {
    mode: "official-api",
    dashscope_endpoint: "",
    image_model: "qwen-image-plus",
    image_model_sequence: [
      "qwen-image-plus",
      "qwen-image"
    ],
    video_resolution: "720P",
    video_duration_seconds: 15,
    video_model_sequence: [
      "wan2.6-i2v",
      "wan2.6-i2v-flash"
    ],
    video_model_capabilities: {}
  };
}

function getRuntimeConfig() {
  return state.runtimeConfig || defaultRuntimeConfig();
}

function isExampleCaptureEnabled() {
  return Boolean(getRuntimeConfig().enable_example_capture);
}

function getClipDurationSeconds() {
  const runtimeConfig = getRuntimeConfig();
  return Math.max(5, Number(runtimeConfig.video_duration_seconds || 15) || 15);
}

function getShotCountForRuntime(runtimeSeconds) {
  const clipDuration = getClipDurationSeconds();
  return Math.max(1, Math.ceil((Number(runtimeSeconds) || 180) / clipDuration));
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
  const safeBrief = brief || "";
  return {
    title: "",
    logline: "",
    genre: "",
    tone: "",
    protagonist: "",
    secondary: "",
    visualWorld: ""
  };
}

function mergeStoryIntoPayload(payload, story) {
  const mergedStory = story && typeof story === "object" ? story : {};
  return {
    ...payload,
    title: String(mergedStory.title || payload.title || payload.brief || "Short Drama").trim(),
    logline: String(mergedStory.logline || payload.logline || payload.brief || "").trim(),
    genre: String(mergedStory.genre || payload.genre || "").trim(),
    tone: String(mergedStory.tone || payload.tone || "").trim(),
    protagonist: String(mergedStory.primary || payload.protagonist || "").trim(),
    secondary: String(mergedStory.secondary || payload.secondary || "").trim(),
    visualWorld: String(mergedStory.visualWorld || payload.visualWorld || "").trim()
  };
}

function inputPayload() {
  const profile = getRunProfile(els.runMode?.value);
  const runtime = profile.runtime;
  els.runtimeMetric.textContent = profile.label;
  if (els.runtime) {
    els.runtime.value = String(runtime);
  }
  const brief = els.brief.value.trim();
  const derived = deriveFromBrief(brief);

  return {
    brief,
    ...derived,
    runtime,
    shotCountOverride: profile.shotCountOverride,
    plannerOnly: profile.plannerOnly,
    runProfile: profile.id,
    resolution: "1280x720"
  };
}

function buildScenes(payload) {
  return buildScenesFromBeats(payload, defaultBeats(payload));
}

function defaultBeats(payload) {
  const count = getRequestedShotCount(payload);
  const phases = [
    {
      title: "Opening Image",
      purpose: "Establish the initial situation.",
      summary: "Introduce the core visual situation implied by the brief and define the first stable image of the story world.",
      location: "Initial setting",
      camera: "establishing push-in",
      emotion: "emergent tension"
    },
    {
      title: "First Shift",
      purpose: "Introduce the first meaningful change.",
      summary: "A visible shift in action, scale, energy, or context turns the initial setup into a story beat with consequences.",
      location: "Changed setting",
      camera: "tight reactive framing",
      emotion: "uneasy momentum"
    },
    {
      title: "Complication",
      purpose: "Introduce resistance or instability.",
      summary: "Something in the moment becomes more difficult, contradictory, unstable, or emotionally charged, raising pressure on the scene.",
      location: "Pressure zone",
      camera: "lateral drift with interruptive cuts",
      emotion: "rising strain"
    },
    {
      title: "Escalation",
      purpose: "Push the visual idea into a stronger state.",
      summary: "The central visual idea intensifies through stronger motion, clearer stakes, or a more dramatic transformation of the situation.",
      location: "Escalation space",
      camera: "close action fragments",
      emotion: "driven intensity"
    },
    {
      title: "Turning Point",
      purpose: "Reveal the decisive turn in the short arc.",
      summary: "A decisive visual moment changes how the viewer understands the situation and redirects the scene toward resolution.",
      location: "Turning point",
      camera: "tracking reveal",
      emotion: "sharp reversal"
    },
    {
      title: "Consequence",
      purpose: "Show the impact of the turn.",
      summary: "The aftermath of the turning point plays out in concrete visual terms, clarifying what has changed in the world of the story.",
      location: "Consequence space",
      camera: "measured reaction framing",
      emotion: "charged clarity"
    },
    {
      title: "Resolution",
      purpose: "Deliver the visual payoff.",
      summary: "The sequence resolves into its clearest and most satisfying visual state, answering the dramatic movement established earlier.",
      location: "Resolution setting",
      camera: "stabilizing crescendo",
      emotion: "earned release"
    },
    {
      title: "Afterglow",
      purpose: "End on the final image.",
      summary: "The final beat holds on the changed state of the story world and leaves a clear closing image for the short.",
      location: "Aftermath setting",
      camera: "wide shot resolving into still portrait",
      emotion: "quiet resolution"
    }
  ];

  return Array.from({ length: count }, (_, index) => {
    const phase = phases[Math.min(phases.length - 1, Math.floor((index / count) * phases.length))];
    return {
      ...phase,
      title: `${phase.title} ${index + 1}`,
      summary: `${phase.summary} This beat covers shot ${index + 1} of ${count}.`,
    };
  });
}

function sanitizeBeat(beat, index) {
  const idx = index + 1;
  const cleanPlannerField = (value, fallback) => {
    let text = String(value || fallback || "").replace(/\s+/g, " ").trim();
    if (!text) return String(fallback || "");
    const letsUseMatches = [...text.matchAll(/let'?s use\s+"([^"]{1,120})"/gi)];
    if (letsUseMatches.length) {
      text = letsUseMatches[letsUseMatches.length - 1][1];
    }
    text = text
      .replace(/^[\s"'`]+|[\s"'`]+$/g, "")
      .replace(/^max\s+\d+\s+words?\s*[-:]\s*/gi, "")
      .replace(/^max\s+\d+\s+words?\s*/gi, "")
      .replace(/^ok\s*[-:.]?\s*/gi, "")
      .replace(/^\s*good\.\s*/gi, "")
      .replace(/\s*\(\d+\s+words?\)[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*max\s+\d+\s+words?[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*wait\s+max\s+\d+\s+words?[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*ok\b[^.,;:!?)]*/gi, "")
      .replace(/\s*-\s*good\.?/gi, "")
      .replace(/\s*good\.\s*/gi, " ")
      .replace(/\s*or\s+"[^"]{1,120}"/gi, "")
      .replace(/^[^"]{0,40}"([^"]{1,120})"[^"]*$/i, "$1")
      .replace(/\s*or\s+[^.;:!?]{1,120}$/i, "")
      .replace(/^[^:]+:\s*/i, (match) => /^(scene|shot)\s+\d+\s*:/i.test(match) ? match : "")
      .replace(/[)"'`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    text = text.replace(/^[\s"'`]+|[\s"'`]+$/g, "").trim();
    if (/^(string|number|boolean|array|object|null|undefined|n\/a|na|\.\.\.)$/i.test(text)) {
      return String(fallback || "");
    }
    if (/^(interi|exteri|locat|camer|purpos|emotio)$/i.test(text)) {
      return String(fallback || "");
    }
    return text || String(fallback || "");
  };
  const sharedPrompt = cleanPlannerField(beat?.prompt, "");
  const title = cleanPlannerField(beat?.title, sharedPrompt ? "" : `Scene ${idx}`);
  const titleLooksGeneric = /^beat\s+\d+$/i.test(title) || /^scene\s+\d+$/i.test(title);
  const purpose = cleanPlannerField(beat?.purpose, sharedPrompt ? "" : "Advance the dramatic arc.");
  let summary = cleanPlannerField(beat?.summary || sharedPrompt, "");
  const location = cleanPlannerField(beat?.location, sharedPrompt ? "" : "Story setting");
  const camera = cleanPlannerField(beat?.camera, sharedPrompt ? "" : "cinematic framing");
  const emotion = cleanPlannerField(beat?.emotion, sharedPrompt ? "" : "rising tension");
  if (summary.length < 24 || /\b(reason|because|until|that|with|while|through|across|toward|into|shows?)\s*[a-z]{0,2}$/i.test(summary)) {
    const repaired = [sharedPrompt, purpose, location && location !== "Story setting" ? `in ${location}` : "", emotion && emotion !== "rising tension" ? `with ${emotion}` : ""]
      .filter(Boolean)
      .join(" ");
    summary = repaired || "A decisive moment advances the story in a visually coherent way.";
  }
  return {
    title: titleLooksGeneric ? (purpose || `Scene ${idx}`) : (title || `Scene ${idx}`),
    purpose,
    summary,
    location,
    camera,
    emotion,
    audio: cleanPlannerField(beat?.audio, ""),
    prompt: sharedPrompt
  };
}


async function requestLlmSceneBeats(payload) {
  const shotCount = getRequestedShotCount(payload);
  const response = await fetchJson("/api/local/story-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      brief: payload.brief,
      runtime: payload.runtime,
      scene_count: shotCount
    })
  });
  const scenes = Array.isArray(response?.scenes) ? response.scenes.slice(0, shotCount).map(sanitizeBeat) : [];
  if (scenes.length < shotCount) {
    throw new Error("Kimi returned insufficient scene beats");
  }
  return { scenes, story: response?.story || null, model: response?.model || "" };
}

function buildScenesFromBeats(payload, beats) {
  const shotCount = Math.max(1, beats.length || getRequestedShotCount(payload));
  const baseDuration = Math.floor(payload.runtime / shotCount);
  const remainder = payload.runtime % shotCount;
  let total = 0;
  return beats.map((beat, index) => {
    const safeBeat = sanitizeBeat(beat, index);
    const duration = baseDuration + (index < remainder ? 1 : 0);
    total += duration;
    const sceneBeat = {
      ...safeBeat,
      duration
    };
    return {
      ...sceneBeat,
      sceneNumber: index + 1,
      duration,
      cumulative: total,
      keyframePrompt: buildKeyframePrompt(payload, sceneBeat, index + 1),
      videoPrompt: buildVideoPrompt(payload, sceneBeat, index + 1),
      keyframeStatus: "pending",
      videoStatus: "pending",
      videoModel: ""
    };
  });
}

function truncateWords(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function buildNativeAudioDirection(beat, sceneNumber) {
  const audio = String(beat?.audio || "").trim();
  const direction = audio
    ? audio
    : "Use only scene-appropriate diegetic audio inferred by the video model itself, with no extra assumptions from the client.";
  return `Native audio direction for shot ${sceneNumber}: ${direction} Keep sound realistic and synchronized to motion. Avoid voice-over, exact scripted dialogue requirements, dialogue subtitles, or unrelated effects.`;
}

function hasMeaningfulBeatValue(value, fallback = "") {
  const text = String(value || "").trim();
  return Boolean(text && text !== String(fallback || "").trim());
}

function isGenericSceneTitle(scene) {
  const title = String(scene?.title || "").trim();
  if (!title) return true;
  return /^scene\s+\d+$/i.test(title) || /^beat\s+\d+$/i.test(title) || /^shot\s+\d+$/i.test(title);
}

function getSceneDisplayLabel(scene) {
  const shotLabel = `Shot ${scene.sceneNumber}`;
  return isGenericSceneTitle(scene)
    ? shotLabel
    : `Scene ${scene.sceneNumber}: ${scene.title}`;
}

function getSceneTimelineEntry(scene) {
  return isGenericSceneTitle(scene)
    ? `${scene.sceneNumber}. Shot ${scene.sceneNumber}: ${scene.duration}s`
    : `${scene.sceneNumber}. ${scene.title}: ${scene.duration}s`;
}

function buildKeyframePrompt(payload, beat, sceneNumber) {
  const scenePrompt = String(beat?.prompt || "").trim();
  const lines = [
    `Scene ${sceneNumber} keyframe for "${payload.title || payload.brief || "Short Drama"}".`,
    `Brief: ${payload.brief}`
  ];
  if (payload.visualWorld) lines.push(`World style: ${payload.visualWorld}`);
  if (payload.protagonist) lines.push(`Character anchor: ${payload.protagonist}`);
  if (payload.secondary) lines.push(`Secondary anchor: ${payload.secondary}`);
  lines.push(
    scenePrompt ? `Shared scene prompt: ${scenePrompt}` : `Scene action: ${beat.summary}`,
    ...(!scenePrompt && hasMeaningfulBeatValue(beat.camera, "cinematic framing") ? [`Camera: ${beat.camera}.`] : []),
    `Lighting and palette: cinematic realism with coherent contrast, location-appropriate color, and continuity across the full short.`,
    `Consistency rules: preserve the core visual identity, scale logic, defining forms, and recurring elements across shots; avoid random replacement, contradictory details, or continuity drift.`
  );
  return lines.join(" ");
}

function buildVideoPrompt(payload, beat, sceneNumber) {
  const scenePrompt = String(beat?.prompt || "").trim();
  const parts = [
    `Generate a 720p cinematic video clip for scene ${sceneNumber} of "${payload.title || payload.brief || "Short Drama"}".`,
    `Start from the approved keyframe image and preserve its core visual elements and continuity.`
  ];
  if (scenePrompt) {
    parts.push(
      `Shared scene prompt: ${scenePrompt}`,
      `Motion direction: preserve the action, framing, and continuity implied by the shared scene prompt with natural motion blur and coherent movement.`
    );
  } else {
    parts.push(
      `Performance beat: ${beat.emotion}.`,
      `Action beat: ${beat.summary}`,
      `Shot design: ${beat.camera}, natural motion blur, coherent motion language, and visually continuous action.`
    );
  }
  parts.push(
    `Pacing direction: movement and camera timing should support a ${beat.duration}-second clip with clean entry and exit frames for concat.`,
    buildNativeAudioDirection(beat, sceneNumber),
    `Safety constraints: stable forms, stable recurring elements, no sudden background swaps, no subtitle burn-in, and no unrelated intrusions.`
  );
  return parts.join(" ");
}

function buildPromptStructure(payload, scenes, bible) {
  const runtimeConfig = getRuntimeConfig();
  const primaryVideoModel = runtimeConfig.video_model_sequence?.[0] || "wan2.6-i2v";
  const usesSharedScenePrompts = Array.isArray(scenes) && scenes.some((scene) => String(scene?.prompt || "").trim());
  const systemPrompt = [
    "You are a short-drama workflow planner for text, image, and video generation.",
    "Produce outputs that are cinematic, emotionally coherent, and practical for downstream media models.",
    "All scene assets must preserve character identity, wardrobe, props, and environment continuity.",
    `Final target: runtime = ${payload.runtime} seconds, resolution ${payload.resolution}, episodic short-drama pacing.`
  ].join("\n");

  const storyPrompt = [
    `BRIEF: ${payload.brief}`,
    payload.title ? `TITLE: ${payload.title}` : "",
    payload.logline ? `LOGLINE: ${payload.logline}` : "",
    payload.genre ? `GENRE: ${payload.genre}` : "",
    payload.tone ? `TONE: ${payload.tone}` : "",
    `TARGET_RUNTIME_SECONDS: ${payload.runtime}`,
    payload.protagonist ? `PRIMARY_CHARACTER: ${payload.protagonist}` : "",
    payload.secondary ? `SECONDARY_CHARACTER: ${payload.secondary}` : "",
    payload.visualWorld ? `VISUAL_WORLD: ${payload.visualWorld}` : "",
    "TASK: Write a shot-by-shot short-drama outline with escalating stakes, emotional reversals, and a final visual resolution.",
    usesSharedScenePrompts
      ? "OUTPUT FORMAT: JSON with story package plus scenes, each scene including prompt and audio only."
      : "OUTPUT FORMAT: JSON with shots, each item including purpose, summary, camera, emotion, and continuity notes."
  ].filter(Boolean).join("\n");

  const imagePromptTemplate = usesSharedScenePrompts
    ? [
        "[BRIEF]",
        "[STORY_ANCHORS_AND_WORLD_STYLE]",
        "[SHARED_SCENE_PROMPT]",
        "[LIGHTING_AND_COLOR]",
        "[CONSISTENCY_RULES]",
        "[NEGATIVE_CONSTRAINTS: no contradictory details, no random replacement, no text overlays]"
      ].join("\n")
    : [
        "[BRIEF]",
        "[CORE_VISUAL_IDENTITY_OR_FORM]",
        "[RECURRING_ELEMENTS_AND_PROPS]",
        "[LOCATION_AND_TIME]",
        "[DRAMATIC_ACTION]",
        "[CAMERA_AND_COMPOSITION]",
        "[LIGHTING_AND_COLOR]",
        "[CONSISTENCY_RULES]",
        "[NEGATIVE_CONSTRAINTS: no contradictory details, no random replacement, no text overlays]"
      ].join("\n");

  const videoPromptTemplate = usesSharedScenePrompts
    ? [
        "[APPROVED_KEYFRAME_REFERENCE]",
        "[SHARED_SCENE_PROMPT]",
        "[NATIVE_AUDIO_DIRECTION: diegetic ambience and effects only]",
        "[ENVIRONMENT_CONTINUITY]",
        "[DURATION_AND_RESOLUTION_TARGET]",
        "[FAILURE_AVOIDANCE: preserve key visual forms and recurring elements, avoid sudden morphs or unrelated insertions]"
      ].join("\n")
    : [
        "[APPROVED_KEYFRAME_REFERENCE]",
        "[VIDEO_PROMPT_TEXT]",
        "[CHARACTER_PERFORMANCE_BEAT]",
        "[MOTION_DIRECTION_AND_CAMERA_MOVE]",
        "[NATIVE_AUDIO_DIRECTION: diegetic ambience and effects, with optional short natural speech if the shot clearly implies it, no exact scripted dialogue]",
        "[ENVIRONMENT_CONTINUITY]",
        "[DURATION_AND_RESOLUTION_TARGET]",
        "[FAILURE_AVOIDANCE: preserve key visual forms and recurring elements, avoid sudden morphs or unrelated insertions]"
      ].join("\n");

  const continuity = [
    `Primary anchor summary: ${bible.protagonist.anchors.join('; ')}.`,
    bible.secondary.identity ? `Secondary anchor summary: ${bible.secondary.anchors.join('; ')}.` : "",
    `World anchors: ${bible.worldAnchors.join('; ')}.`,
    "Operational rule: each shot gets one hero keyframe, and its video job launches once that shot is ready for the queue.",
    "If a key subject, object, or recurring visual form changes unexpectedly across neighboring shots, issue an image-edit correction pass before launching the corresponding video clip."
  ].filter(Boolean).join("\n");

  const imagePayloadExample = JSON.stringify({
    model: runtimeConfig.image_model_sequence?.[0] || runtimeConfig.image_model,
    input: { prompt: scenes[0].keyframePrompt },
    parameters: { size: "1280*720", prompt_extend: false }
  }, null, 2);

  const videoPayloadExample = JSON.stringify({
    model: primaryVideoModel,
    input: {
      img_url: "<scene_keyframe_url>",
      prompt: scenes[0].videoPrompt
    },
    parameters: getVideoModelOptions(primaryVideoModel)
  }, null, 2);

  return {
    systemPrompt,
    storyPrompt,
    imagePromptTemplate,
    videoPromptTemplate,
    continuity,
    imagePayloadExample,
    videoPayloadExample,
    sampleImagePrompt: scenes[0].keyframePrompt,
    sampleVideoPrompt: scenes[0].videoPrompt
  };
}

function buildOpsPlan(payload, scenes) {
  const timeline = scenes.map((scene) => getSceneTimelineEntry(scene)).join("\n");
  const runtimeConfig = getRuntimeConfig();

  return {
    endpointPlan: [
      "Step 1: user enters one brief; app calls Kimi 2.5 to derive a shot list sized to the target runtime.",
      "Step 2: app submits shot keyframes first, with conservative retry and backoff.",
      "Step 3: after keyframes are ready, shot video jobs are queued in small batches against the official DashScope video endpoint.",
      "Step 4: each video prompt includes diegetic audio direction and optional short human vocal presence so Wan 2.5/2.6 can return clips with sound already embedded.",
      "Step 5: server-side FFmpeg normalizes each clip to 1280x720 and concatenates the final MP4."
    ],
    assemblyChecklist: [
      `Fixed runtime: ${scenes.reduce((sum, scene) => sum + scene.duration, 0)} seconds.`,
      `Shot video fallback order: ${runtimeConfig.video_model_sequence.join(" -> ")}.`,
      `Target clip duration: ${runtimeConfig.video_duration_seconds}s on the Wan 2.6 path.`,
      "Clip audio comes directly from the video model; there is no separate narration track in the production path.",
      `Every finished clip is normalized to 1280x720 before final concat.`,
      "Final deliverable: 1280x720 H.264 MP4 with audio."
    ],
    concreteExecution: [
      "Image endpoint: POST /api/v1/services/aigc/text2image/image-synthesis",
      "Video endpoint: POST /api/v1/services/aigc/video-generation/video-synthesis",
      "Polling endpoint: GET /api/v1/tasks/{task_id}",
      "Execution pattern: keyframes run first; video starts after keyframes succeed and flows through a bounded queue.",
      "Result URLs consumed in-chain: keyframe URL -> native-audio video clip -> final assembly"
    ],
    timeline
  };
}

async function buildResult(payload) {
  let scenes;
  let llmModel = "";
  let resolvedPayload = { ...payload };
  try {
    setStatus("processing", "Generating scene beats with Kimi 2.5...");
    const planned = await requestLlmSceneBeats(payload);
    resolvedPayload = mergeStoryIntoPayload(payload, planned.story);
    scenes = buildScenesFromBeats(resolvedPayload, planned.scenes);
    llmModel = planned.model || "";
    appendLiveLog(`Shot plan generated by ${llmModel || "Kimi"}.`, "ready");
  } catch (error) {
    appendLiveLog(`Kimi planner unavailable, using fallback shot template: ${error.message}`, "failed");
    scenes = buildScenesFromBeats(resolvedPayload, defaultBeats(resolvedPayload));
  }
  const bible = buildCharacterBible(resolvedPayload);
  const promptStructure = buildPromptStructure(resolvedPayload, scenes, bible);
  const ops = buildOpsPlan(resolvedPayload, scenes);

  return {
    payload: resolvedPayload,
    scenes,
    bible,
    llmModel,
    promptStructure,
    ops,
    totalRuntime: scenes.reduce((sum, scene) => sum + scene.duration, 0),
    shotCount: scenes.length
  };
}

function buildCharacterBible(payload) {
  return {
    protagonist: {
      identity: payload.protagonist || "Primary recurring visual form from the Kimi-derived story",
      anchors: [
        "preserve the same defining silhouette, proportions, and identifying traits across all shots",
        "keep the lead subject emotionally legible from shot to shot",
        "maintain wardrobe, fur, markings, or props unless the story explicitly changes them",
        "avoid sudden species, costume, or age drift"
      ]
    },
    secondary: {
      identity: payload.secondary || "",
      anchors: [
        "preserve the same companion or counterpart identity across all shots",
        "keep relative scale and relationship cues stable",
        "maintain distinctive visual traits, props, or markings",
        "avoid random role or appearance changes"
      ]
    },
    worldAnchors: [
      payload.visualWorld || "the environment, color language, and spatial logic should all be inferred from the brief and stay consistent",
      "lens language alternates between intimate detail and wider spatial orientation",
      "repeat environment motifs and color continuity so shots feel part of one world"
    ]
  };
}

function renderOverview(result) {
  if (!els.storySummary || !els.characterSummary || !els.renderSummary || !els.sceneStrip) return;
  const genreLabel = result.payload.genre ? result.payload.genre.toLowerCase() : "short visual story";
  const logline = result.payload.logline || "Kimi derived a concise story package from the user brief for downstream image and video generation.";
  els.storySummary.innerHTML = `
    <p><strong>${result.payload.title}</strong> is structured as a shot list for a ${genreLabel} with a total runtime of <strong>${result.totalRuntime}s</strong>.</p>
    <p>${logline}</p>
  `;

  els.characterSummary.innerHTML = `
    <p><strong>Primary anchor:</strong> ${result.bible.protagonist.identity}</p>
    ${result.bible.secondary.identity ? `<p><strong>Secondary anchor:</strong> ${result.bible.secondary.identity}</p>` : ""}
    <p>Consistency is enforced by preserving subject identity, visual traits, props, scale relationships, and recurring world motifs.</p>
  `;

  els.renderSummary.innerHTML = `
    <p>Render as <strong>${result.payload.resolution}</strong>, target one approved keyframe per shot, then turn each keyframe into a short clip using text + image -> video generation.</p>
    <p>Final assembly combines many short native-audio clips into one runtime-matched timeline.</p>
  `;

  els.sceneStrip.innerHTML = result.scenes.map((scene) => `
    <article class="scene-card">
      <h3>${getSceneDisplayLabel(scene)}</h3>
      <p>${scene.summary}</p>
      <ul>
        <li><strong>Duration:</strong> ${scene.duration}s</li>
        ${hasMeaningfulBeatValue(scene.camera, "cinematic medium shot") ? `<li><strong>Camera:</strong> ${scene.camera}</li>` : ""}
        ${hasMeaningfulBeatValue(scene.emotion, "rising tension") ? `<li><strong>Emotion:</strong> ${scene.emotion}</li>` : ""}
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
    { title: "6. Concrete Text-to-Image Payload", body: result.promptStructure.imagePayloadExample },
    { title: "7. Concrete Image-to-Video Payload", body: result.promptStructure.videoPayloadExample },
    { title: "8. Concrete Scene Image Prompt", body: result.promptStructure.sampleImagePrompt },
    { title: "9. Concrete Scene Video Prompt", body: result.promptStructure.sampleVideoPrompt }
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
    const metaItems = [
      `${scene.duration}s`,
      hasMeaningfulBeatValue(scene.location, "Story setting") ? scene.location : "",
      hasMeaningfulBeatValue(scene.emotion, "rising tension") ? scene.emotion : ""
    ].filter(Boolean);
    const sceneBody = String(scene.prompt || scene.summary || "").trim();
    const purposeLine = String(scene.purpose || "").trim()
      ? `<div><strong>Scene Purpose:</strong> ${scene.purpose}</div>`
      : "";
    const promptDetails = (scene.keyframePrompt || scene.videoPrompt)
      ? `
        <details class="prompt-details">
          <summary>Prompt details</summary>
          ${scene.keyframePrompt ? `<div><strong>Keyframe Prompt:</strong><br>${escapeHtml(scene.keyframePrompt)}</div>` : ""}
          ${scene.videoPrompt ? `<div style="margin-top:12px;"><strong>Video Prompt:</strong><br>${escapeHtml(scene.videoPrompt)}</div>` : ""}
        </details>
      `
      : "";

    return `
      <article class="shot-card">
        <h3>${getSceneDisplayLabel(scene)}</h3>
        ${metaItems.length ? `<div class="shot-meta">${metaItems.map((item) => `<span>${item}</span>`).join("")}</div>` : ""}
        <div class="shot-status">
          <div><strong>Keyframe:</strong> ${keyframeStatus}</div>
          <div><strong>Video:</strong> ${videoStatus}</div>
        </div>
        ${keyframeImage}
        ${videoPreview}
        ${links ? `<div class="shot-links">${links}</div>` : ""}
        ${scene.videoError ? `<div class="hint">Video error: ${escapeHtml(scene.videoError)}</div>` : ""}
        ${scene.keyframeError ? `<div class="hint">Keyframe error: ${escapeHtml(scene.keyframeError)}</div>` : ""}
        ${scene.videoModel ? `<div class="hint">Video model: ${escapeHtml(scene.videoModel)}</div>` : ""}
        ${purposeLine}
        ${sceneBody ? `<div><strong>Scene Beat:</strong> ${escapeHtml(sceneBody)}</div>` : ""}
        ${promptDetails}
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
  return `<span class="status-pill status-${status}">${label}</span>`;
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
  const prompt = String(scene?.prompt || "");
  return {
    sceneNumber,
    title: String(scene?.title || `Scene ${sceneNumber}`),
    purpose: String(scene?.purpose || (prompt ? "" : "Advance the dramatic arc.")),
    summary: String(scene?.summary || prompt || "Continue the story progression with continuity-safe character actions."),
    prompt,
    location: String(scene?.location || (prompt ? "" : "Primary story location")),
    camera: String(scene?.camera || (prompt ? "" : "cinematic medium shot")),
    emotion: String(scene?.emotion || (prompt ? "" : "rising tension")),
    duration: Number(scene?.duration || durations[index] || 22),
    keyframePrompt: String(scene?.keyframePrompt || ""),
    videoPrompt: String(scene?.videoPrompt || ""),
    keyframeStatus: scene?.keyframeStatus || (scene?.keyframeUrl ? "ready" : "pending"),
    videoStatus: scene?.videoStatus || (scene?.videoUrl ? "ready" : "pending"),
    keyframeJobId: scene?.keyframeJobId || "",
    videoJobId: scene?.videoJobId || "",
    keyframeUrl: String(scene?.keyframeUrl || ""),
    videoUrl: String(scene?.videoUrl || ""),
    videoModel: String(scene?.videoModel || ""),
    keyframeError: String(scene?.keyframeError || ""),
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
      runtime: result?.totalRuntime || payload?.runtime || 180,
      resolution: payload?.resolution || result?.payload?.resolution || "1280x720"
    },
    totalRuntime: result?.totalRuntime || payload?.runtime || 180,
    shotCount: Array.isArray(result?.scenes) ? result.scenes.length : getShotCountForRuntime(payload?.runtime || 180),
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
  if (Array.isArray(clone.scenes)) {
    clone.scenes = clone.scenes.map((scene) => ({
      ...scene,
      keyframeUrl: scene?.keyframeUrl ? toAbsoluteMediaUrl(scene.keyframeUrl) : "",
      videoUrl: scene?.videoUrl ? toAbsoluteMediaUrl(scene.videoUrl) : "",
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
        resolution: data.resolution || "1280x720"
      };
  const derived = deriveFromBrief(sourcePayload.brief || data.brief || "");
  const payload = {
    ...derived,
    ...sourcePayload,
    runtime: Number(sourcePayload.runtime || data.runtime || 180) || 180,
    resolution: String(sourcePayload.resolution || data.resolution || "1280x720")
  };

  const scenes = Array.isArray(data.scenes) ? data.scenes.map(normalizeStoredScene) : buildScenes(payload);
  const bible = data.bible || buildCharacterBible(payload);
  const promptStructure = data.promptStructure || buildPromptStructure(payload, scenes, bible);
  const ops = data.ops || buildOpsPlan(payload, scenes);
  const totalRuntime = Number(data.totalRuntime || scenes.reduce((sum, scene) => sum + scene.duration, 0)) || payload.runtime;
  const shotCount = Number(data.shotCount || scenes.length) || scenes.length;

  return {
    payload,
    scenes,
    bible,
    promptStructure,
    ops,
    llmModel: data.llmModel || "",
    totalRuntime,
    shotCount,
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

function isImageModelFallbackError(message) {
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
    parameters.audio = true;
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
  const headers = new Headers(options.headers || {});
  if (state.runToken && String(url || "").startsWith("/api/")) {
    headers.set("X-Workflow-Run-Token", state.runToken);
  }
  const response = await fetch(url, {
    ...options,
    headers
  });
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
  const url = task?.output?.video_url || task?.output?.results?.video_url;
  if (url) return toAbsoluteMediaUrl(url);
  return toAbsoluteMediaUrl(`/result/${fallbackId}`);
}

function resolveAudioUrl(task, fallbackId) {
  const url = task?.output?.audio?.url || task?.output?.task_result?.audio_url;
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
  const modelSequence = Array.isArray(runtimeConfig.image_model_sequence) && runtimeConfig.image_model_sequence.length
    ? runtimeConfig.image_model_sequence
    : [runtimeConfig.image_model || defaultRuntimeConfig().image_model];
  let lastError = null;

  for (const model of modelSequence) {
    const payload = {
      model,
      input: { prompt: scene.keyframePrompt },
      parameters: { size: "1280*720", prompt_extend: false }
    };

    try {
      const response = await fetchJson(`/api/v1/services/aigc/text2image/image-synthesis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return {
        taskId: response?.output?.task_id || response?.request_id || "",
        immediateUrl: response?.output?.results?.[0]?.url || "",
        model
      };
    } catch (error) {
      lastError = error;
      if (model !== modelSequence[modelSequence.length - 1] && isImageModelFallbackError(error.message)) {
        appendLiveLog(`Image model ${model} unavailable or out of quota for scene ${scene.sceneNumber}. Trying next fallback model...`, "processing");
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error("No image model available");
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
    `Shot pipeline started: the planner now targets many short beats so the final runtime matches ${getClipDurationSeconds()}-second generation reality.`,
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

function markPlannerOnlyResult(result) {
  result.scenes.forEach((scene) => {
    scene.keyframeStatus = "skipped";
    scene.videoStatus = "skipped";
    scene.keyframeError = "";
    scene.videoError = "";
  });
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
  if (els.saveExampleOutput) {
    els.saveExampleOutput.style.display = isExampleCaptureEnabled() ? "block" : "none";
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
    <p class="hint">Runtime: ${escapeHtml(result.totalRuntime)}s | Shots: ${escapeHtml(result.shotCount || result.scenes.length)} | Resolution: ${escapeHtml(result.payload.resolution)}</p>
  `;

  if (els.demoStatusBanner) {
    els.demoStatusBanner.className = "status-banner complete";
    els.demoStatusBanner.textContent = `Workflow complete. Planned ${result.totalRuntime}s short drama across ${result.shotCount || result.scenes.length} shots at ${result.payload.resolution}.`;
  }
  if (els.demoProgressFill) els.demoProgressFill.style.width = "100%";
  if (els.demoProgressText) els.demoProgressText.textContent = "100%";
  if (els.demoProgressDetail) els.demoProgressDetail.textContent = "Workflow complete";

  if (els.demoFinalOutputPanel) {
    els.demoFinalOutputPanel.style.display = result.finalVideoUrl ? "block" : "none";
  }
  if (els.demoFinalVideo) els.demoFinalVideo.src = toAbsoluteMediaUrl(result.finalVideoUrl || "");
  if (els.demoFinalVideoDownload) {
    els.demoFinalVideoDownload.href = result.finalVideoUrl ? toAbsoluteMediaUrl(result.finalVideoUrl) : "#";
    els.demoFinalVideoDownload.download = `video${fileExtensionFromUrl(result.finalVideoUrl, ".mp4")}`;
    els.demoFinalVideoDownload.style.display = result.finalVideoUrl ? "" : "none";
  }
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
    state.runGuard = health?.run_guard || null;
  } catch (_) {
    state.upstreamBaseUrl = "";
    state.runtimeConfig = defaultRuntimeConfig();
    state.runGuard = null;
  }
  applyRunGuardState();
}

function applyRunGuardState() {
  if (!els.runWorkflow || state.workflowRunning) return;
  const exhausted = Boolean(state.runGuard?.exhausted);
  els.runWorkflow.disabled = exhausted;
  els.runWorkflow.textContent = exhausted ? "Run Limit Reached" : "Generate Short Drama";
  if (exhausted && els.statusBanner) {
    updateStatusBanner("idle", `Production run limit reached (${state.runGuard.used_runs}/${state.runGuard.max_runs}). New runs are blocked.`);
  }
}

async function reserveProductionRun() {
  const response = await fetchJson("/api/local/run-guard/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  state.runToken = String(response?.token || "").trim();
  state.runGuard = response;
  if (Number.isFinite(response?.remaining_runs)) {
    appendLiveLog(`Production run reserved. ${response.remaining_runs} run${response.remaining_runs === 1 ? "" : "s"} remaining.`, "processing");
  }
  return response;
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

async function assembleFinalVideoInBrowser() {
  throw new Error("Server-side FFmpeg assembly is required for native-audio clip concatenation");
}

async function assembleFinalVideo(result) {
  const assemblyScenes = result.scenes.filter((scene) => scene.videoUrl);
  const clipUrls = assemblyScenes.map((scene) => scene.videoUrl);
  if (!clipUrls.length) {
    throw new Error("Missing clip URLs for final assembly");
  }

  try {
    appendLiveLog("Assembling final video on local server...", "processing");
    const response = await fetchJson("/api/local/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clip_urls: clipUrls.map((url) => toAbsoluteMediaUrl(url)),
        scene_durations: assemblyScenes.map((scene) => scene.duration)
      })
    });
    return toAbsoluteMediaUrl(response?.url || "");
  } catch (serverError) {
    appendLiveLog(`Server-side assembly unavailable, falling back to browser assembly: ${serverError.message}`, "failed");
    return await assembleFinalVideoInBrowser(result);
  }
}

async function handleRun() {
  const payload = inputPayload();
  const profile = getRunProfile(els.runMode?.value);
  const sceneCount = getRequestedShotCount(payload);
  clearTransportPressure();
  state.workflowRunning = true;
  els.runWorkflow.disabled = true;
  els.runWorkflow.textContent = "Generating...";
  clearLiveLog();
  state.runToken = "";

  try {
    if (!profile.plannerOnly) {
      await reserveProductionRun();
    }
    resetProgress(profile.plannerOnly ? 1 : 1 + sceneCount * 2, "Starting workflow...");
    appendLiveLog("Workflow started.", "processing");
    appendLiveLog(`Planned runtime: ${payload.runtime}s across ${sceneCount} shots at ${payload.resolution}.`, "processing");
    appendLiveLog(profile.detail, "processing");
    if (!profile.plannerOnly) {
      appendLiveLog("Official DashScope image and video tasks can take time. Keep this page open while jobs run and final assembly completes.", "processing");
    }
    const result = await buildResult(payload);
    const plannedPayload = result.payload;
    if (profile.plannerOnly) {
      markPlannerOnlyResult(result);
      state.result = result;
      clearCurrentFinalOutput();
      renderAll(result);
      renderPipeline(null, ["story", "bible"]);
      setStatus("complete", `Planner-only run complete. Built ${result.shotCount || result.scenes.length} shots and prompt structure without calling image/video APIs.`);
      setProgress(state.progress.total, "Planner-only run complete");
      return;
    }
    await runWorkflow(result);

    await retryFailedVideosBeforeAssembly(result);

    try {
      result.finalVideoUrl = await assembleFinalVideo(result);
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
      setStatus("complete", `Workflow complete. Planned ${result.totalRuntime}s short drama across ${result.shotCount || result.scenes.length} shots at ${plannedPayload.resolution}.`);
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
    state.runToken = "";
    applyRunGuardState();
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
  inputPayload();
  els.runWorkflow.addEventListener("click", handleRun);
  if (els.runMode) {
    els.runMode.addEventListener("change", () => {
      inputPayload();
    });
  }
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
    await loadPremadeFromServer();
  });
}

init();



