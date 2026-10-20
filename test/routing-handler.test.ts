import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../src/config";
import { processPullRequest } from "../src/handler";
import type { AnalyticsSink, Env, PullRequestEvent } from "../src/types";

type Call = { method: string; url: string; body?: any };
let allCalls: Call[] = [];

beforeEach(() => {
  clearConfigCache();
  allCalls = [];
});

afterEach(() => {
  clearConfigCache();
  vi.restoreAllMocks();
  // The label is sticky: the gate never removes it, so no test may ever see a DELETE.
  expect(allCalls.filter((c) => c.method === "DELETE")).toEqual([]);
});

async function makeEnv(extra: Partial<Env> = {}): Promise<Env> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
  return {
    GITHUB_WEBHOOK_SECRET: "s",
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: pem,
    JEV_API_KEY: "k",
    MODE: "enforce",
    GITHUB_API_URL: "https://gh.test",
    JEV_API_URL: "https://jev.test/decisions",
    ...extra,
  };
}

function prEvent(body = "no plan"): PullRequestEvent {
  return {
    action: "opened",
    installation: { id: 9 },
    repository: { name: "r", owner: { login: "o" } },
    pull_request: { number: 7, title: "t", body, base: { ref: "main" }, head: { sha: "abc" } },
  };
}

const benign = {
  is_one_way_boundary_mutation: { noul: 0.02 },
  is_additive_or_isolated: { noul: 0.9 },
  has_concrete_reversal_plan: { noul: 0.9 },
  synthetic_classification: { choice: "TYPE_2_TWO_WAY_DOOR", confidence: 0.9 },
};
const type1 = {
  is_one_way_boundary_mutation: { noul: 0.96 },
  is_additive_or_isolated: { noul: 0.1 },
  has_concrete_reversal_plan: { noul: 0.1 },
  synthetic_classification: { choice: "TYPE_1_ONE_WAY_DOOR", confidence: 0.8 },
};

interface NetOpts {
  config: { status: number; body?: string };
  answers?: Record<string, unknown>;
  jevStatus?: number;
  files?: { filename: string; status: string; patch?: string }[];
  labelStatus?: number;
}

