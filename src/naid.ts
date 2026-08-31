import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { generationQueue, type QueueMetadata } from "./queue.js";

const DEFAULT_IMAGE_BASE_URL = "https://image.novelai.net";
const DEFAULT_USER_BASE_URL = DEFAULT_IMAGE_BASE_URL;
const DEFAULT_ENV_FILE = join(homedir(), ".config/naid-mcp/.env");
const DEFAULT_OUTPUT_DIR = join(homedir(), "Pictures/NovelAI");

export const models = [
  "nai-diffusion-5-curated",
  "nai-diffusion-5-full",
] as const;
export const samplers = ["k_euler", "k_euler_ancestral", "k_dpmpp_2s_ancestral", "k_dpmpp_2m_sde", "k_dpmpp_2m", "k_dpmpp_sde", "ddim"] as const;
export const directorActions = ["bg-removal", "lineart", "sketch", "colorize", "emotion", "declutter"] as const;

export type GenerateInput = {
  positive: string;
  negative: string;
  model: typeof models[number];
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: typeof samplers[number];
  seed: number;
  cfgRescale: number;
  qualityPreset: "auto" | "standard" | "light" | "none";
  undesiredContentPreset: "minimal" | "heavy" | "light" | "human_focus" | "furry_focus" | "none";
  renderText?: string;
  textLanguage: "auto" | "english" | "japanese" | "chinese";
  transparentBackground: boolean;
  limitOpusFree: boolean;
  timeoutMs: number;
  sourcePath?: string;
  img2imgStrength: number;
  img2imgNoise: number;
  characters: Array<{ positive: string; negative: string; x?: number; y?: number; useOrder: boolean }>;
};

export type GenerationResult = {
  outputPath: string;
  model?: string;
  action: string;
  width: number;
  height: number;
  seed?: number;
  anlasBefore?: number;
  anlasAfter?: number;
  anlasCost?: number;
  allowanceBefore?: number;
  allowanceAfter?: number;
  queue?: QueueMetadata;
};

export type SubscriptionStatus = {
  tier: number;
  tierName: "Paper" | "Tablet" | "Scroll" | "Opus" | "Unknown";
  active: boolean;
  anlas: number;
  usage?: {
    percent: number;
    isNegative: boolean;
    timeUntilNextPercent: number;
    nextPercentAt: string;
    percentPerDay: number;
  };
};

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

