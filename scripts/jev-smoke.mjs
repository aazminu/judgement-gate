// Live check of the Jev contract through OpenRouter. Usage: node scripts/jev-smoke.mjs
const key = process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY;
if (!key) throw new Error("set OPENROUTER_API_KEY");
const t0 = Date.now();
const res = await fetch("https://openrouter.ai/api/alpha/decisions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "typesafe/jev-1.14",
    state: {
      title: "Drop legacy users.email column",
      files: ["migrations/0042_drop_email.sql"],
      patch: "ALTER TABLE users DROP COLUMN email;",
    },
    questions: {
      is_one_way: {
        type: "noul",
        instructions: "Does this change irreversibly mutate persistent data or schema?",
        criteria: { true: "drops/rewrites schema or data", false: "no persistent mutation" },
      },
      kind: {
        type: "choice",
        instructions: "Is this a one-way or two-way door change?",
        criteria: { TYPE_1_ONE_WAY_DOOR: "hard to reverse", TYPE_2_TWO_WAY_DOOR: "easy to reverse" },
      },
    },
  }),
});
console.log(res.status, `${Date.now() - t0}ms`);
console.log(JSON.stringify(await res.json(), null, 2));
