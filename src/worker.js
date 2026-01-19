// FILE: src/worker.js

const BUILD = "worker__2026-01-19__v5_store_on_regru";

function corsHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || "https://aistylemate.ru";
  const allowOrigin = origin && origin.startsWith(allow) ? origin : allow;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Secret",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, origin = "", env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Build": BUILD,
      ...corsHeaders(origin, env),
    },
  });
}

function isFileLike(v) {
  return (
    v &&
    typeof v === "object" &&
    typeof v.arrayBuffer === "function" &&
    typeof v.size === "number" &&
    typeof v.type === "string"
  );
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function safeId() {
  const arr = crypto.getRandomValues(new Uint8Array(12));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sniffIsPng(fileLike) {
  try {
    const ab = await fileLike.arrayBuffer();
    const b = new Uint8Array(ab);
    if (b.length < 8) return false;
    return (
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a
    );
  } catch {
    return false;
  }
}

async function fileToDataUrl(file) {
  const mime = file.type || "image/jpeg";
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

function extractOutputText(data) {
  let aiText = "";
  if (data?.output && Array.isArray(data.output)) {
    for (const out of data.output) {
      if (!out?.content || !Array.isArray(out.content)) continue;
      for (const c of out.content) {
        if (c?.type === "output_text" && typeof c.text === "string") aiText += c.text + "\n";
      }
    }
  }
  if (typeof data?.output_text === "string") aiText = data.output_text;
  return aiText.trim();
}

function tryParseJsonFromText(text) {
  if (!text || typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") return v;
  } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    if (v && typeof v === "object") return v;
  } catch {}
  return null;
}

function normalizeArchetype(obj) {
  if (!obj || typeof obj !== "object") return null;
  const type = typeof obj.type === "string" ? obj.type.trim() : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  let bullets = [];
  if (Array.isArray(obj.bullets)) {
    bullets = obj.bullets
      .filter((x) => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 4);
  }
  if (!type || !reason) return null;
  while (bullets.length < 4) bullets.push("—");
  return { type, reason, bullets };
}

async function callOpenAIResponses(env, payload) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}

  if (!r.ok) {
    return { ok: false, error: "OpenAI error", debug: data || raw };
  }
  return { ok: true, data: data || {} };
}

async function callOpenAIImageEdit(env, imagePngBytes, prompt, size = "512x512") {
  const form = new FormData();
  form.append("model", env.IMAGE_MODEL || "gpt-image-1");
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("n", "1");

  const blob = new Blob([imagePngBytes], { type: "image/png" });
  form.append("image", blob, "input.png");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });

  const raw = await r.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}

  if (!r.ok) {
    const msg =
      (data && data.error && data.error.message) ||
      `HTTP ${r.status}`;

    return {
      ok: false,
      error: msg,
      debug: data || raw,
      status: r.status,
    };
  }

  const b64 = data?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) {
    return { ok: false, error: "No b64_json", debug: data };
  }

  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return { ok: true, pngBytes: bin };
}

async function uploadPngToReg(env, { job, slot, pngBytes }) {
  const url = String(env.REGRU_STORE_URL || "").trim();
  const secret = String(env.REGRU_STORE_SECRET || "").trim();
  if (!url) throw new Error("REGRU_STORE_URL not set");
  if (!secret) throw new Error("REGRU_STORE_SECRET not set");

  const fd = new FormData();
  fd.append("job", job);
  fd.append("slot", slot);
  fd.append("file", new Blob([pngBytes], { type: "image/png" }), `${slot}.png`);

  const r = await fetch(url, {
    method: "POST",
    headers: { "X-Worker-Secret": secret },
    body: fd,
  });

  const raw = await r.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}

  if (!r.ok || !data?.ok || !data?.url) {
    throw new Error(`regru store failed: ${raw.slice(0, 300)}`);
  }

  return String(data.url);
}

