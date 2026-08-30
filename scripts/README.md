# scripts

Standalone Node/TS scripts, run outside the Next.js request lifecycle.

Planned per plan Phase 1 step 7 / Phase 5:

- Geometric-gate test harness — takes a set of test photos + their ground-truth ball/table coordinates (human-provided, see plan Phase 5), runs `lib/vision` recognition on each, computes mm error (RMS) against ground truth, and generates a pass/fail report against the accuracy threshold (e.g. ≤8mm RMS).
- `diagnose-recognition.ts` — runs one real photo through every `recognize()` stage individually (decode → segment → table boundary → pose → ball blobs → colour → confidence) and logs each stage's intermediate result, so a bad photo can be pinned to *which* stage went wrong instead of only seeing the pipeline's final thrown error. `npx tsx scripts/diagnose-recognition.ts <photo-path> [대대|중대] [white|yellow]`. Real photos that have previously exposed a bug this way live in `scripts/fixtures/photos/` (see `lib/vision/realPhotos.test.ts` for the regression tests built from them).
- `visualize-boundary.ts` — draws `detectTableBoundary`'s fitted quad onto the photo as a PNG. The per-stage *numbers* `diagnose-recognition.ts` prints can all look individually unremarkable (a few px of RMS, a plausible point count) while a corner is still extrapolated far outside the real table — seeing the quad drawn on the photo is what actually catches that. `npx tsx scripts/visualize-boundary.ts <photo-path> [out-path] [대대|중대]`.
- Serverless execution-time measurement harness — measures `lib/vision` + `lib/pathcalc` wall-clock time against Vercel's function timeout budget.

Run scripts with `npx tsx scripts/<name>.ts` (add `tsx` as a devDependency when the first script lands) or add a dedicated npm script once the harness exists.
