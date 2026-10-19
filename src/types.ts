export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  JEV_API_KEY: string;
  MODE?: string;
  JEV_MODEL?: string;
  JEV_API_URL?: string;
  JEV_TIMEOUT_MS?: string;
  GITHUB_API_URL?: string;
  CONFIDENCE_THRESHOLD?: string;
  CONFIG_REPO?: string;
}

export type FetchFn = typeof fetch;

export interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    draft?: boolean;
    base: { ref: string };
    head: { sha: string };
  };
  changes?: { title?: unknown; body?: unknown; base?: unknown };
}

export interface ChangedFile {
  filename: string;
  status: string;
  patch?: string;
}

export interface PrContext {
  title: string;
  body: string;
  baseBranch: string;
  headSha: string;
  files: ChangedFile[];
  patchExtract: string;
}

export interface JevResult {
  oneWayProb: number;
  additiveProb: number;
  reversalProb: number;
  classification: "TYPE_1_ONE_WAY_DOOR" | "TYPE_2_TWO_WAY_DOOR";
  classificationConfidence: number;
}

export type Verdict = {
  conclusion: "success" | "failure" | "neutral";
  summary: string;
  reason: string;
};

export interface JevQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type JevAnswers = Record<string, { noul?: number; choice?: string; confidence?: number }>;

export interface JudgementVerdict {
  conclusion: "success" | "failure";
  reason: string;
  summary: string;
  signals?: string;
}

export interface RemedyContext {
  owner: string;
  repo: string;
  headRef: string;
}

/** A named question for the model, a decision rule, and a remedy that teaches the author. */
export interface Judgement {
  id: string;
  name: string;
  /** Globs against changed filenames; omitted means the judgement always applies. */
  appliesTo?: string[];
  /** Send question keys without the `${id}.` prefix. Only the built-in one-way-door uses this, to keep its original Jev contract. */
  unprefixedKeys?: boolean;
  questions: Record<string, JevQuestion>;
  decide(answers: JevAnswers, pr: PrContext): JudgementVerdict;
  remedy(v: JudgementVerdict, rc: RemedyContext): { why: string; fix: string };
}
