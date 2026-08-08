import { stat } from "node:fs/promises";

const maxBytes = 32_000;
const file = new URL("../AGENTS.md", import.meta.url);
const { size } = await stat(file);

if (size > maxBytes) {
  console.error(`AGENTS.md is ${size} bytes; keep it at or below ${maxBytes}.`);
  process.exit(1);
}

console.log(`AGENTS.md is ${size} bytes; limit is ${maxBytes}.`);