// ===== /submit (анализ) =====
async function handleSubmit(request, env, origin) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return json({ ok: false, error: "Ожидается multipart/form-data" }, 400, origin, env);
  }
  if (!env.OPENAI_API_KEY) {
    return json({ ok: false, error: "OPENAI_API_KEY не задан" }, 500, origin, env);
  }

  const form = await request.formData();
  const email = String(form.get("email") || "").trim();
  const face = form.get("face");
  const full = form.get("full");

  if (!isValidEmail(email)) return json({ ok: false, error: "Некорректный email" }, 400, origin, env);
  if (!isFileLike(face) || !isFileLike(full)) return json({ ok: false, error: "Нужно 2 фото: face и full" }, 400, origin, env);

  const maxMb = Number(env.MAX_FILE_MB || 4);
  const max = maxMb * 1024 * 1024;
  if (face.size > max || full.size > max) return json({ ok: false, error: `Файл слишком большой (макс ${maxMb}MB)` }, 400, origin, env);

  const faceUrl = await fileToDataUrl(face);
  const fullUrl = await fileToDataUrl(full);

  const prompt = [
    'Ты — эксперт по "типажам внешности из TikTok" (вайб-архетипы).',
    "На входе 2 фото: (1) лицо, (2) полный рост.",
    "",
    "Задача:",
    '- Выбери РОВНО ОДИН типаж (короткое название на русском, пример: "Луна", "Солнце", "Лёд", "Муза", "Нимфа", "Дива").',
    "- Объясни почему (1–2 предложения: черты, контраст, линии/силуэт).",
    "- Дай 4 коротких признака (2–5 слов каждый).",
    "",
    "Верни СТРОГО JSON. Без пояснений, без Markdown.",
    'Формат: {"type":"...","reason":"...","bullets":["...","...","...","..."]}',
  ].join("\n");

  const payload = {
    model: env.DEFAULT_MODEL || "gpt-4.1-mini",
    input: [
      { role: "user", content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: faceUrl },
        { type: "input_image", image_url: fullUrl },
      ]},
    ],
  };

  const oa = await callOpenAIResponses(env, payload);
  if (!oa.ok) return json({ ok: false, error: oa.error, debug: oa.debug }, 502, origin, env);

  const aiText = extractOutputText(oa.data);
  const parsed = tryParseJsonFromText(aiText);
  const result = normalizeArchetype(parsed);

  if (!result) return json({ ok: false, error: "AI вернул невалидный JSON", aiTextPreview: aiText.slice(0, 400) }, 502, origin, env);
  return json({ ok: true, result }, 200, origin, env);
}

// ===== /outfits/start =====
async function handleOutfitsStart(request, env, origin) {
  if (!env.OUTFIT_JOBS) return json({ ok: false, error: "OUTFIT_JOBS binding not set" }, 500, origin, env);

  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) {
    return json({ ok: false, error: "Ожидается multipart/form-data" }, 400, origin, env);
  }

  const form = await request.formData();
  const email = String(form.get("email") || "").trim();
  const event = String(form.get("event") || "").trim();
  const archetypeRaw = String(form.get("archetype") || "").trim();
  const full = form.get("full");

  if (!isValidEmail(email)) return json({ ok: false, error: "Некорректный email" }, 400, origin, env);
  if (!event) return json({ ok: false, error: "Пустое мероприятие" }, 400, origin, env);

  let archetype = null;
  try { archetype = JSON.parse(archetypeRaw); } catch {}
  if (!archetype || typeof archetype !== "object" || !archetype.type || !archetype.reason) {
    return json({ ok: false, error: "Некорректный archetype" }, 400, origin, env);
  }

  if (!isFileLike(full)) return json({ ok: false, error: "Нет файла full" }, 400, origin, env);

  const looksPng = (full.type || "").toLowerCase() === "image/png" || (full.type || "") === "application/octet-stream" || (full.type || "") === "";
  if (!looksPng || !(await sniffIsPng(full))) return json({ ok: false, error: "Нужно PNG (квадрат) для генерации", gotType: full.type }, 400, origin, env);

  if (full.size > 4 * 1024 * 1024) return json({ ok: false, error: "PNG слишком большой (макс 4MB)" }, 400, origin, env);

  const job = safeId();

  // сохраняем input.png на reg.ru
  const inputBytes = new Uint8Array(await full.arrayBuffer());
  const inputUrl = await uploadPngToReg(env, { job, slot: "input", pngBytes: inputBytes });

  const id = env.OUTFIT_JOBS.idFromName(job);
  const stub = env.OUTFIT_JOBS.get(id);

  await stub.fetch("https://do.local/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job,
      email,
      event,
      archetype,
      inputUrl,
      size: env.OUTFIT_SIZE || "1024x1024",
    }),
  });

  await stub.fetch("https://do.local/run", { method: "POST" });

  return json({ ok: true, job }, 200, origin, env);
}