function fakeNet(o: NetOpts) {
  const calls: Call[] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    allCalls.push({ method, url, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status });
    if (url.includes("jev.test")) return o.jevStatus ? new Response("boom", { status: o.jevStatus }) : json({ answers: o.answers ?? {} });
    if (url.includes("/contents/")) return new Response(o.config.body ?? "", { status: o.config.status });
    if (url.endsWith("/access_tokens")) return json({ token: "tok" }, 201);
    if (url.endsWith("/check-runs")) return json({ id: 55 }, 201);
    if (url.includes("/check-runs/55")) return json({});
    if (url.includes("/pulls/7/files")) return json(o.files ?? [{ filename: "src/a.ts", status: "modified", patch: "+x" }]);
    if (url.includes("/issues/7/comments") && method === "GET") return json([]);
    if (url.includes("/issues/7/comments") && method === "POST") return json({ id: 1 }, 201);
    if (url.endsWith("/issues/7/labels") && method === "POST") {
      const status = o.labelStatus ?? 200;
      return status === 200 ? json([{ name: "needs-human-review" }]) : json({ message: "Resource not accessible by integration" }, status);
    }
    return json({ error: "unexpected " + url }, 500);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const labelCalls = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/7/labels"));
const finalCheck = (calls: Call[]) => calls.filter((c) => c.method === "PATCH" && c.url.includes("/check-runs/55")).at(-1)?.body;
const postedComment = (calls: Call[]) => calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments"))?.body?.body as string | undefined;
const adrFiles = [{ filename: "docs/decisions/0001-x.md", status: "added", patch: "+x" }];

describe("review routing in the handler", () => {
  it("Type 1 with an ADR passes the check but routes to a human and adds the label", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: type1, files: adrFiles });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("success");
    const labels = labelCalls(net.calls);
    expect(labels).toHaveLength(1);
    expect(labels[0].url).toBe("https://gh.test/repos/o/r/issues/7/labels");
    expect(labels[0].body).toEqual({ labels: ["needs-human-review"] });
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: human (one-way-door flagged)");
  });

  it("a benign change routes to an agent with no label call", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(labelCalls(net.calls)).toHaveLength(0);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: agent");
  });

  it.each([
    ["ROUTING_MODE shadow under MODE enforce", { ROUTING_MODE: "shadow", MODE: "enforce" }],
    ["MODE shadow alone", { MODE: "shadow" }],
  ])("%s reports the route without labelling", async (_name, extra) => {
    const net = fakeNet({ config: { status: 404 }, answers: type1, files: adrFiles });
    await processPullRequest(prEvent(), await makeEnv(extra as Partial<Env>), net.fetchFn);
    expect(labelCalls(net.calls)).toHaveLength(0);
    expect(finalCheck(net.calls).output.summary).toContain("[Shadow] Review routing: would have routed to a human");
  });

  it("a typo in a routing key routes to a human and labels, without changing the check", async () => {
    const net = fakeNet({ config: { status: 200, body: "routing:\n  human-when: []\n" }, answers: benign });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(labelCalls(net.calls)).toHaveLength(1);
    expect(finalCheck(net.calls).output.summary).toContain("config error");
    expect(finalCheck(net.calls).conclusion).toBe("success");
  });

  it("an unreadable config reports routing unavailable and adds no label", async () => {
    const net = fakeNet({ config: { status: 500, body: "nope" }, answers: type1, files: adrFiles });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(labelCalls(net.calls)).toHaveLength(0);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: unavailable");
  });

  it("a files rule labels a PR even when no judgement applies (deleted file, no Jev call)", async () => {
    const config = `
judgements:
  - id: public-api-contract
    name: Public API contract change
    question: "Does this change break or remove a public API contract?"
    true: "removes/renames endpoints, fields or exported symbols"
    false: "additive or internal only"
    threshold: 0.6
    applies_to: ["services/api/**"]
    satisfied_by:
      - pr_body_matches: "(?i)^Migration Plan:"
    why: "Consumers cannot roll back with us."
    fix: "Add a 'Migration Plan:' line to the PR description."
routing:
  human_when:
    - files: ["migrations/**"]
`;
    const net = fakeNet({ config: { status: 200, body: config }, files: [{ filename: "migrations/9.sql", status: "removed" }] });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(net.calls.some((c) => c.url.includes("jev.test"))).toBe(false);
    expect(labelCalls(net.calls)).toHaveLength(1);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: human (files: migrations/**)");
  });

  it("a label API failure leaves the check conclusion and title unchanged and adds a note", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = fakeNet({ config: { status: 404 }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), ok.fetchFn);
    const denied = fakeNet({ config: { status: 404 }, answers: type1, labelStatus: 403 });
    await expect(processPullRequest(prEvent(), await makeEnv(), denied.fetchFn)).resolves.toBeDefined();
    expect(labelCalls(denied.calls)).toHaveLength(1);
    expect(finalCheck(denied.calls).conclusion).toBe(finalCheck(ok.calls).conclusion);
    expect(finalCheck(denied.calls).output.title).toBe(finalCheck(ok.calls).output.title);
    expect(finalCheck(denied.calls).output.summary).toContain("Could not add the review label");
    expect(finalCheck(ok.calls).output.summary).not.toContain("Could not add the review label");
  });

  it("during a Jev outage a files rule still labels, the check stays neutral", async () => {
    const config = "routing:\n  human_when:\n    - files: [\"infra/**\"]\n";
    const net = fakeNet({ config: { status: 200, body: config }, jevStatus: 500, files: [{ filename: "infra/main.tf", status: "modified", patch: "+x" }] });
    const v = await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(v.reason).toBe("degraded");
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(finalCheck(net.calls).output.title).toBe("[Audit Degraded]");
    expect(labelCalls(net.calls)).toHaveLength(1);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: human");
  });

  it("during a Jev outage judgement-only routing is unavailable and adds no label", async () => {
    const net = fakeNet({ config: { status: 404 }, jevStatus: 500 });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(labelCalls(net.calls)).toHaveLength(0);
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: unavailable");
  });

  it("a failure after routing is published does not label twice", async () => {
    // A config_error routes to human on both the normal and the degraded path, so a re-publish would label again.
    const net = fakeNet({ config: { status: 200, body: "routing:\n  human-when: []\n" }, answers: benign });
    let patches = 0;
    const fetchFn = ((input: any, init: any = {}) =>
      init.method === "PATCH" && String(input).includes("/check-runs/55") && patches++ === 0
        ? Promise.resolve(new Response("boom", { status: 502 }))
        : net.fetchFn(input, init)) as typeof fetch;
    await processPullRequest(prEvent(), await makeEnv(), fetchFn);
    expect(labelCalls(net.calls)).toHaveLength(1);
    expect(finalCheck(net.calls).conclusion).toBe("neutral");
    expect(finalCheck(net.calls).output.summary).toContain("Review routing: human (config error");
  });

  it("routing never changes the check conclusion", async () => {
    const base = "judgements:\n  - use: one-way-door\n";
    const withDefaults = fakeNet({ config: { status: 200, body: base }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), withDefaults.fetchFn);
    clearConfigCache();
    const noRules = fakeNet({ config: { status: 200, body: `${base}routing:\n  include_defaults: false\n` }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), noRules.fetchFn);

    expect(finalCheck(withDefaults.calls).conclusion).toBe("failure");
    expect(finalCheck(noRules.calls).conclusion).toBe("failure");
    expect(labelCalls(withDefaults.calls)).toHaveLength(1);
    expect(labelCalls(noRules.calls)).toHaveLength(0);
  });

  it("the remediation comment's hidden block carries the route", async () => {
    const net = fakeNet({ config: { status: 404 }, answers: type1 });
    await processPullRequest(prEvent(), await makeEnv(), net.fetchFn);
    const md = postedComment(net.calls)!;
    const m = /<!-- judgement-gate:v(\d+) (\{.*\}) -->/.exec(md)!;
    const block = JSON.parse(m[2]);
    expect(block.routing.route).toBe("human");
    expect(block.routing.label).toBe("needs-human-review");
  });

  it("records one routing data point with the routing mode and outcome", async () => {
    const points: { blobs?: string[] }[] = [];
    const sink: AnalyticsSink = { writeDataPoint: (p) => void points.push(p) };
    const net = fakeNet({ config: { status: 404 }, answers: type1, files: adrFiles });
    await processPullRequest(prEvent(), await makeEnv({ ANALYTICS: sink, ROUTING_MODE: "shadow" }), net.fetchFn);
    const routing = points.filter((p) => p.blobs?.[0] === "routing");
    expect(routing).toHaveLength(1);
    expect(routing[0].blobs?.slice(0, 6)).toEqual(["routing", "o/r", "", "shadow", "human", "one-way-door flagged"]);
  });
});
