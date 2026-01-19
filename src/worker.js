// FILE: src/worker.js

const BUILD = "worker__2026-01-19__v4";

function corsHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || "https://aistylemate.ru";
  const allowOrigin = origin && origin.startsWith(allow) ? origin : allow;

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

function describeFormValue(v) {
  if (!v) return { kind: "nullish" };
  if (typeof v === "string") return { kind: "string", preview: v.slice(0, 80) };
  return {
    kind: v?.constructor?.name || "object",
    isFileLike: isFileLike(v),
    isFile: typeof File !== "undefined" ? v instanceof File : false,
    name: typeof v?.name === "string" ? v.name : undefined,
    type: typeof v?.type === "string" ? v.type : undefined,
    size: typeof v?.size === "number" ? v.size : undefined,
  };
}

function formDebug(form) {
  const received = {};
  for (const [k, v] of form.entries()) received[k] = describeFormValue(v);
  return {
    receivedKeys: [...new Set([...form.keys()])],
    received,
  };
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
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
        if (c?.type === "output_text" && typeof c.text === "string") {
          aiText += c.text + "\n";
        }
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

function safeId() {
  const arr = crypto.getRandomValues(new Uint8Array(12));
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sniffIsPng(fileLike) {
  try {
    const ab = await fileLike.arrayBuffer();
    const b = new Uint8Array(ab);
    if (b.length < 8) return false;
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
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

  if (!isFileLike(face) || !isFileLike(full)) {
    return json(
      { ok: false, error: "Нужно загрузить 2 фото: face и full", ...formDebug(form) },
      400,
      origin,
      env
    );
  }

  const maxMb = Number(env.MAX_FILE_MB || 4);
  const max = maxMb * 1024 * 1024;
  if (face.size > max || full.size > max) {
    return json({ ok: false, error: `Файл слишком большой (макс ${maxMb}MB)` }, 400, origin, env);
  }

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
    "Верни СТРОГО JSON. Без пояснений, без Markdown, без кодовых блоков.",
    'Формат: {"type":"...","reason":"...","bullets":["...","...","...","..."]}',
  ].join("\n");

  const payload = {
    model: env.DEFAULT_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: faceUrl },
          { type: "input_image", image_url: fullUrl },
        ],
      },
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}

  if (!r.ok) {
    return json({ ok: false, error: "OpenAI error", debug: data || raw }, 502, origin, env);
  }

  const aiText = extractOutputText(data);
  const parsed = tryParseJsonFromText(aiText);
  const result = normalizeArchetype(parsed);

  if (!result) {
    return json(
      { ok: false, error: "AI вернул невалидный JSON", aiTextPreview: (aiText || "").slice(0, 400) },
      502,
      origin,
      env
    );
  }

  return json({ ok: true, result, aiText }, 200, origin, env);
}

async function handleOutfitsStart(request, env, origin) {
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
  try {
    archetype = JSON.parse(archetypeRaw);
  } catch {}
  if (!archetype || typeof archetype !== "object" || !archetype.type || !archetype.reason) {
    return json({ ok: false, error: "Некорректный archetype" }, 400, origin, env);
  }

  if (!isFileLike(full)) {
    return json({ ok: false, error: "Нет файла full", ...formDebug(form) }, 400, origin, env);
  }

  const claimedType = (full.type || "").toLowerCase();
  const looksPng = claimedType === "image/png" || claimedType === "application/octet-stream" || claimedType === "";
  if (!looksPng || !(await sniffIsPng(full))) {
    return json(
      { ok: false, error: "Нужно PNG (квадрат) для генерации", gotType: full.type, ...formDebug(form) },
      400,
      origin,
      env
    );
  }

  if (full.size > 4 * 1024 * 1024) return json({ ok: false, error: "PNG слишком большой (макс 4MB)" }, 400, origin, env);

  const job = safeId();
  const inputKey = `jobs/${job}/input.png`;

  await env.R2_OUTFITS.put(inputKey, await full.arrayBuffer(), { httpMetadata: { contentType: "image/png" } });

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
      inputKey,
      size: env.OUTFIT_SIZE || "512x512",
    }),
  });

  await stub.fetch("https://do.local/run", { method: "POST" });

  return json({ ok: true, job }, 200, origin, env);
}

async function handleOutfitsStatus(request, env, origin) {
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

async function handleOutfitsFile(request, env) {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace("/outfits/file/", ""));
  if (!key) return new Response("Not found", { status: 404 });

  const obj = await env.R2_OUTFITS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      if (url.pathname === "/submit" && request.method === "POST") {
        return await handleSubmit(request, env, origin);
      }

      if (url.pathname === "/outfits/start" && request.method === "POST") {
        return await handleOutfitsStart(request, env, origin);
      }
      if (url.pathname === "/outfits/status" && request.method === "GET") {
        return await handleOutfitsStatus(request, env, origin);
      }
      if (url.pathname.startsWith("/outfits/file/") && request.method === "GET") {
        return await handleOutfitsFile(request, env);
      }

      return json({ ok: false, error: "Not Found" }, 404, origin, env);
    } catch (e) {
      return json({ ok: false, error: "Worker exception", debug: String(e?.message || e) }, 500, origin, env);
    }
  },
};

