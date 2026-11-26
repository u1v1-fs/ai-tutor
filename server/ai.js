// One chat API, many providers. All popular ones speak the OpenAI format,
// so switching provider = editing .env, not code.

import "dotenv/config";
import { load, save } from "./store.js";

const PRESETS = {
  gemini: {
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    // 3.8-flash "thinks" for 60s+ and stalls behind some routers; 3.5-flash is fast.
    model: "gemini-3.5-flash",
  },
  groq: {
    base: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  },
  openrouter: {
    base: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-3.3-70b-instruct",
  },
  openai: {
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  github: {
    base: "https://models.inference.ai.azure.com",
    model: "gpt-4o-mini",
  },
  ollama: {
    base: "http://localhost:11434/v1",
    model: "llama3.1",
  },
};

const name = String(process.env.AI_PROVIDER || "gemini").toLowerCase();
const preset = PRESETS[name] || PRESETS.gemini;

export const provider = {
  name: PRESETS[name] ? name : `custom(${name})`,
  base: (process.env.AI_BASE_URL || preset.base).replace(/\/+$/, ""),
  apiKey: process.env.AI_API_KEY || "",
  model: process.env.AI_MODEL || preset.model,
};

// Ollama runs without a key; everything else needs one.
export const configured =
  provider.name === "ollama" ? true : Boolean(provider.apiKey);

// The model can be switched at runtime (data/settings.json) without a restart.
export function currentModel() {
  const settings = load("settings", {});
  return settings.model || provider.model;
}

export function setModel(model) {
  const settings = load("settings", {});
  settings.model = String(model || "").trim() || null;
  save("settings", settings);
  return currentModel();
}

export function describe() {
  return {
    provider: provider.name,
    model: currentModel(),
    configured,
  };
}

/** Send a chat completion. Returns the assistant message text. */
export async function chat(messages, { temperature = 0.4, json = false, model } = {}) {
  const useModel = model || currentModel();
  if (!configured) {
    const err = new Error(
      "No AI key set. Add AI_API_KEY to .env (or set AI_PROVIDER=ollama), then restart."
    );
    err.status = 409;
    throw err;
  }

  const res = await fetch(`${provider.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    // Never let a slow/hung model wedge the request forever.
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: useModel,
      temperature,
      messages,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let hint = "";
    if (res.status === 401 || res.status === 403) hint = " — check AI_API_KEY";
    else if (res.status === 404) hint = " — check AI_MODEL exists for this provider";
    else if (res.status === 429) hint = " — rate limited, wait a moment";
    throw new Error(`AI request failed (${res.status}${hint}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("AI returned an empty response.");
  return text;
}
