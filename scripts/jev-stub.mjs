// Scripted stand-in for Jev, for scripts/e2e.mjs. Never calls out; answers only what the test script told it to.
//   POST /               the Jev decisions API: {model, state, questions} -> {answers}
//   GET|POST /__control  read / set {mode, answers}. mode: ok | down (HTTP 503) | badsev (an unrecognised choice for
//                        every choice question except one-way-door's `synthetic_classification`).
//                        answers: {<question key>: {noul} | {choice, confidence}}. A requested key with no entry is omitted.
// Env: PORT (default 8789), JEV_API_KEY (default dev-test-key; a request with another bearer token gets 401).
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8789);
const KEY = process.env.JEV_API_KEY ?? "dev-test-key";
const state = { mode: "ok", answers: {}, requests: 0 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const send = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const { pathname } = new URL(req.url, "http://x");

  if (pathname === "/__control") {
    if (req.method === "POST") {
      const next = JSON.parse(raw || "{}");
      if (next.mode !== undefined && !["ok", "down", "badsev"].includes(next.mode)) return send(400, { error: `bad mode ${next.mode}` });
      if (next.mode !== undefined) state.mode = next.mode;
      if (next.answers !== undefined) state.answers = next.answers;
      log(`CONTROL mode=${state.mode} answers=${Object.keys(state.answers).length}`);
    }
    return send(200, state);
  }
  if (req.method !== "POST" || pathname !== "/") return send(404, { error: "not found" });
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: "bad key" });

  state.requests++;
  if (state.mode === "down") {
    log("JEV    503 (mode=down)");
    return send(503, { error: "stub is down" });
  }
  const { questions = {} } = JSON.parse(raw);
  const answers = {};
  for (const [key, q] of Object.entries(questions)) {
    if (state.mode === "badsev" && q.type === "choice" && key !== "synthetic_classification") {
      answers[key] = { choice: "SEV-UNKNOWN", confidence: 0.5 };
    } else if (state.answers[key] !== undefined) {
      answers[key] = state.answers[key];
    }
  }
  log(`JEV    ${Object.keys(questions).length} questions, ${Object.keys(answers).length} answered (mode=${state.mode})`);
  send(200, { answers });
});

server.listen(PORT, () => console.log(`jev stub on http://localhost:${PORT}`));
