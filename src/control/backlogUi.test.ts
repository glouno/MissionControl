import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { CONTROL_HTML } from "./ui.js";

// Small DOM contract harness: execute the shipped dashboard handlers, including
// pending fetches and session invalidation, without a browser dependency.
class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  onclick?: () => Promise<void>;
  isConnected = true;
  constructor(readonly tag: string) {}
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  focus() {}
  remove() {
    this.isConnected = false;
  }
  reportValidity() {
    return true;
  }
  querySelector() {
    return null;
  }
}
function harness() {
  const elements = Object.fromEntries(
    [
      "view",
      "navigation",
      "error",
      "status",
      "app",
      "login",
      "logout",
      "refresh",
      "detail",
      "token",
    ].map((id) => [id, new Element("div")]),
  );
  const requests: { path: string; options: RequestInit }[] = [];
  let response = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
  const context = {
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (tag: string) => new Element(tag),
      createDocumentFragment: () => new Element("fragment"),
    },
    crypto: { randomUUID: () => "synthetic-key" },
    fetch: async (path: string, options: RequestInit) => {
      requests.push({ path, options });
      return response();
    },
    console,
  };
  const script = CONTROL_HTML.split("<script>")[1]
    .split("</script>")[0]
    .split("for(const view of views)")[0];
  runInNewContext(script, context);
  const evaluate = (code: string) => runInNewContext(code, context);
  evaluate(
    `csrf='synthetic-csrf';active='Work';filters.project='synthetic';data={projects:[{id:'synthetic',readiness:{admissible:true}}],backlog:[],goals:[],tasks:[],budgets:{}};`,
  );
  return {
    elements,
    requests,
    evaluate,
    setResponse: (fn: typeof response) => {
      response = fn;
    },
  };
}
function descendants(e: Element): Element[] {
  return [e, ...e.children.flatMap(descendants)];
}
function click(h: ReturnType<typeof harness>, label: string) {
  const b = descendants(h.elements.view).find(
    (e) => e.tag === "button" && e.textContent === label,
  );
  assert.ok(b, label);
  return b.onclick!();
}

test("Work backlog empty, hostile text, scoped records, inert save and pending duplicate prevention", async () => {
  const h = harness();
  h.evaluate("backlogList(el('view'))");
  assert.ok(
    descendants(h.elements.view).some(
      (e) => e.textContent === "No backlog records for this project.",
    ),
  );
  await click(h, "Add backlog record");
  const fields = descendants(h.elements.view).filter((e) =>
    ["input", "textarea"].includes(e.tag),
  );
  fields[0].value = "<img src=x onerror=alert(1)>";
  fields[1].value = "Description";
  fields[2].value = "8";
  fields[3].value = "dep-one\ndep-two";
  fields[4].value = "Criterion one\nCriterion two";
  let release!: () => void;
  h.setResponse(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: true, status: 200, json: async () => ({}) });
      }),
  );
  const saving = click(h, "Save backlog record");
  await Promise.resolve();
  assert.equal(
    descendants(h.elements.view).find(
      (e) => e.textContent === "Save backlog record",
    )!.disabled,
    true,
  );
  await click(h, "Save backlog record");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, "/api/v1/backlog");
  assert.equal(h.requests[0].options.credentials, "same-origin");
  assert.equal(
    (h.requests[0].options.headers as Record<string, string>)["X-CSRF-Token"],
    "synthetic-csrf",
  );
  const body = JSON.parse(h.requests[0].options.body as string);
  assert.deepEqual(body.dependencies, ["dep-one", "dep-two"]);
  assert.deepEqual(body.acceptanceCriteria, ["Criterion one", "Criterion two"]);
  assert.equal(body.priority, 8);
  // Keep the follow-up refresh local to the harness.
  h.evaluate("refresh=async()=>{};render=()=>{}");
  release();
  await saving;
  h.evaluate(
    `data.backlog=[{id:'one',projectId:'synthetic',title:'<img src=x onerror=alert(1)>',description:'Hostile text',status:'backlog',revision:1,priority:8,acceptanceCriteria:[],dependencyStatus:[],blockedReasons:[]},{id:'foreign',projectId:'other'}];el('view').replaceChildren();backlogList(el('view'));`,
  );
  assert.ok(
    descendants(h.elements.view).some(
      (e) => e.textContent === "<img src=x onerror=alert(1)>",
    ),
  );
  assert.equal(
    descendants(h.elements.view).some((e) => e.tag === "img"),
    false,
  );
  assert.equal(
    descendants(h.elements.view).some((e) => e.dataset.backlogId === "foreign"),
    false,
  );
  h.setResponse(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  await click(h, "Launch backlog record");
  assert.equal(h.requests.at(-1)!.path, "/api/v1/backlog/one/launch");
  assert.deepEqual(JSON.parse(h.requests.at(-1)!.options.body as string), {
    projectId: "synthetic",
    revision: 1,
  });
});

test("backlog revision errors and expired or revoked sessions are visible; loading clears after errors", async () => {
  const h = harness();
  h.evaluate("backlogList(el('view'))");
  await click(h, "Add backlog record");
  h.setResponse(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: { message: "Backlog revision changed" } }),
  }));
  await click(h, "Save backlog record");
  assert.equal(h.elements.error.textContent, "Backlog revision changed");
  assert.equal(
    descendants(h.elements.view).find(
      (e) => e.textContent === "Save backlog record",
    )!.disabled,
    false,
  );
  h.setResponse(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: "Unauthorized" } }),
  }));
  await click(h, "Save backlog record");
  assert.equal(h.elements.app.hidden, true);
  assert.equal(h.elements.login.hidden, false);
  assert.equal(h.elements.view.children.length, 0);
  assert.match(h.elements.status.textContent, /Session unavailable/);
  const loading = harness();
  let reject!: (e: Error) => void;
  loading.setResponse(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  const pending = loading.evaluate("refresh()") as Promise<void>;
  assert.equal(loading.elements.view.attributes["aria-busy"], "true");
  assert.match(loading.elements.status.textContent, /Loading/);
  reject(Error("Synthetic loading error"));
  await assert.rejects(pending, /Synthetic loading error/);
  assert.equal(loading.elements.view.attributes["aria-busy"], "false");
});

test("interrupted ownership answers require evidence and send it with the exact decision revision", async () => {
  const h = harness();
  h.evaluate(
    `decisions(el('view'),[{id:'recovery',goalId:'goal',revision:3,request:{question:'Inspect stopped work',reason:'Interrupted execution',recoveryAttemptId:'task:2',options:[{id:'inspect',label:'Resolve ownership'},{id:'defer',label:'Keep pending'}]}}])`,
  );
  await click(h, "Resolve ownership");
  assert.equal(h.requests.length, 0);
  assert.match(h.elements.error.textContent, /confirmed stopped/);
  const evidence = descendants(h.elements.view).find(
    (e) => e.tag === "textarea",
  )!;
  evidence.value = "Owned runtime stopped; retained effects inspected";
  await click(h, "Resolve ownership");
  const answer = h.requests.find(
    (r) => r.path === "/api/v1/questions/recovery/answer",
  )!;
  assert.deepEqual(JSON.parse(String(answer.options.body)), {
    option: "inspect",
    revision: 3,
    explanation: evidence.value,
  });
});
