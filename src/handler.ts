import { parseFalsePositive, record } from "./analytics";
import { aggregate, type JudgementResult } from "./aggregate";
import { loadJudgements } from "./config";
import { renderComment } from "./comment";
import { verifySignature } from "./crypto";
import { assembleContext, GitHubClient, installationToken } from "./github";
import { evaluate } from "./jev";
import { appliesToFiles } from "./glob";
import type { Env, Judgement, FetchFn, IssueCommentEvent, PullRequestEvent, Verdict } from "./types";

const ACTIONS = new Set(["opened", "synchronize", "reopened", "edited", "ready_for_review"]);

export interface Deps {
  fetchFn: FetchFn;
  waitUntil: (p: Promise<unknown>) => void;
}

export async function handleWebhook(req: Request, env: Env, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const body = await req.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, req.headers.get("X-Hub-Signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }
  const event = req.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response("pong");
  if (event === "issue_comment") return handleIssueComment(JSON.parse(body) as IssueCommentEvent, env);
  if (event !== "pull_request") return new Response("ignored", { status: 202 });

  const ev = JSON.parse(body) as PullRequestEvent;
  if (!ACTIONS.has(ev.action) || !ev.installation) return new Response("ignored", { status: 202 });
  if (ev.pull_request.draft) return new Response("draft ignored", { status: 202 });
  // `edited` only matters when the title or body changed (not a base-branch retarget).
  if (ev.action === "edited" && !ev.changes?.title && !ev.changes?.body) return new Response("ignored", { status: 202 });

  // Ack immediately; do the work after the response so GitHub's 10s webhook timeout never bites.
  deps.waitUntil(processPullRequest(ev, env, deps.fetchFn).catch((e) => console.error("judgement-gate failed", e)));
  return new Response("accepted", { status: 202 });
}

/** A human replying `/judgement-gate false-positive <id>` on a PR is logged as feedback. No GitHub calls are made. */
function handleIssueComment(ev: IssueCommentEvent, env: Env): Response {
  if (ev.action !== "created" || !ev.issue.pull_request || ev.comment.user.type === "Bot") return new Response("ignored", { status: 202 });
  const id = parseFalsePositive(ev.comment.body);
  if (!id) return new Response("ignored", { status: 202 });
  record(env.ANALYTICS, {
    event: "feedback",
    repo: `${ev.repository.owner.login}/${ev.repository.name}`,
    pr: ev.issue.number,
    judgement: id,
    mode: env.MODE ?? "shadow",
    outcome: "false_positive",
    association: ev.comment.author_association ?? "",
  });
  return new Response("recorded", { status: 202 });
}

export async function processPullRequest(ev: PullRequestEvent, env: Env, fetchFn: FetchFn): Promise<Verdict> {
  const owner = ev.repository.owner.login;
  const repo = ev.repository.name;
  const pr = ev.pull_request.number;
  const started = Date.now();
  const repoName = `${owner}/${repo}`;
  const mode = env.MODE ?? "shadow";
  let evaluated: Judgement[] = [];
  const token = await installationToken(env, ev.installation!.id, fetchFn);
  const gh = new GitHubClient(token, fetchFn, env.GITHUB_API_URL);

  // Immediate visual feedback in parallel with context fetch.
  const [check, files] = await Promise.all([gh.createCheckRun(owner, repo, ev.pull_request.head.sha), gh.listFiles(owner, repo, pr)]);

  let configNote = "";
  try {
    const ctx = assembleContext(ev, files);
    const { judgements: all, note } = await loadJudgements(gh, owner, env);
    if (note) configNote = `\n\n_${note}_`;
    const applicable = all.filter((j) => appliesToFiles(j.appliesTo, files));
    evaluated = applicable;

    let results: JudgementResult[] = [];
    let latencyMs = 0;
    if (applicable.length > 0) {
      const jevStart = Date.now();
      const answers = await evaluate(
        ctx,
        applicable,
        {
          apiKey: env.JEV_API_KEY,
          url: env.JEV_API_URL ?? "https://openrouter.ai/api/alpha/decisions",
          model: env.JEV_MODEL ?? "typesafe/jev-1.14",
          timeoutMs: Number(env.JEV_TIMEOUT_MS ?? 2500),
        },
        fetchFn,
      );
      latencyMs = Date.now() - jevStart;
      results = applicable.map((judgement) => ({ judgement, verdict: judgement.decide(answers[judgement.id], ctx) }));
    }
    const verdict = aggregate(results);
    for (const { judgement, verdict: v } of results) {
      record(env.ANALYTICS, {
        event: "evaluation",
        repo: repoName,
        pr,
        judgement: judgement.id,
        mode,
        outcome: v.conclusion === "failure" ? "flagged" : v.metrics?.cleared ? "cleared" : "passed",
        reason: v.reason,
        probability: v.metrics?.probability,
        confidence: v.metrics?.confidence,
        latencyMs,
      });
    }
    const shadow = mode === "shadow";

    // The comment is best-effort: failing to post it must not hide a verdict we already computed.
    let commentNote = "";
    const failing = results.filter((r) => r.verdict.conclusion === "failure");
    if (failing.length > 0) {
      try {
        await gh.upsertComment(owner, repo, pr, renderComment(failing, { owner, repo, headRef: ev.pull_request.head.sha }, mode));
      } catch (e) {
        console.error("judgement-gate comment failed", e);
        commentNote = `\n\n_Could not post the remediation comment: ${(e as Error).message}_`;
      }
    }
    const lines = results.map((r) => `- ${r.verdict.conclusion === "success" ? "pass" : "FAIL"}: ${r.judgement.name} (${r.verdict.summary})`);
    const detail = lines.length > 0 ? `${verdict.summary}\n\n${lines.join("\n")}` : verdict.summary;
    await gh.completeCheckRun(
      owner,
      repo,
      check.id,
      shadow ? "success" : verdict.conclusion,
      shadow ? `[Shadow] ${verdict.summary}` : verdict.summary,
      (shadow ? `Shadow mode: would have concluded **${verdict.conclusion}**.\n\n${detail}` : detail) + configNote + commentNote,
    );
    return verdict;
  } catch (e) {
    for (const j of evaluated.length > 0 ? evaluated : [{ id: "" }]) {
      record(env.ANALYTICS, {
        event: "evaluation",
        repo: repoName,
        pr,
        judgement: j.id,
        mode,
        outcome: "degraded",
        reason: "degraded",
        latencyMs: Date.now() - started,
      });
    }
    // Fail open: never block hotfixes on an audit outage (Jev timeout, 5xx, malformed answer).
    await gh.completeCheckRun(owner, repo, check.id, "neutral", "[Audit Degraded]", `Evaluation unavailable: ${(e as Error).message}${configNote}`);
    return { conclusion: "neutral", reason: "degraded", summary: "[Audit Degraded]" };
  }
}
