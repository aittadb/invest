import assert from "node:assert/strict";
import test from "node:test";

let workerPromise;

async function loadWorker() {
  if (!workerPromise) {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
    workerPromise = import(workerUrl.href).then(({ default: worker }) => worker);
  }
  return workerPromise;
}

async function render(
  headers = { accept: "text/html" },
  url = "http://localhost/",
  appBaseUrl,
) {
  const worker = await loadWorker();

  return worker.fetch(
    new Request(url, {
      headers,
    }),
    {
      APP_BASE_URL: appBaseUrl,
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
  assert.match(response.headers.get("vary") ?? "", /\bAccept\b/i);

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

test("HTML metadata uses the configured runtime origin", async () => {
  const runtimeOrigin = "https://invest.example.com";
  const response = await render(
    { accept: "text/html" },
    "https://sites-host.example/",
    runtimeOrigin,
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/invest\.example\.com\/?"\s*\/?>/i,
  );
  assert.match(
    html,
    /<meta property="og:url" content="https:\/\/invest\.example\.com\/?"\s*\/?>/i,
  );
  assert.match(html, /https:\/\/invest\.example\.com\/og\.png/i);
});

test("HTML metadata falls back to each deployment request origin", async () => {
  const firstHtml = await (
    await render({ accept: "text/html" }, "https://first.example/")
  ).text();
  const secondHtml = await (
    await render({ accept: "text/html" }, "https://second.example/")
  ).text();

  assert.match(firstHtml, /<link rel="canonical" href="https:\/\/first\.example\/?"/i);
  assert.match(secondHtml, /<link rel="canonical" href="https:\/\/second\.example\/?"/i);
});

test("the root resource negotiates equivalent public hypermedia JSON", async () => {
  const response = await render({
    accept: "application/vnd.aittadb-invest+json; version=0.1",
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/vnd\.aittadb-invest\+json;\s*version=0\.1/i,
  );
  assert.equal(response.headers.get("investor-app-api-version"), "0.1");
  assert.match(response.headers.get("vary") ?? "", /\bAccept\b/i);

  const document = await response.json();
  assert.equal(document.api_version, "0.1");
  assert.equal(document.type, "investment-pre-registration");
  assert.equal(document.data.name, "AittaDB");
  assert.equal(document.data.status, "open");
  assert.equal(document.data.interest_is_binding, false);
  assert.deepEqual(
    document.actions.map((action) => action.name),
    ["sign-in", "pre-register-investor", "pre-register-founder"],
  );
  assert.ok(document.links.some((link) => link.rel.includes("self")));
  assert.doesNotMatch(JSON.stringify(document), /email|credential|private package content/i);

  const html = await (await render()).text();
  assert.match(html, new RegExp(document.data.product_summary));
  for (const action of document.actions) {
    assert.match(html, new RegExp(new URL(action.href).pathname));
  }
});

test("JSON selection depends on Accept and rejects unsupported versions", async () => {
  const compatibilityResponse = await render({
    accept: "application/json",
    "user-agent": "ExampleBrowser/1.0",
  });
  const apiClientResponse = await render({
    accept: "application/json",
    "user-agent": "ExampleApiClient/1.0",
  });

  assert.equal(compatibilityResponse.status, 200);
  assert.equal(apiClientResponse.status, 200);
  assert.deepEqual(
    await compatibilityResponse.json(),
    await apiClientResponse.json(),
  );

  const unsupported = await render({
    accept: "application/vnd.aittadb-invest+json; version=1.0",
  });
  assert.equal(unsupported.status, 406);
  assert.equal((await unsupported.json()).data.code, "not_acceptable");
});
