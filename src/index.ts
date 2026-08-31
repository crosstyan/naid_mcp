#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { cancelAllQueuedGenerations, cancelQueuedGeneration, generationQueueStatus, getSubscription, models, promptToNai, queueGenerateImage, samplers } from "./naid.js";

const resolutionPresets = {
  portrait_13_19: [832, 1216],
  landscape_19_13: [1216, 832],
  portrait_approx_3_4: [896, 1152],
  landscape_approx_4_3: [1152, 896],
  ultrawide: [1600, 640],
  tall: [640, 1600],
  square: [1024, 1024],
  custom: [832, 1216],
} as const;

const spend = z.literal(true).describe("Must be true: this operation may spend NovelAI Anlas.");

function createServer(): McpServer {
  const server = new McpServer(
    { name: "naid-mcp", version: "0.1.0" },
    {
      instructions: "NovelAI image tools may spend Anlas. Generated images are saved to disk and are not injected into model context. Use TIPO first when prompt expansion is useful.",
      // The tool surface is static for a given build. MCP 2026 defaults list
      // responses to ttlMs=0, which forces clients such as pi-mcp-adapter to
      // reconnect during every startup before they can restore direct tools.
      cacheHints: {
        "tools/list": { ttlMs: 86_400_000, cacheScope: "private" },
      },
    },
  );

  server.registerTool("naid_balance", {
    title: "Get NovelAI Anlas balance",
    description: "Read the current NovelAI Anlas balance without generating an image.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const status = await getSubscription();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }], structuredContent: status };
    } catch (error) { return failure(error); }
  });

  server.registerTool("naid_generate", {
    title: "Generate an image with NovelAI Diffusion",
    description: "Generate one V5 image and save it under ~/Pictures/NovelAI. Returns only its path and generation metadata; it does not place image pixels in model context.",
    inputSchema: z.object({
      positive: z.string().min(1).describe("Base scene/style prompt. Put subject-count tags such as 2girls here, not in individual character prompts."),
      negative: z.string().default("").describe("Custom Undesired Content appended to the selected V5 preset."),
      model: z.enum(models).default("nai-diffusion-5-full"),
      resolution: z.enum(Object.keys(resolutionPresets) as [keyof typeof resolutionPresets, ...(keyof typeof resolutionPresets)[]]).default("portrait_13_19")
        .describe("Named output size. The approximate 4:3 preset is exactly 9:7; ultrawide is exactly 5:2."),
      custom_width: z.number().int().min(64).max(1600).multipleOf(64).default(832).describe("Used only when resolution=custom; must be a multiple of 64."),
      custom_height: z.number().int().min(64).max(1600).multipleOf(64).default(1216).describe("Used only when resolution=custom; must be a multiple of 64."),
      steps: z.number().int().min(1).max(50).default(14),
      cfg: z.number().min(0).max(10).default(5),
      sampler: z.enum(samplers).default("k_euler_ancestral"),
      seed: z.number().int().min(-1).max(9_999_999_999).default(-1).describe("-1 chooses a fresh random seed; provide a number for reproducibility."),
      cfg_rescale: z.number().min(0).max(1).default(0),
      quality_preset: z.enum(["auto", "standard", "light", "none"]).default("light")
        .describe("auto uses Standard V5 quality tags, but disables them for text rendering because they contain 'no text'."),
      undesired_content_preset: z.enum(["minimal", "heavy", "light", "human_focus", "furry_focus", "none"]).default("light")
        .describe("minimal adds only 'bad quality'; custom negative content is appended after the preset."),
      render_text: z.string().optional().describe("Optional literal text to render. The server adds language tags and places Text: at the end as NovelAI requires."),
      text_language: z.enum(["auto", "english", "japanese", "chinese"]).default("auto"),
      transparent_background: z.boolean().default(false).describe("Request V5 native straight-alpha PNG output."),
      limit_opus_free: z.boolean().default(true).describe("Reject requests that cannot qualify for Opus Anlas-free generation: over 1024×1024 total pixels, over 28 steps, or img2img. V5 usage allowance still applies."),
      timeout_seconds: z.number().int().min(30).max(3000).default(180),
      source_path: z.string().min(1).optional().describe("Optional local image for V5 img2img."),
      img2img_strength: z.number().min(0.01).max(0.99).default(0.7),
      img2img_noise: z.number().min(0).max(0.99).default(0),
      characters: z.array(z.object({
        positive: z.string().describe("Describe one character as girl, boy, or other without a numeric subject count."),
        negative: z.string().default("").describe("Per-character Undesired Content to reduce attribute leakage."),
        x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(),
        use_order: z.boolean().default(false),
      })).max(22).default([]),
      queue_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional()
        .describe("Optional idempotency key for inspection/cancellation. Concurrent calls with the same ID join the first request and return its result without generating twice."),
      confirm_spend_anlas: spend,
    }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, context) => {
    try {
      const preset = resolutionPresets[args.resolution];
      const width = args.resolution === "custom" ? args.custom_width : preset[0];
      const height = args.resolution === "custom" ? args.custom_height : preset[1];
      if (args.limit_opus_free && args.resolution === "custom") {
        throw new Error("Opus free-only mode requires one of the named normal-resolution presets; set limit_opus_free=false for custom dimensions");
      }
      const result = await queueGenerateImage({ positive: args.positive, negative: args.negative, model: args.model,
        width, height, steps: args.steps, cfg: args.cfg, sampler: args.sampler,
        seed: args.seed, cfgRescale: args.cfg_rescale, qualityPreset: args.quality_preset,
        undesiredContentPreset: args.undesired_content_preset, renderText: args.render_text,
        textLanguage: args.text_language, transparentBackground: args.transparent_background,
        limitOpusFree: args.limit_opus_free, timeoutMs: args.timeout_seconds * 1000,
        sourcePath: args.source_path, img2imgStrength: args.img2img_strength, img2imgNoise: args.img2img_noise,
        characters: args.characters.map((character) => ({ positive: character.positive, negative: character.negative,
          x: character.x, y: character.y, useOrder: character.use_order })),
      }, { id: args.queue_id, signal: context.mcpReq.signal });
      return success(result);
    } catch (error) { return failure(error); }
  });

  server.registerTool("naid_queue_status", {
    title: "Inspect the NovelAI generation queue",
    description: "Show running, random-delay, and waiting generation IDs without reading image content.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => success(generationQueueStatus()));

  server.registerTool("naid_queue_cancel", {
    title: "Discard queued NovelAI generations",
    description: "Cancel one named request or all requests that have not entered the NovelAI HTTP generation call. Running requests are never cancelled.",
    inputSchema: z.object({
      queue_id: z.string().min(1).max(128).optional(),
      all_queued: z.boolean().default(false),
    }).refine((args) => args.all_queued || Boolean(args.queue_id), "Provide queue_id or set all_queued=true"),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ queue_id, all_queued }) => {
    if (all_queued) return success({ cancelled: cancelAllQueuedGenerations(), queue: generationQueueStatus() });
    const cancelled = cancelQueuedGeneration(queue_id!);
    return success({ queueId: queue_id, cancelled, reason: cancelled ? "removed before flight" : "not queued or already running", queue: generationQueueStatus() });
  });

  server.registerTool("naid_convert_prompt", {
    title: "Convert ComfyUI prompt emphasis to NovelAI syntax",
    description: "Convert only explicit Stable Diffusion (text:weight) emphasis into NovelAI syntax. Plain parentheses such as (text) and ((text)) remain unchanged. This is local and spends no Anlas.",
    inputSchema: z.object({
      text: z.string(),
      syntax: z.enum(["numeric", "brace"]).default("numeric")
        .describe("numeric preserves exact (text:weight) values as weight::text ::; brace approximates explicit weights using NovelAI's ×/÷1.05 nesting. Unweighted parentheses are preserved."),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => ({ content: [{ type: "text", text: promptToNai(args.text, args.syntax) }] }));

  return server;
}

function success(result: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }], structuredContent: result as Record<string, unknown> }; }
function failure(error: unknown) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }

void serveStdio(createServer);
console.error("naid-mcp ready (generated images are returned by path only)");
