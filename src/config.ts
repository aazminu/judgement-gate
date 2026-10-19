import YAML from "yaml";
import { compileDeclarative, type DeclarativeSpec, type SatisfiedBy } from "./judgements/declarative";
import { BUILTIN_IDS, builtinById, type BuiltinDefaults } from "./judgements/registry";
import type { GitHubClient } from "./github";
import type { Env, Judgement } from "./types";

export class ConfigError extends Error {}

const MAX_REGEX = 200;
const USE_KEYS = new Set(["use", "confidence_threshold", "applies_to"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new ConfigError(`${where}: "${key}" must be a non-empty string`);
  return v;
}

function globs(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || v.some((g) => typeof g !== "string" || g === "")) {
    throw new ConfigError(`${where}: "applies_to" must be a non-empty list of glob strings (omit it to always apply)`);
  }
  return v as string[];
}

function bodyRegex(pattern: unknown, where: string): RegExp {
  if (typeof pattern !== "string" || pattern === "") throw new ConfigError(`${where}: pr_body_matches must be a non-empty string`);
  if (pattern.length > MAX_REGEX) throw new ConfigError(`${where}: pr_body_matches is longer than ${MAX_REGEX} characters`);
  const ci = pattern.startsWith("(?i)");
  try {
    return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "mi" : "m");
  } catch (e) {
    throw new ConfigError(`${where}: pr_body_matches is not a valid regex (${(e as Error).message})`);
  }
}

function satisfiedBy(v: unknown, where: string): SatisfiedBy[] {
  if (!Array.isArray(v) || v.length === 0) throw new ConfigError(`${where}: "satisfied_by" must be a non-empty list`);
  return v.map((entry) => {
    if (isObj(entry) && Object.keys(entry).length === 1) {
      if ("pr_body_matches" in entry) return { pr_body_matches: bodyRegex(entry.pr_body_matches, where) };
      if ("file_added" in entry && typeof entry.file_added === "string" && entry.file_added !== "") return { file_added: entry.file_added };
    }
    throw new ConfigError(`${where}: each satisfied_by entry must be exactly one of pr_body_matches or file_added`);
  });
}

const DECLARATIVE_KEYS = new Set(["id", "name", "question", "true", "false", "threshold", "applies_to", "satisfied_by", "why", "fix"]);
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function declarative(o: Obj, where: string): DeclarativeSpec {
  const unknown = Object.keys(o).filter((k) => !DECLARATIVE_KEYS.has(k));
  if (unknown.length > 0) throw new ConfigError(`${where}: unknown key ${unknown.map((k) => `"${k}"`).join(", ")}`);
  const id = str(o, "id", where);
  if (!KEBAB.test(id)) throw new ConfigError(`${where}: "id" must be kebab-case (lowercase letters, digits, hyphens)`);
  const threshold = o.threshold;
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) {
    throw new ConfigError(`${where}: "threshold" must be a number between 0 and 1`);
  }
  return {
    id,
    name: str(o, "name", where),
    question: str(o, "question", where),
    whenTrue: str(o, "true", where),
    whenFalse: str(o, "false", where),
    threshold,
    appliesTo: globs(o.applies_to, where),
    satisfiedBy: satisfiedBy(o.satisfied_by, where),
    why: str(o, "why", where),
    fix: str(o, "fix", where),
  };
}

/**
 * Parse the org's judgement YAML. Empty, missing or empty-list config yields the default built-in list.
 * Anything malformed throws ConfigError so the caller can fall back and say so.
 */
