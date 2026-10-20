# Authored Probing Questions (Step 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a judgement's author add a short list of probing questions (`probes`) that the gate shows to the PR author and embeds in the agent block, with sensible defaults for the built-in `one-way-door`.

**Architecture:** `Judgement` gains an optional `probes(verdict)` method returning the questions for that verdict. The built-in returns per-reason defaults, overridable from YAML; declarative judgements return their YAML list. `renderComment` prints them under the Fix and adds them to the agent block. No model call, no new permissions.

**Tech Stack:** TypeScript, Cloudflare Worker, `yaml` package, vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-teaching-gate-roadmap-design.md` (section "Step 1a").

## Global Constraints

- The YAML key is `probes` (working name from the spec).
- Static and deterministic: no model call, no new permission, no new state.
- Probes are authored by trusted CODEOWNERS, so they may appear in the agent block. The agent block still carries no PR or diff content.
- The agent block `schema` stays `1` (the change is additive). `AGENT_BLOCK_VERSION` does not change.
- Unknown keys in a judgement stay a `ConfigError`.
- Validation limits (plan's call): at most 7 probes per list, each a non-empty string of at most 300 characters.
- Fail-open behaviour and the single edit-in-place comment are unchanged. Existing tests stay green unchanged.
- Do not touch severity (step 2) or any model-grounded text (step 1b). Step 2 edits the same files (`src/types.ts`, `src/config.ts`, `src/comment.ts`); do not run them in parallel.

## Review Focus

- A probe containing `-->`, `<` or `>`: the agent block must still close correctly (Task 3).
- No probes (omitted key): no "Questions a reviewer will ask" heading in the comment, and `probes: []` in the agent block (Task 3).
- Two failing judgements: each section shows only its own probes (Task 3).
- `ambiguous` verdict from the built-in shows the type 1 questions; a passing verdict shows none (Task 1).
- Bad input: `probes` as a bare string, an empty list, 8 items, a blank string, a 301-character string, or a `use:` override that is a list or has an unknown key such as `ambiguous` (Task 2).

---

### Task 1: Built-in probes and the `Judgement.probes` hook

**Files:**
- Modify: `src/types.ts` (the `Judgement` interface)
- Modify: `src/judgements/one-way-door.ts`
- Modify: `src/judgements/registry.ts`
- Test: `test/judgements.test.ts`

**Interfaces:**
- Produces:
  - In `src/types.ts`, on `Judgement`: `probes?(v: JudgementVerdict): string[];`
  - In `src/judgements/one-way-door.ts`:
    - `export interface OneWayDoorProbes { type1?: string[]; type2?: string[] }`
    - `export const DEFAULT_PROBES: { type1: string[]; type2: string[] }`
    - `OneWayDoorOptions.probes?: OneWayDoorProbes`
  - In `src/judgements/registry.ts`: `BuiltinOverrides.probes?: OneWayDoorProbes`, passed through to `oneWayDoor`.

- [ ] **Step 1: Write the failing tests** in `test/judgements.test.ts`, as a new `describe("one-way-door probes", ...)`. Import `DEFAULT_PROBES`. Add a `noPlan` fixture: `answers({ one: 0.02, add: 0.9, rev: 0.3, cls: "TYPE_2_TWO_WAY_DOOR", conf: 0.9 })`. Tests:
  - `type1_no_adr` verdict: `j.probes!(v)` equals `DEFAULT_PROBES.type1`, and that list has length 5.
  - `type2_no_plan` verdict (from `noPlan`): equals `DEFAULT_PROBES.type2`, length 3.
  - `ambiguous` verdict (low-confidence answers from the existing test): equals `DEFAULT_PROBES.type1`.
  - A passing verdict (`type2`): `[]`.
  - `oneWayDoor({ probes: { type2: ["Custom?"] } })`: type 2 verdict gives `["Custom?"]`; type 1 verdict still gives `DEFAULT_PROBES.type1`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/judgements.test.ts`
Expected: FAIL (`DEFAULT_PROBES` not exported / `probes` undefined).

