import type { FetchFn, JevAnswers, JevQuestion, Judgement, PrContext } from "./types";

export class JevTimeout extends Error {}

export interface JevConfig {
  apiKey: string;
  url: string;
  model: string;
  timeoutMs: number;
}

export const questionKey = (j: Judgement, key: string) => (j.unprefixedKeys ? key : `${j.id}.${key}`);

export function buildRequest(ctx: PrContext, model: string, judgements: Judgement[]) {
  const questions: Record<string, JevQuestion> = {};
  for (const j of judgements) {
    for (const [key, q] of Object.entries(j.questions)) questions[questionKey(j, key)] = q;
  }
  return {
    model,
    state: {
      title: ctx.title,
      description: ctx.body,
      base_branch: ctx.baseBranch,
      changed_files: ctx.files.map((f) => `${f.status} ${f.filename}`),
      diff: ctx.patchExtract,
    },
    questions,
  };
}

export async function evaluate(
  ctx: PrContext,
  judgements: Judgement[],
  cfg: JevConfig,
  fetchFn: FetchFn,
): Promise<Record<string, JevAnswers>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(cfg.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(ctx, cfg.model, judgements)),
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted) throw new JevTimeout(`Jev did not respond within ${cfg.timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`Jev -> ${res.status} ${await res.text()}`);
  const raw = ((await res.json()) as { answers?: JevAnswers }).answers ?? {};

  const out: Record<string, JevAnswers> = {};
  for (const j of judgements) {
    out[j.id] = {};
    for (const [key, q] of Object.entries(j.questions)) {
      const a = raw[questionKey(j, key)];
      const ok = q.type === "noul" ? typeof a?.noul === "number" : typeof a?.choice === "string" && a.choice !== "";
      if (!ok) throw new Error("Jev response missing expected answers");
      out[j.id][key] = a;
    }
  }
  return out;
}
