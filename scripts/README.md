# scripts

Standalone Node/TS scripts, run outside the Next.js request lifecycle.

Planned per plan Phase 1 step 7 / Phase 5:

- Geometric-gate test harness — takes a set of test photos + their ground-truth ball/table coordinates (human-provided, see plan Phase 5), runs `lib/vision` recognition on each, computes mm error (RMS) against ground truth, and generates a pass/fail report against the accuracy threshold (e.g. ≤8mm RMS).
- Serverless execution-time measurement harness — measures `lib/vision` + `lib/pathcalc` wall-clock time against Vercel's function timeout budget.

Run scripts with `npx tsx scripts/<name>.ts` (add `tsx` as a devDependency when the first script lands) or add a dedicated npm script once the harness exists.
