import { GenerationQueue, QueueFullError } from "../dist/queue.js";

const queue = new GenerationQueue(8, 0, 0);
let release;
const gate = new Promise((resolve) => { release = resolve; });
const jobs = Array.from({ length: 8 }, (_, index) => queue.enqueue(async () => {
  await gate;
  return index;
}, { id: `job-${index}` }));
const duplicate = queue.enqueue(async () => { throw new Error("duplicate task must not run"); }, { id: "job-0" });
if (queue.size !== 8) throw new Error(`duplicate increased queue size to ${queue.size}`);
let rejected = false;
try {
  await queue.enqueue(async () => 9);
} catch (error) {
  rejected = error instanceof QueueFullError;
}
if (!rejected) throw new Error("ninth queue entry was not rejected");
if (!queue.cancel("job-7")) throw new Error("queued job was not cancellable");
await jobs[7].then(() => { throw new Error("cancelled job resolved"); }, () => undefined);
release();
const results = await Promise.all(jobs.slice(0, 7));
if (results.join(",") !== "0,1,2,3,4,5,6") throw new Error(`queue order changed: ${results}`);
if (await duplicate !== 0) throw new Error("duplicate did not join the original request");
console.log("ok: generation queue capacity, idempotency, order, and cancellation");
