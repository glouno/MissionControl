import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { ControlClient } from "./client.js";

test("controller operation timeout overrides a shorter HTTP headers timeout without replay", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    assert.equal(req.headers["idempotency-key"], "synthetic-key");
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    }, 150);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const prior = getGlobalDispatcher();
  const agent = new Agent({ headersTimeout: 20, bodyTimeout: 20 });
  const observed: Array<{ headersTimeout?: number | null; bodyTimeout?: number | null }> = [];
  const dispatch = agent.dispatch.bind(agent);
  agent.dispatch = (options, handler) => {
    observed.push({ headersTimeout: options.headersTimeout, bodyTimeout: options.bodyTimeout });
    return dispatch(options, handler);
  };
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(prior);
    await agent.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new ControlClient(`http://127.0.0.1:${address.port}`, "synthetic-token");
  assert.deepEqual(await client.request("/synthetic-result", "POST", {}, "synthetic-key", 1500),
                   { accepted: true });
  assert.equal(requests, 1);
  assert.deepEqual(observed, [{ headersTimeout: 1500, bodyTimeout: 1500 }]);
});

test("controller result deadline still aborts delayed response and never retries", async (t) => {
  let requests = 0;
  const server = createServer((req) => { requests++; req.resume(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new ControlClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`,
                                   "synthetic-token");
  await assert.rejects(client.request("/synthetic-result", "POST", {}, undefined, 100));
  assert.equal(requests, 1);
});
