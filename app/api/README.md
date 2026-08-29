# app/api

Next.js API routes (Vercel serverless functions).

Planned routes per plan Phase 1/2/4 (not yet created by scaffolding — build them here):

- `recognize/route.ts` — accepts an uploaded photo, runs `lib/vision` recognition, returns a `RecognitionResult`
- `settings/route.ts` — GET/PUT the user's `Settings` (cue ball color, table size), persisted via `lib/db/mongo.ts` + a Mongoose `Settings` model (not created yet — next wave's job)

Every route should call `connectToDatabase()` from `lib/db/mongo.ts` before touching the DB, and validate/shape request and response bodies against the types in `lib/types.ts`.
