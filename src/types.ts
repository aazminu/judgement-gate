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
  reason: "type1_adr" | "type1_no_adr" | "ambiguous" | "type2_ok" | "type2_no_plan" | "degraded";
};