async function handleOutfitsStatus(request, env, origin) {
  if (!env.OUTFIT_JOBS) return json({ ok: false, error: "OUTFIT_JOBS binding not set" }, 500, origin, env);

  const url = new URL(request.url);
  const job = String(url.searchParams.get("job") || "").trim();
  if (!/^[a-f0-9]{24}$/.test(job)) return json({ ok: false, error: "Bad job" }, 400, origin, env);

  const id = env.OUTFIT_JOBS.idFromName(job);
  const stub = env.OUTFIT_JOBS.get(id);

  const r = await stub.fetch("https://do.local/status");
  const data = await r.json().catch(() => null);
  if (!data) return json({ ok: false, error: "Bad status" }, 500, origin, env);

  return json(data, 200, origin, env);
}

// ===== Durable Object =====
export class OUTFIT_JOBS {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body?.job || !body?.inputUrl) return new Response("Bad init", { status: 400 });

      await this.state.storage.put("job", {
        job: String(body.job),
        email: String(body.email || ""),
        event: String(body.event || ""),
        archetype: body.archetype || {},
        inputUrl: String(body.inputUrl),
        size: String(body.size || "512x512"),
        status: "queued",
        images: [],
        error: "",
        updatedAt: Date.now(),
      });

      return new Response("ok");
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const job = await this.state.storage.get("job");
      if (!job) return new Response("No job", { status: 404 });
      if (job.status === "running" || job.status === "saving" || job.status === "done") return new Response("ok");

      await this.state.storage.put("job", { ...job, status: "running", updatedAt: Date.now() });

      try {
        const imgResp = await fetch(job.inputUrl);
        if (!imgResp.ok) throw new Error("Cannot fetch inputUrl");
        const inputBytes = new Uint8Array(await imgResp.arrayBuffer());

        const prompt = [
          "Сгенерируй стильный образ для этого человека на основе исходного фото.",
          `Мероприятие: ${job.event}.`,
          `Типаж: ${job.archetype?.type || ""}.`,
          `Почему: ${job.archetype?.reason || ""}.`,
          "",
          "Требования:",
          "- Сохрани лицо, внешность и телосложение максимально.",
          "- Измени только одежду/аксессуары под мероприятие.",
          "- Фотореализм, хороший свет, без текста и логотипов.",
        ].join("\n");

        await this.state.storage.put("job", { ...job, status: "saving", updatedAt: Date.now() });

        const edited = await callOpenAIImageEdit(this.env, inputBytes, prompt, size = "1024x1024");
        if (!edited.ok) throw new Error(String(edited.error || "image edit failed"));

        const outUrl = await uploadPngToReg(this.env, { job: job.job, slot: "out_1", pngBytes: edited.pngBytes });

        await this.state.storage.put("job", {
          ...job,
          status: "done",
          images: [outUrl],
          error: "",
          updatedAt: Date.now(),
        });

        return new Response("ok");
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 2000);
        await this.state.storage.put("job", { ...job, status: "error", error: msg, updatedAt: Date.now() });
        return new Response("ok");
      }
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const job = await this.state.storage.get("job");
      if (!job) {
        return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }

      return new Response(
        JSON.stringify({
          ok: true,
          status: job.status,
          error: job.status === "error" ? job.error : null,
          images: job.status === "done" ? job.images : [],
        }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname === "/submit" && request.method === "POST") return await handleSubmit(request, env, origin);
      if (url.pathname === "/outfits/start" && request.method === "POST") return await handleOutfitsStart(request, env, origin);
      if (url.pathname === "/outfits/status" && request.method === "GET") return await handleOutfitsStatus(request, env, origin);

      return json({ ok: false, error: "Not Found" }, 404, origin, env);
    } catch (e) {
      return json({ ok: false, error: "Worker exception", debug: String(e?.message || e) }, 500, origin, env);
    }
  },
};
