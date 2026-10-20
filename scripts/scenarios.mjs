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
  // 5 and 6 need the example org config (examples/judgement-gate.yml), which the mock serves by default.
  5: {
    title: "Rename user.name to user.fullName in the API",
    body: "Cleaner naming.",
    files: [{ filename: "services/api/v1/users.ts", status: "modified", patch: "@@\n-  name: string;\n+  fullName: string;" }],
  },
  6: {
    title: "Rename user.name to user.fullName in the API (with plan)",
    body: "Cleaner naming.\n\nMigration Plan: serve both fields for one release, then remove name.",
    files: [{ filename: "services/api/v1/users.ts", status: "modified", patch: "@@\n-  name: string;\n+  fullName: string;" }],
  },
  // Severity (examples/judgement-gate.yml) is a classifier: it labels the PR and never fails the check.
  // It applies to anything under services/**, so 5 and 6 show a Severity line too. 7 is a reversible change to a sensitive path.
  7: {
    title: "Retry failed card charges once in checkout",
    body: "Retries a declined charge once.\n\n" + PLAN,
    files: [
      {
        filename: "services/checkout/charge.ts",
        status: "modified",
        patch: "@@\n-  return charge(card);\n+  return flags.RETRY_CHARGE ? retryOnce(() => charge(card)) : charge(card);",
      },
    ],
  },
};

