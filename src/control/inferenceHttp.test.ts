import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { inferenceHttpFetch } from "./inferenceHttp.js";

for (const wait of ["headers", "body"] as const) {
  test(`inference ${wait} wait respects the admitted signal, without default HTTP expiry or replay`, async (t) => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      assert.equal(req.headers.authorization, "Bearer synthetic-capability");
      assert.equal(req.method, "POST");
      req.resume();
      const finish = () => res.end('data: {"type":"response.completed"}\n\n');
      if (wait === "body") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"type":"response.created"}\n\n');
        setTimeout(finish, 1200);
      } else setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        finish();
      }, 1200);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
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
      server.closeAllConnections();
      await agent.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const response = await inferenceHttpFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
      method: "POST", headers: { authorization: "Bearer synthetic-capability" },
      body: "{}", redirect: "error", signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /response.completed/);
    assert.equal(calls, 1);
    assert.deepEqual(observed, [{ headersTimeout: 3600000, bodyTimeout: 3600000 }]);
  });
}

test("inference caller deadline cancels the response body and never replays a POST", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"response.created"}\n\n');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const response = await inferenceHttpFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(100),
  });
  await assert.rejects(response.text());
  assert.equal(calls, 1);
});

test("inference HTTP redirects are refused without following their destination", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(307, { location: "/other-destination" });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await assert.rejects(inferenceHttpFetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(1000), redirect: "error",
  }));
  assert.equal(calls, 1);
});
