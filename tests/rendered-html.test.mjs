import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the signed-out AittaDB pre-registration landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>AittaDB investment pre-registration<\/title>/i);
  assert.match(html, /Pre-registration open/);
  assert.match(html, /Register your interest/);
  assert.match(html, /Investor interest/);
  assert.match(html, /Founder interest/);
  assert.match(html, /Interest now\. Decisions later\./);
  assert.doesNotMatch(
    html,
    /Initial implementation scaffold|Product areas to build next|Repository contract|ChatGPT Sites application|features to build/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
