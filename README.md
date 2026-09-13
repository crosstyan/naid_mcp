# naid-mcp

## Generation queue

Image generation is serialized through a process-local queue. By default it
accepts eight total running/queued requests and waits a random 750–2500 ms
before each request enters flight. Configure this with `NAID_QUEUE_MAX`,
`NAID_QUEUE_MIN_DELAY_MS`, and `NAID_QUEUE_MAX_DELAY_MS`.

Set `queue_id` on `naid_generate` when another agent may need to inspect or
cancel it. `naid_queue_status` lists the running, delaying, and waiting IDs.
`naid_queue_cancel` can remove waiting/delaying requests individually or in
bulk; it deliberately refuses to cancel a request after its NovelAI HTTP call
has begun, because that request may already spend Anlas.

A standalone, stateless stdio MCP server for NovelAI Diffusion. Its request semantics were adapted from [ComfyUI_NAIDGenerator](https://github.com/bedovyy/ComfyUI_NAIDGenerator), but it does not import, launch, or otherwise depend on ComfyUI.

Tools:

- `naid_generate`: V5 Full (default) or V5 Curated text-to-image, img2img, and multi-character text prompting; saved to `~/Pictures/NovelAI`
- `naid_balance`: sanitized tier, Anlas, V5 usage allowance, and recharge timing
- `naid_convert_prompt`: local ComfyUI-to-NovelAI prompt syntax conversion

Stable Diffusion numerical emphasis is normalized automatically in generation
prompts: `(tag:1.2)` becomes NovelAI V5's `1.2::tag ::`. This applies to the
base prompt, Undesired Content, and positive/negative character prompts. Plain
parentheses are not emphasis-normalized: `(tag)` and `((tag))` remain unchanged.

Resolution presets are `832×1216` / `1216×832` (13:19), `896×1152` / `1152×896` (7:9 / 9:7), `1600×640` / `640×1600` (5:2 / 2:5), and `1024×1024`, plus custom dimensions. Custom width and height must be multiples of 64.

The default generation preset is 14 steps, CFG 5, and Euler Ancestral. With `limit_opus_free=true` (the default), only the named normal-resolution presets are accepted; custom sizes, requests over 28 steps, and img2img are rejected rather than silently changed or allowed to incur Anlas. The server also checks that the V5 Opus usage allowance is available.

The generation tool includes NovelAI's documented V5 Standard/Light quality tags, Heavy/Light/Human Focus/Furry Focus Undesired Content presets, exact numerical emphasis conversion, random or fixed seeds, up to 22 separate character prompts with per-character Undesired Content and free positioning, and explicit multilingual text rendering. Quality tags default to `auto`: Standard tags are appended, but they are dropped whenever text rendering is requested, because those tags contain `no text` and would fight the requested text. Undesired Content defaults to the custom `light` preset (NovelAI V5 Light plus `0::ai-generated::`) with any caller-supplied negative prompt appended; `minimal` adds only `bad quality`.

Paid generation cannot be authorized by a model argument. It is disabled unless the human operator starts the server with `NAID_ALLOW_ANLAS_SPEND=1`; only then may a call use `limit_opus_free=false`. Generated images are returned as local paths rather than image bytes, so an MCP client does not automatically place them in the model's context.

Inpainting, vibe transfer, character-reference controls, and Director Tools are intentionally not exposed because NovelAI V5 does not currently support them.

The server is GPL-3.0-only because its request semantics derive from GPL-licensed NovelAI clients.

## Configuration

Set `NOVEL_AI_API_KEY` in the MCP server environment or in:

```text
~/.config/naid-mcp/.env
```

Optional environment variables:

- `NAID_ENV_FILE`
- `NAID_OUTPUT_DIR`
- `NAID_IMAGE_BASE_URL` (default `https://image.novelai.net`): base URL for `/ai/generate-image` and `/ai/augment-image`
- `NAID_USER_BASE_URL` (default `NAID_IMAGE_BASE_URL`): base URL for `/user/subscription`

Both endpoint variables are read from the process environment first and from
the env file second, so pointing the server at a mirror or a self-hosted
NovelAI-compatible endpoint needs no wrapper script:

Build and test:

```sh
npm install
npm run smoke
```