export async function getAccessToken(): Promise<string> {
  if (process.env.NOVEL_AI_API_KEY) return process.env.NOVEL_AI_API_KEY;
  if (process.env.NAI_ACCESS_TOKEN) return process.env.NAI_ACCESS_TOKEN;
  const envFile = process.env.NAID_ENV_FILE ?? DEFAULT_ENV_FILE;
  try {
    const values = parseEnv(await readFile(envFile, "utf8"));
    if (values.NOVEL_AI_API_KEY) return values.NOVEL_AI_API_KEY;
    if (values.NAI_ACCESS_TOKEN) return values.NAI_ACCESS_TOKEN;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  throw new Error(`NOVEL_AI_API_KEY is not configured. Export it to the MCP environment or set it in ${envFile}`);
}

async function naiFetch(url: string, token: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastError: unknown;
  const maxAttempts = (init.method ?? "GET").toUpperCase() === "GET" ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "user-agent": "naid-mcp/0.1", accept: "application/zip, application/json", ...init.headers, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 1000);
      const error = new Error(`NovelAI API ${response.status}: ${body}`);
      if (response.status < 500 || attempt === maxAttempts - 1) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = error instanceof Error ? error.message.match(/^NovelAI API (\d+):/)?.[1] : undefined;
      if ((status && Number(status) < 500) || attempt === maxAttempts - 1) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getSubscription(timeoutMs = 30_000): Promise<SubscriptionStatus> {
  const token = await getAccessToken();
  const base = process.env.NAID_USER_BASE_URL ?? DEFAULT_USER_BASE_URL;
  const response = await naiFetch(`${base}/user/subscription`, token, { method: "GET" }, timeoutMs);
  const data = await response.json() as {
    tier?: number;
    active?: boolean;
    trainingStepsLeft?: number | { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number };
    usage?: { percent?: number; isNegative?: boolean; timeUntilNextPercent?: number };
    subscription?: {
      tier?: number; active?: boolean;
      trainingStepsLeft?: number | { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number };
      usage?: { percent?: number; isNegative?: boolean; timeUntilNextPercent?: number };
    };
  };
  const subscription = data.subscription ?? data;
  const steps = subscription.trainingStepsLeft;
  const anlas = typeof steps === "number" ? steps : steps && typeof steps === "object"
    ? (steps.fixedTrainingStepsLeft ?? 0) + (steps.purchasedTrainingSteps ?? 0) : 0;
  const tier = subscription.tier ?? 0;
  const tierNames = ["Paper", "Tablet", "Scroll", "Opus"] as const;
  const rawUsage = subscription.usage;
  const seconds = rawUsage?.timeUntilNextPercent;
  return {
    tier,
    tierName: tierNames[tier] ?? "Unknown",
    active: subscription.active === true,
    anlas,
    usage: rawUsage && typeof rawUsage.percent === "number" ? {
      percent: rawUsage.percent,
      isNegative: rawUsage.isNegative === true,
      timeUntilNextPercent: typeof seconds === "number" ? seconds : 0,
      nextPercentAt: new Date(Date.now() + (typeof seconds === "number" ? seconds * 1000 : 0)).toISOString(),
      percentPerDay: typeof seconds === "number" && seconds > 0 ? Math.round(864000 / seconds) / 10 : 0,
    } : undefined,
  };
}

export async function getAnlas(timeoutMs = 30_000): Promise<number> {
  return (await getSubscription(timeoutMs)).anlas;
}

function resolution(width: number, height: number, limitOpusFree: boolean): [number, number] {
  if (width % 64 !== 0 || height % 64 !== 0) throw new Error("NovelAI width and height must both be multiples of 64");
  if (limitOpusFree && width * height > 1024 * 1024) {
    throw new Error("This resolution exceeds the Opus Anlas-free 1024×1024 total-pixel limit; set limit_opus_free=false to allow it");
  }
  return [width, height];
}

function extractFirstImage(zipBytes: Uint8Array): Uint8Array {
  const files = unzipSync(zipBytes);
  const entry = Object.entries(files).find(([name]) => /\.(png|jpe?g|webp)$/i.test(name)) ?? Object.entries(files)[0];
  if (!entry) throw new Error("NovelAI returned an empty ZIP archive");
  return entry[1];
}

async function saveImage(bytes: Uint8Array, prefix: string): Promise<string> {
  const outputDir = resolve(process.env.NAID_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `${prefix}_${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}.png`);
  await writeFile(path, bytes);
  return path;
}

async function balanceOrUndefined(): Promise<number | undefined> {
  try { return await getAnlas(); } catch { return undefined; }
}

async function resizedImageBase64(path: string, width: number, height: number): Promise<string> {
  return (await sharp(await readFile(resolve(path))).rotate().resize(width, height, { fit: "fill" }).png().toBuffer()).toString("base64");
}

const qualitySuffixes = {
  standard: "very aesthetic, masterpiece, no text",
  light: "very aesthetic, amazing quality, no text",
} as const;

const undesiredContentPresets = {
  minimal: "bad quality",
  heavy: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
  // NovelAI V5 Light UC plus the user's local default exclusion.
  light: "lowres, lipstick, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::",
  furry_focus: "{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, upscale, {sequence}, {{grandfathered content}}, blurred foreground, chromatic aberration, sketch, everyone, [sketch background], simple, [flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic",
  human_focus: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, @_@, mismatched pupils, glowing eyes, bad anatomy",
} as const;

function joinPromptParts(...parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(", ");
}

function detectedTextLanguage(text: string): "english" | "japanese" | "chinese" {
  if (/[\u3040-\u30ff]/u.test(text)) return "japanese";
  if (/[\u3400-\u9fff]/u.test(text)) return "chinese";
  return "english";
}

function v5Prompt(input: GenerateInput): string {
  const prompt = promptToNai(input.positive.replaceAll("\\", ""), "numeric");
  const hasManualTextBlock = /(^|\n)\s*Text:/i.test(prompt);
  const quality = input.qualityPreset === "auto" ? (input.renderText || hasManualTextBlock ? "none" : "standard") : input.qualityPreset;
  let result = prompt;
  if (input.transparentBackground) result = joinPromptParts(result, "transparent background");
  if (input.renderText) {
    const language = input.textLanguage === "auto" ? detectedTextLanguage(input.renderText) : input.textLanguage;
    result = joinPromptParts(result, "text", `${language} text`);
  }
  if (quality !== "none") result = joinPromptParts(result, qualitySuffixes[quality]);
  if (input.renderText) result += `\nText: ${input.renderText}`;
  return result;
}

function v5UndesiredContent(input: GenerateInput): string {
  const custom = promptToNai(input.negative.replaceAll("\\", ""), "numeric");
  const preset = input.undesiredContentPreset === "none" ? undefined : undesiredContentPresets[input.undesiredContentPreset];
  return joinPromptParts(preset, custom);
}

function validateRenderText(input: GenerateInput): void {
  if (!input.renderText) return;
  const limit = input.model === "nai-diffusion-5-full" ? 750 : 374;
  if (input.renderText.length > limit) throw new Error(`${input.model} supports at most ${limit} text-rendering characters, including whitespace`);
}

export async function generateImage(input: GenerateInput): Promise<GenerationResult> {
  const token = await getAccessToken();
  const [width, height] = resolution(input.width, input.height, input.limitOpusFree);
  if (input.limitOpusFree && input.steps > 28) throw new Error("Opus Anlas-free generation is limited to 28 steps; set limit_opus_free=false to allow more");
  if (input.limitOpusFree && input.sourcePath) throw new Error("Img2img uses a base image and does not qualify for Opus Anlas-free generation; set limit_opus_free=false to allow it");
  const beforeStatus = await getSubscription();
  if (input.limitOpusFree) {
    if (!beforeStatus.active || beforeStatus.tier < 3) throw new Error("Anlas-free generation requires an active Opus subscription");
    if (beforeStatus.usage && (beforeStatus.usage.isNegative || beforeStatus.usage.percent <= 0)) {
      throw new Error("The V5 Opus usage allowance is empty; refusing generation because it would spend Anlas. Set limit_opus_free=false to allow it");
    }
  }
  const steps = input.steps;
  const sampler = input.sampler === "ddim" ? "k_euler_ancestral" : input.sampler;
  validateRenderText(input);
  const positive = v5Prompt(input);
  const negative = v5UndesiredContent(input);
  const seed = input.seed === -1 ? randomInt(0, 2 ** 32) : input.seed;
  const charCaptions = input.characters.map((character) => ({
    char_caption: promptToNai(character.positive.replaceAll("\\", ""), "numeric"),
    centers: [{ x: Number((character.x ?? 0.5).toFixed(3)), y: Number((character.y ?? 0.5).toFixed(3)) }],
  }));
  const negativeCharCaptions = input.characters.map((character) => ({
    char_caption: promptToNai(character.negative.replaceAll("\\", ""), "numeric"),
    centers: [{ x: Number((character.x ?? 0.5).toFixed(3)), y: Number((character.y ?? 0.5).toFixed(3)) }],
  }));
  const useCoords = input.characters.some((character) => character.x !== undefined || character.y !== undefined);
  const useOrder = input.characters.some((character) => character.useOrder);
  const params: Record<string, unknown> = {
    params_version: 4, width, height, scale: input.cfg, sampler, steps,
    seed, n_samples: 1, noise_schedule: "karras",
    ucPresetId: input.undesiredContentPreset, qualityPresetId: input.qualityPreset,
    autoSmea: false, dynamic_thresholding: false, controlnet_strength: 1,
    legacy: false, add_original_image: true, cfg_rescale: input.cfgRescale,
    legacy_v3_extend: false, use_coords: useCoords, legacy_uc: false,
    normalize_reference_strength_multiple: true,
    prompt: positive, negative_prompt: negative, image_format: "png",
    ...(charCaptions.length ? { characterPrompts: charCaptions.map((caption) => ({ prompt: caption.char_caption, center: caption.centers[0] })) } : {}),
    v4_prompt: { use_coords: useCoords, use_order: useOrder, caption: { base_caption: positive, char_captions: charCaptions } },
    v4_negative_prompt: { use_coords: useCoords, use_order: useOrder, legacy_uc: false,
      caption: { base_caption: negative, char_captions: negativeCharCaptions } },
  };
  let action = "generate";
  let model: string = input.model;
  if (input.sourcePath) {
    params.image = await resizedImageBase64(input.sourcePath, width, height);
    action = "img2img";
    params.strength = input.img2imgStrength;
    params.noise = input.img2imgNoise;
    params.extra_noise_seed = seed;
    params.add_original_image = true;
  }
  if (sampler === "k_euler_ancestral") {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  if (input.transparentBackground) {
    params.straight_alpha = true;
    params.tag_hint_transparent_background = true;
  }
  const before = beforeStatus.anlas;
  const base = process.env.NAID_IMAGE_BASE_URL ?? DEFAULT_IMAGE_BASE_URL;
  const response = await naiFetch(`${base}/ai/generate-image`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: positive, model, action, parameters: params, use_new_shared_trial: true }),
  }, input.timeoutMs);
  const outputPath = await saveImage(extractFirstImage(new Uint8Array(await response.arrayBuffer())), "NAI_mcp");
  const afterStatus = await getSubscription().catch(() => undefined);
  const after = afterStatus?.anlas;
  return { outputPath, model, action, width, height, seed,
    anlasBefore: before, anlasAfter: after, anlasCost: after !== undefined ? before - after : undefined,
    allowanceBefore: beforeStatus.usage?.percent, allowanceAfter: afterStatus?.usage?.percent };
}