export function parseConfig(text: string, defaults: BuiltinDefaults): Judgement[] {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new ConfigError(`YAML syntax error: ${(e as Error).message.split("\n")[0]}`);
  }
  const fallback = () => [builtinById("one-way-door", {}, defaults)!];
  if (doc === null || doc === undefined) return fallback();
  if (!isObj(doc)) throw new ConfigError("config root must be a mapping");
  const unknownRoot = Object.keys(doc).filter((k) => k !== "judgements");
  if (unknownRoot.length > 0) throw new ConfigError(`unknown top-level key ${unknownRoot.map((k) => `"${k}"`).join(", ")} (expected "judgements")`);
  if (doc.judgements === undefined || doc.judgements === null) return fallback();
  if (!Array.isArray(doc.judgements)) throw new ConfigError('"judgements" must be a list');
  if (doc.judgements.length === 0) return fallback();

  const seen = new Set<string>();
  const out: Judgement[] = [];
  doc.judgements.forEach((entry, i) => {
    if (!isObj(entry)) throw new ConfigError(`judgements[${i}] must be a mapping`);
    let j: Judgement;
    if ("use" in entry) {
      const where = `judgements[${i}] (use: ${String(entry.use)})`;
      const bad = Object.keys(entry).filter((k) => !USE_KEYS.has(k));
      if (bad.length > 0) throw new ConfigError(`${where}: cannot override ${bad.join(", ")}`);
      const ct = entry.confidence_threshold;
      if (ct !== undefined && (typeof ct !== "number" || !(ct >= 0 && ct <= 1))) {
        throw new ConfigError(`${where}: "confidence_threshold" must be a number between 0 and 1`);
      }
      const built = builtinById(
        String(entry.use),
        { confidence_threshold: ct as number | undefined, applies_to: globs(entry.applies_to, where) },
        defaults,
      );
      if (!built) throw new ConfigError(`${where}: unknown built-in (known: ${BUILTIN_IDS.join(", ")})`);
      j = built;
    } else {
      const where = `judgements[${i}] (${typeof entry.id === "string" ? entry.id : "no id"})`;
      const spec = declarative(entry, where);
      if ((BUILTIN_IDS as readonly string[]).includes(spec.id)) throw new ConfigError(`${where}: id collides with a built-in`);
      j = compileDeclarative(spec);
    }
    if (seen.has(j.id)) throw new ConfigError(`duplicate judgement id "${j.id}"`);
    seen.add(j.id);
    out.push(j);
  });
  return out;
}

export const CONFIG_PATH = ".github/judgement-gate.yml";
const CACHE_SECONDS = 60;

async function readConfigText(gh: GitHubClient, owner: string, repo: string): Promise<string | null> {
  const cache = typeof caches !== "undefined" ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
  const key = new Request(`https://judgement-gate.invalid/config/${owner}/${repo}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return (await hit.text()) || null;
    } catch {
      // cache is best-effort
    }
  }
  const text = await gh.getFileContents(owner, repo, CONFIG_PATH);
  if (cache) {
    try {
      await cache.put(key, new Response(text ?? "", { headers: { "Cache-Control": `max-age=${CACHE_SECONDS}` } }));
    } catch {
      // cache is best-effort
    }
  }
  return text;
}

/**
 * Load the org's judgements from the default branch of <owner>/<CONFIG_REPO>. Never throws: a missing
 * file means the default built-ins, and an unreadable or invalid file means the same plus a note.
 */
export async function loadJudgements(gh: GitHubClient, owner: string, env: Env): Promise<{ judgements: Judgement[]; note?: string }> {
  const defaults = { confidenceThreshold: Number(env.CONFIDENCE_THRESHOLD ?? 0.75) };
  const repo = env.CONFIG_REPO ?? ".github";
  const fallback = () => parseConfig("", defaults);
  let text: string | null;
  try {
    text = await readConfigText(gh, owner, repo);
  } catch (e) {
    return { judgements: fallback(), note: `Could not read judgement config (${(e as Error).message}); fell back to built-in judgements.` };
  }
  if (text === null) return { judgements: fallback() };
  try {
    return { judgements: parseConfig(text, defaults) };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return { judgements: fallback(), note: `Config error: ${e.message}; fell back to built-in judgements.` };
  }
}
