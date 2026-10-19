import type { ChangedFile } from "./types";

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re) return re;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // zero or more directories
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re = new RegExp(`^${out}$`);
  cache.set(pattern, re);
  return re;
}

export function matchesGlob(pattern: string, filename: string): boolean {
  return toRegExp(pattern).test(filename);
}

/** A judgement applies when it has no globs, or any changed file matches any glob. */
export function appliesToFiles(appliesTo: string[] | undefined, files: ChangedFile[]): boolean {
  if (!appliesTo || appliesTo.length === 0) return true;
  return files.some((f) => appliesTo.some((g) => matchesGlob(g, f.filename)));
}