export function queueGenerateImage(input: GenerateInput, options: { id?: string; signal?: AbortSignal } = {}): Promise<GenerationResult> {
  return generationQueue.enqueue(async (queue) => ({ ...(await generateImage(input)), queue }), options);
}

export function generationQueueStatus() { return generationQueue.snapshot(); }
export function cancelQueuedGeneration(id: string) { return generationQueue.cancel(id); }
export function cancelAllQueuedGenerations() { return generationQueue.cancelQueued(); }

export async function directorImage(args: {
  action: typeof directorActions[number]; sourcePath: string; prompt?: string; mood?: string;
  strength?: number; limitOpusFree: boolean; timeoutMs: number;
}): Promise<GenerationResult> {
  const token = await getAccessToken();
  const sourcePath = resolve(args.sourcePath);
  const source = sharp(await readFile(sourcePath)).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Could not determine dimensions of ${basename(sourcePath)}`);
  const [width, height] = resolution(metadata.width, metadata.height, args.limitOpusFree);
  const image = await source.resize(width, height, { fit: "fill" }).png().toBuffer();
  const options: Record<string, unknown> = {};
  if (args.action === "colorize") { options.defry = args.strength ?? 0; options.prompt = args.prompt ?? ""; }
  if (args.action === "emotion") { options.defry = args.strength ?? 0; options.prompt = `${args.mood ?? "neutral"};;${args.prompt ?? ""}`; }
  const before = await balanceOrUndefined();
  const base = process.env.NAID_IMAGE_BASE_URL ?? DEFAULT_IMAGE_BASE_URL;
  const response = await naiFetch(`${base}/ai/augment-image`, token, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ req_type: args.action, width, height, image: image.toString("base64"), ...options }),
  }, args.timeoutMs);
  const outputPath = await saveImage(extractFirstImage(new Uint8Array(await response.arrayBuffer())), `NAI_${args.action}`);
  const after = await balanceOrUndefined();
  return { outputPath, action: args.action, width, height, anlasBefore: before, anlasAfter: after,
    anlasCost: before !== undefined && after !== undefined ? before - after : undefined };
}

export function promptToNai(text: string, syntax: "numeric" | "brace"): string {
  const numericSuffix = /^([\s\S]+):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/;

  const convert = (segment: string): string => {
    let result = "";
    for (let i = 0; i < segment.length;) {
      if (segment[i] !== "(") {
        result += segment[i++];
        continue;
      }

      let depth = 1;
      let end = i + 1;
      for (; end < segment.length && depth > 0; end++) {
        if (segment[end] === "(") depth++;
        else if (segment[end] === ")") depth--;
      }
      if (depth !== 0) {
        result += segment.slice(i);
        break;
      }

      const inner = segment.slice(i + 1, end - 1);
      const weighted = inner.match(numericSuffix);
      if (!weighted) {
        // Parentheses without an explicit :number are grouping or part of a
        // Danbooru tag. Preserve them exactly, including nested parentheses.
        result += `(${convert(inner)})`;
      } else {
        const body = convert(weighted[1]);
        const weight = Number(weighted[2]);
        if (syntax === "numeric" || weight <= 0) {
          result += `${weight}::${body} ::`;
        } else {
          const count = Math.round(Math.log(weight) / Math.log(1.05));
          result += count >= 0
            ? `${"{".repeat(count)}${body}${"}".repeat(count)}`
            : `${"[".repeat(-count)}${body}${"]".repeat(-count)}`;
        }
      }
      i = end;
    }
    return result;
  };

  return convert(text);
}
