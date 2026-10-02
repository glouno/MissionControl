import test from "node:test";
import assert from "node:assert/strict";
import { AzureProvider } from "./providers.js";
test("Azure streaming refuses incomplete, duplicate or oversized events instead of admitting ambiguous usage", async () => {
  const config = {
    kind: "azure" as const,
    reasoningEffort: "medium" as const,
    maxOutputTokens: 64,
    endpoint: "https://example.invalid",
    model: "synthetic",
    credential: "key" as const,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
  };
  const completion =
    "data: " +
    JSON.stringify({
      type: "response.completed",
      response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } },
    }) +
    "\n\n";
  for (const [body, reason] of [
    [completion + 'data: {"partial":', /incomplete event/],
    [completion + completion, /Duplicate Azure/],
    ["data: " + "x".repeat(1024 * 1024 + 1), /event exceeded/],
    ["data: " + "x".repeat(1024 * 1024 + 1) + "\n\n", /event exceeded/],
  ] as const) {
    const provider = new AzureProvider(
      config,
      async () => new Response(body),
      async () => ({}),
    );
    await assert.rejects(
      provider.generate([], [], AbortSignal.timeout(1000)),
      reason,
    );
  }
  // Split CRLF delimiters across transport chunks, as a real stream can do.
  const crlf = completion.replaceAll("\n", "\r\n");
  const provider = new AzureProvider(
    config,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const character of crlf)
              controller.enqueue(new TextEncoder().encode(character));
            controller.close();
          },
        }),
      ),
    async () => ({}),
  );
  assert.equal(
    (await provider.generate([], [], AbortSignal.timeout(1000))).inputTokens,
    1,
  );
});