- [ ] **Step 3: Implement.**
  - Add `probes?(v: JudgementVerdict): string[];` to `Judgement` with a one-line doc comment ("Questions a reviewer will ask for this verdict; authored, static, may be empty").
  - In `one-way-door.ts` define `DEFAULT_PROBES` with exactly these strings:
    - `type1`:
      1. `What else reads or writes this: other services, jobs, reports, exports? How do you know?`
      2. `What breaks while old and new code run side by side during the rollout?`
      3. `If you revert, what survives? If data is lost, how do you get it back and how long does that take?`
      4. `What tells you within the first hour that this was wrong, and who is watching?`
      5. `Could this be split into steps that are each reversible? If not, why not?`
    - `type2`:
      1. `What signal tells you to roll back, and who watches it?`
      2. `What does the flag or config default to, and what happens if it flips unexpectedly?`
      3. `Does anything written by the new code outlive a rollback?`
  - `oneWayDoor` merges `opts.probes` over `DEFAULT_PROBES` and returns a `probes(v)` that switches on `v.reason`: `type1_no_adr` and `ambiguous` give the type 1 list, `type2_no_plan` gives the type 2 list, anything else `[]`.
  - In `registry.ts`, add `probes?: OneWayDoorProbes` to `BuiltinOverrides` and pass `overrides.probes` to `oneWayDoor`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/judgements.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/judgements/one-way-door.ts src/judgements/registry.ts test/judgements.test.ts
git commit -m "feat: built-in probing questions for one-way-door"
```

---

### Task 2: `probes` in YAML (declarative and built-in override)

**Files:**
- Modify: `src/judgements/declarative.ts`
- Modify: `src/config.ts`
- Modify: `examples/judgement-gate.yml`
- Modify: `docs/configuration.md`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `OneWayDoorProbes` and `BuiltinOverrides.probes` from Task 1.
- Produces:
  - `DeclarativeSpec.probes?: string[]`; `compileDeclarative` returns a `Judgement` whose `probes()` gives `spec.probes ?? []`.
  - In `src/config.ts` (internal): `probeList(v: unknown, where: string, label: string): string[] | undefined` and `builtinProbes(v: unknown, where: string): OneWayDoorProbes | undefined`.
  - YAML: declarative judgements accept `probes: [string, ...]`; `use: one-way-door` accepts `probes: { type1?: [...], type2?: [...] }`.

- [ ] **Step 1: Write the failing tests** in `test/config.test.ts`:
  - Valid: `decl({ probes: ["Who else calls this?", "How would we know?"] })` parses, and the judgement's `probes!({ conclusion: "failure", reason: "x_unsatisfied", summary: "s" })` equals that list.
  - Valid: `decl()` (no probes) gives `[]`.
  - Valid: `use: one-way-door` with `probes: { type1: ["Custom type 1?"] }` returns `["Custom type 1?"]` for a `type1_no_adr` verdict and `DEFAULT_PROBES.type2` for a `type2_no_plan` verdict.
  - Invalid (extend the existing `cases` table, each must throw `ConfigError`): `probes` as a bare string; `probes: []`; 8 items; a `""` item; a `"   "` item; a 301-character item; a number item; `use` with `probes` as a list; `use` with `probes: { ambiguous: ["x"] }`; `use` with `probes: { type1: [] }`.
  - One message check: `decl({ probes: "nope" })` throws matching `/x.*probes/`.
  - Shipped example: the `public-api-contract` judgement from `examples/judgement-gate.yml` has at least 2 probes.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL (unknown key `probes`).

- [ ] **Step 3: Implement.**
  - `declarative.ts`: add `probes?: string[]` to `DeclarativeSpec`; add `probes: () => spec.probes ?? []` to the compiled judgement.
  - `config.ts`: add `MAX_PROBES = 7` and `MAX_PROBE_LENGTH = 300`. `probeList` returns `undefined` for `undefined`, otherwise requires a non-empty array of at most `MAX_PROBES` strings, each trimmed non-empty and at most `MAX_PROBE_LENGTH`, and returns them trimmed; on failure throws `ConfigError` with `${where}: "${label}" ...` in the existing message style. Add `"probes"` to `DECLARATIVE_KEYS` and `USE_KEYS`. `declarative()` sets `probes: probeList(o.probes, where, "probes")`. `builtinProbes` requires a mapping whose keys are only `type1` and `type2`, each passed through `probeList`. In the `use` branch pass `probes: builtinProbes(entry.probes, where)` in the overrides object to `builtinById`.
  - `examples/judgement-gate.yml`: add two `probes` to `public-api-contract` (for example `Which consumers call the changed endpoint or field, and how do you know?` and `What do they see during the rollout window, with old and new versions side by side?`). Add a commented-out `probes:` override under `use: one-way-door` showing `type1` and `type2`.
  - `docs/configuration.md`: add a `probes` row to the key table (declarative: list of questions; `use: one-way-door`: mapping with `type1` and `type2`; limits 7 items, 300 characters; shown as "Questions a reviewer will ask"), and a sentence that the built-in ships defaults for type 1 and type 2, and that an ambiguous verdict shows the type 1 list.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/config.test.ts test/judgements.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/judgements/declarative.ts src/config.ts examples/judgement-gate.yml docs/configuration.md test/config.test.ts
git commit -m "feat: probes key for declarative and built-in judgements"
```

