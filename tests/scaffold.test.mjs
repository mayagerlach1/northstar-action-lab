import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createLabServer } from "../scripts/server.mjs";

test("serves only public files, and keeps the privileged action endpoint disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ie-action-scaffold-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Practice lab</title>");
  await writeFile(join(dir, "data.json"), '{"synthetic":true}');
  const server = createLabServer({ publicDir: dir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /^text\/html/);
    assert.match(await home.text(), /Practice lab/);
    const data = await fetch(`${origin}/data.json`);
    assert.deepEqual(await data.json(), { synthetic: true });
    const head = await fetch(`${origin}/data.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const disabled = await fetch(`${origin}/api/create-issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recordId: "SYNTHETIC-001" }),
    });
    assert.equal(disabled.status, 501);
    assert.equal((await disabled.json()).code, "PRACTICE_MODE_ONLY");
    assert.equal((await fetch(`${origin}/api/create-issue`)).status, 405);
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${origin}/%2e%2e%2fpackage.json`)).status, 403);
    assert.equal((await fetch(`${origin}/%00`)).status, 400);
    assert.equal((await fetch(`${origin}/.env`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
