// Demo PR scenarios shared by the mock GitHub server and the webhook simulator.
const PLAN = "Reversal Trigger: error rate > 2% for 5 min.\nRollback Path: set flag NEW_SEARCH=off or revert this PR.";
export const SCENARIOS = {
  1: {
    title: "Drop legacy users.email column",
    body: "Cleanup.",
    files: [{ filename: "migrations/0042_drop_email.sql", status: "added", patch: "@@\n+ALTER TABLE users DROP COLUMN email;" }],
  },
  2: {
    title: "Drop legacy users.email column (with ADR)",
    body: "Cleanup. See ADR.",
    files: [
      { filename: "migrations/0042_drop_email.sql", status: "added", patch: "@@\n+ALTER TABLE users DROP COLUMN email;" },
      { filename: "docs/decisions/0042-drop-email.md", status: "added", patch: "@@\n+# Drop email\n+Decision: ..." },
    ],
  },
  3: {
    title: "Add behind-a-flag search suggestions",
    body: "Adds suggestions UI.\n\n" + PLAN,
    files: [{ filename: "src/search/suggest.ts", status: "added", patch: "@@\n+if (flags.NEW_SEARCH) renderSuggestions();" }],
  },
  4: {
    title: "Add behind-a-flag search suggestions",
    body: "Adds suggestions UI.",
    files: [{ filename: "src/search/suggest.ts", status: "added", patch: "@@\n+if (flags.NEW_SEARCH) renderSuggestions();" }],
  },
};

