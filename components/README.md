# components

React components (client-side UI).

Planned components per PRD / plan Phase 3-4:

- `PhotoUpload` — mobile browser camera/file capture (`<input type="file" capture>`)
- Recognition confirm/correction overlay — original photo + detected table/ball overlay, touch-based manual correction (fallback when `RecognitionResult.needsManualCorrection` is true)
- `ShotDiagram` — static reconstructed 2D diagram of table/balls/path (not a photo overlay)
- Shot candidate tab/swipe switcher (top 3 candidates, low-confidence visual distinction)
- `Settings` panel — cue ball color + table size (대대/중대) preset pickers

Consume the shared types from `lib/types.ts` for props (`Shot`, `Ball`, `TableGeometry`, `RecognitionResult`, `Settings`). Do not redefine those shapes here.
