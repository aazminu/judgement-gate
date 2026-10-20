// Tiny fake GitHub API so the demo works without a GitHub App. Run: npm run mock-github
// Point the Worker at it with GITHUB_API_URL=http://localhost:8788 (see .dev.vars.example).
// Scenarios are chosen by PR number (see SCENARIOS) and recorded results are printed to the console.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8788);
// The org judgement config the fake `.github` repo serves. Point MOCK_CONFIG elsewhere to try your own.
const CONFIG_FILE = process.env.MOCK_CONFIG ?? "examples/judgement-gate.yml";

import { SCENARIOS } from "./scenarios.mjs";

const comments = new Map(); // pr -> [{id, body}]
let nextId = 1000;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const url = new URL(req.url, "http://x");
  const send = (obj, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

  let m;
  if (req.method === "POST" && /\/access_tokens$/.test(url.pathname)) return send({ token: "mock-token" }, 201);
  if (req.method === "POST" && /\/check-runs$/.test(url.pathname)) {
    log(`CHECK  in_progress  ${body.name} @ ${body.head_sha.slice(0, 7)}`);
    return send({ id: nextId++ }, 201);
  }
  if (req.method === "PATCH" && /\/check-runs\/\d+$/.test(url.pathname)) {
    log(`CHECK  ${body.conclusion.toUpperCase().padEnd(8)} ${body.output.title}`);
    for (const line of (body.output.summary ?? "").split("\n").filter(Boolean)) console.log("         | " + line);
    return send({});
  }
  if ((m = url.pathname.match(/\/pulls\/(\d+)\/files$/))) {
    return send(url.searchParams.get("page") === "1" ? (SCENARIOS[m[1]]?.files ?? []) : []);
  }
  if (req.method === "POST" && (m = url.pathname.match(/\/issues\/(\d+)\/labels$/))) {
    log(`LABEL added on #${m[1]}: ${(body?.labels ?? []).join(", ")}`);
    return send([]);
  }
  if ((m = url.pathname.match(/\/issues\/(\d+)\/comments$/))) {
    const list = comments.get(m[1]) ?? [];
    if (req.method === "GET") return send(list);
    list.push({ id: nextId++, body: body.body });
    comments.set(m[1], list);
    log(`COMMENT created on #${m[1]}:\n${body.body.split("\n").map((l) => "         | " + l).join("\n")}`);
    return send({ id: nextId }, 201);
  }
  if ((m = url.pathname.match(/\/issues\/comments\/(\d+)$/)) && req.method === "PATCH") {
    for (const list of comments.values()) for (const c of list) if (String(c.id) === m[1]) c.body = body.body;
    log(`COMMENT edited #${m[1]}`);
    return send({});
  }
  if (req.method === "GET" && /\/repos\/[^/]+\/\.github\/contents\/\.github\/judgement-gate\.yml$/.test(url.pathname)) {
    if (!fs.existsSync(CONFIG_FILE)) return send({ message: "Not Found" }, 404);
    res.writeHead(200, { "Content-Type": "text/plain" });
    log(`CONFIG served ${CONFIG_FILE}`);
    return res.end(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  send({ error: "not found" }, 404);
});

server.listen(PORT, () => console.log(`mock GitHub on http://localhost:${PORT}`));
