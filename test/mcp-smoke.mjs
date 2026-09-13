import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import sharp from "sharp";

const temporary = await mkdtemp(join(tmpdir(), "naid-mcp-smoke-"));
let balance = 100;
let generatedModel;
let generatedBody;
const mock = createServer(async (request, response) => {
  if (request.url === "/user/subscription") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ tier: 3, active: true,
      trainingStepsLeft: { fixedTrainingStepsLeft: balance, purchasedTrainingSteps: 0 },
      usage: { percent: 100, isNegative: false, timeUntilNextPercent: 8640 } }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (request.url === "/ai/generate-image") { generatedModel = body.model; generatedBody = body; }
  balance -= 1;
  const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } }).png().toBuffer();
  response.setHeader("content-type", "application/zip");
  response.end(Buffer.from(zipSync({ "image.png": png })));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const address = mock.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const envFile = join(temporary, "naid.env");
await writeFile(envFile, [
  "NOVEL_AI_API_KEY=test-token",
  `NAID_IMAGE_BASE_URL=${baseUrl}/`,
  `NAID_USER_BASE_URL=${baseUrl}/`,
  "",
].join("\n"));
delete process.env.NOVEL_AI_API_KEY;
delete process.env.NAI_ACCESS_TOKEN;
process.env.NAID_ENV_FILE = envFile;
process.env.NAID_OUTPUT_DIR = temporary;
process.env.NAID_QUEUE_MIN_DELAY_MS = "0";
process.env.NAID_QUEUE_MAX_DELAY_MS = "0";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
});
const client = new Client({ name: "naid-mcp-smoke", version: "0.1.0" });
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((tool) => tool.name).sort();
for (const expected of ["naid_balance", "naid_convert_prompt", "naid_generate"]) {
  if (!names.includes(expected)) throw new Error(`missing tool: ${expected}`);
}
const generateSchema = tools.tools.find((tool) => tool.name === "naid_generate")?.inputSchema;
if (generateSchema?.properties?.confirm_spend_anlas) throw new Error("model-controlled spending confirmation leaked into tool schema");
const paidWithoutOperatorApproval = await client.callTool({ name: "naid_generate", arguments: {
  positive: "must not generate", limit_opus_free: false,
} });
if (!paidWithoutOperatorApproval.isError || !paidWithoutOperatorApproval.content?.some((part) => part.type === "text" && part.text.includes("disabled by the server operator"))) {
  throw new Error("paid generation was not blocked by the operator gate");
}
const converted = await client.callTool({ name: "naid_convert_prompt", arguments: { text: "(cat), ((dog)), (blue eyes:1.1), (artist_(circle):0.8)" } });
const text = converted.content?.find((part) => part.type === "text")?.text;
if (text !== "(cat), ((dog)), 1.1::blue eyes ::, 0.8::artist_(circle) ::") throw new Error(`unexpected conversion: ${text}`);
const generated = await client.callTool({ name: "naid_generate", arguments: {
  positive: "test, (composition), (blue eyes:1.1)",
  negative: "(bad hands:0.7)",
  characters: [{ positive: "girl, (red hair:1.2)", negative: "(hat:0.5)" }],
} });
if (generated.isError) throw new Error(`generation failed: ${JSON.stringify(generated.content)}`);
if (generatedModel !== "nai-diffusion-5-full") throw new Error(`unexpected default model: ${generatedModel}`);
if (generatedBody?.parameters?.params_version !== 4) throw new Error("generation did not use V5 params_version 4");
if (generatedBody?.parameters?.noise_schedule !== "karras") throw new Error("generation did not force V5 Karras schedule");
if (generatedBody?.parameters?.steps !== 14 || generatedBody?.parameters?.scale !== 5 || generatedBody?.parameters?.sampler !== "k_euler_ancestral") {
  throw new Error("unexpected default generation preset");
}
if (generatedBody?.input !== "test, (composition), 1.1::blue eyes ::, very aesthetic, amazing quality, no text") throw new Error(`unexpected normalized prompt: ${generatedBody?.input}`);
if (generatedBody?.parameters?.negative_prompt !== "lowres, lipstick, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::, 0.7::bad hands ::") throw new Error(`unexpected normalized UC: ${generatedBody?.parameters?.negative_prompt}`);
if ("uc" in generatedBody.parameters) throw new Error("generation used obsolete uc field instead of negative_prompt");
if (generatedBody?.parameters?.qualityPresetId !== "light" || generatedBody?.parameters?.ucPresetId !== "light") throw new Error("unexpected V5 preset IDs");
if (generatedBody?.parameters?.v4_negative_prompt?.caption?.base_caption !== generatedBody?.parameters?.negative_prompt) throw new Error("V5 negative captions disagree");
if (generatedBody?.parameters?.v4_prompt?.use_order !== false || generatedBody?.parameters?.v4_negative_prompt?.use_order !== false) throw new Error("character ordering was enabled without a request");
if (generatedBody?.parameters?.v4_prompt?.caption?.char_captions?.[0]?.char_caption !== "girl, 1.2::red hair ::") throw new Error("character prompt weight was not normalized");
if (generatedBody?.parameters?.v4_negative_prompt?.caption?.char_captions?.[0]?.char_caption !== "0.5::hat ::") throw new Error("negative character prompt weight was not normalized");
if ("sm" in generatedBody.parameters || "sm_dyn" in generatedBody.parameters || "reference_image_multiple" in generatedBody.parameters) {
  throw new Error("generation leaked unsupported V4 parameters into V5 body");
}
if (generated.content?.some((part) => part.type === "image")) throw new Error("generation unexpectedly returned image content");
const outputPath = generated.structuredContent?.outputPath;
if (!outputPath || !(await readFile(outputPath)).length) throw new Error("generation output was not saved");

await client.close();
await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
await rm(temporary, { recursive: true, force: true });
console.log(`ok: ${names.join(", ")}`);
