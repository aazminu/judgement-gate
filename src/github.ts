import { appJwt } from "./crypto";
import type { ChangedFile, Env, FetchFn, PrContext, PullRequestEvent } from "./types";

export const CHECK_NAME = "judgement-gate";
export const COMMENT_MARKER = "<!-- judgement-gate -->";
const PATCH_BUDGET = 50 * 1024;

// Highest priority first: migrations, config, manifests, core models.
const PRIORITY: RegExp[] = [
  /(^|\/)(migrations?|db\/migrate|alembic|prisma)\//i,
  /\.sql$/i,
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|Cargo\.toml|requirements.*\.txt|pyproject\.toml|Gemfile)$/i,
  /\.(tf|tfvars|ya?ml|toml)$|(^|\/)(Dockerfile|wrangler\.toml|\.github\/)/i,
  /(^|\/)(models?|schema|entities|domain|auth)\b/i,
];

function rank(name: string): number {
  const i = PRIORITY.findIndex((re) => re.test(name));
  return i === -1 ? PRIORITY.length : i;
}

export function buildPatchExtract(files: ChangedFile[], budget = PATCH_BUDGET): string {
  let out = "";
  for (const f of [...files].sort((a, b) => rank(a.filename) - rank(b.filename))) {
    if (!f.patch) continue;
    const chunk = `--- ${f.filename} (${f.status})\n${f.patch}\n`;
    if (out.length + chunk.length > budget) {
      out += chunk.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += chunk;
  }
  return out;
}

export class GitHubClient {
  private base: string;
  constructor(
    private token: string,
    private fetchFn: FetchFn,
    base = "https://api.github.com",
  ) {
    this.base = base.replace(/\/$/, "");
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "judgement-gate",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  createCheckRun(owner: string, repo: string, headSha: string) {
    return this.req<{ id: number }>("POST", `/repos/${owner}/${repo}/check-runs`, {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
      output: { title: "Evaluating change", summary: "Classifying blast radius..." },
    });
  }

  completeCheckRun(
    owner: string,
    repo: string,
    id: number,
    conclusion: "success" | "failure" | "neutral",
    title: string,
    summary: string,
  ) {
    return this.req("PATCH", `/repos/${owner}/${repo}/check-runs/${id}`, {
      status: "completed",
      conclusion,
      output: { title, summary },
    });
  }

  async listFiles(owner: string, repo: string, pr: number): Promise<ChangedFile[]> {
    const all: ChangedFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.req<ChangedFile[]>("GET", `/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  /** Upsert the single bot comment, found by its hidden marker. */
  async upsertComment(owner: string, repo: string, pr: number, body: string): Promise<"created" | "updated"> {
    const comments = await this.req<{ id: number; body: string }[]>("GET", `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`);
    const existing = comments.find((c) => c.body.includes(COMMENT_MARKER));
    if (existing) {
      if (existing.body !== body) await this.req("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
      return "updated";
    }
    await this.req("POST", `/repos/${owner}/${repo}/issues/${pr}/comments`, { body });
    return "created";
  }
}

export async function installationToken(env: Env, installationId: number, fetchFn: FetchFn): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const base = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetchFn(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "User-Agent": "judgement-gate" },
  });
  if (!res.ok) throw new Error(`installation token -> ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

export function assembleContext(ev: PullRequestEvent, files: ChangedFile[]): PrContext {
  const pr = ev.pull_request;
  return {
    title: pr.title,
    body: pr.body ?? "",
    baseBranch: pr.base.ref,
    headSha: pr.head.sha,
    files,
    patchExtract: buildPatchExtract(files),
  };
}
