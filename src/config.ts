import YAML from "yaml";
import { compileDeclarative, type DeclarativeSpec, type SatisfiedBy } from "./judgements/declarative";
import { BUILTIN_IDS, builtinById, type BuiltinDefaults } from "./judgements/registry";
import type { Judgement } from "./types";

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
  if (!Array.isArray(v) || v.some((g) => typeof g !== "string")) throw new ConfigError(`${where}: "applies_to" must be a list of strings`);
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

function declarative(o: Obj, where: string): DeclarativeSpec {
  const threshold = o.threshold;
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) {
    throw new ConfigError(`${where}: "threshold" must be a number between 0 and 1`);
  }
  return {
    id: str(o, "id", where),
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
  if (doc.judgements === undefined) return fallback();
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