---

### Task 3: Render probes in the comment and agent block

**Files:**
- Modify: `src/comment.ts`
- Modify: `docs/agents.md`
- Modify: `README.md` (one sentence in the Judgements section)
- Test: `test/agent-block.test.ts`

**Interfaces:**
- Consumes: `Judgement.probes?(v)` from Task 1.
- Produces: in the comment, after the Fix and before the signals line, when probes are non-empty: a line `**Questions a reviewer will ask:**`, a blank line, then one `- <probe>` line per probe. In the agent block, each `failing[]` entry gets `probes: string[]` (`[]` when none).

- [ ] **Step 1: Write the failing tests** in `test/agent-block.test.ts` (reuse `parseBlock`, `failing`, `rc`):
  - `one-way-door` type 1 failure: the comment contains `**Questions a reviewer will ask:**` and `- ${DEFAULT_PROBES.type1[0]}`; the block's `failing[0].probes` equals `DEFAULT_PROBES.type1`. The questions appear after `**Fix:**` and before `<sub>Signals` (compare `indexOf`).
  - A declarative judgement with no probes: the comment does not contain `Questions a reviewer will ask`, and `failing[0].probes` equals `[]`.
  - Hostile probe (`"why --> <script>"`): the block line still has `-->` only at its end, and `parseBlock(md).data.failing[0].probes[0]` equals the original string.
  - Two failing judgements (`one-way-door` type 1 and a declarative one with a distinct probe): each probe appears in the comment after its own `#### <name>` heading and before the next heading; block entries each carry their own list.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/agent-block.test.ts`
Expected: FAIL (no heading, no `probes` field).

- [ ] **Step 3: Implement** in `src/comment.ts`: in `renderComment`, after the Fix part, compute `const probes = judgement.probes?.(verdict) ?? []` and, when non-empty, push the heading and bullet lines described above. In `agentBlock`, add `probes: judgement.probes?.(verdict) ?? []` to each failing entry. Update `docs/agents.md`: add a `failing[].probes` row ("Questions the author should answer in the ADR or PR description; authored text, never PR content; may be empty") and a step 2 note in "How an agent should react" that the agent should address each probe in the ADR or plan it writes, with real content. Add one sentence to the README Judgements section that a judgement can carry questions a reviewer will ask, and that the built-in ships defaults.

- [ ] **Step 4: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (existing tests unchanged), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/comment.ts docs/agents.md README.md test/agent-block.test.ts
git commit -m "feat: show probing questions in the comment and agent block"
```

---

## Self-review notes

- Spec coverage: pluggable probes in YAML (Task 2); built-in defaults per reason and YAML override (Tasks 1, 2); shown in the comment (Task 3); in the agent block, additive with schema 1 (Task 3); validation limits and unknown keys stay errors (Task 2); no model call (nothing added); docs and example (Tasks 2, 3).
- Names used across tasks: `probes`, `DEFAULT_PROBES`, `OneWayDoorProbes`, `probeList`, `builtinProbes`, `BuiltinOverrides.probes`, `DeclarativeSpec.probes`, heading text `**Questions a reviewer will ask:**`.
- Not in this plan by design: severity (step 2), grounding in the diff (step 1b), routing (step 3), any check that an ADR answers the probes (known gap in the spec).
