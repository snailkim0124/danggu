/**
 * Shared TypeScript contract for the 4구(사구) 당구 샷 경로 자동 안내 서비스.
 *
 * Every module (Vision Recognition, Path Calculation, Result Visualization,
 * Settings/API routes) codes against these types. Do not duplicate these
 * shapes locally — import from here.
 *
 * Source of truth: `.omc/plans/danggu-4gu-path-guide-plan.md`
 * ("Architecture / Data Model" section) and `docs/PRD.md` ("7. Ontology").
 */

// ---------------------------------------------------------------------------
// Table
// Plan section: "Architecture / Data Model" > Table
// ---------------------------------------------------------------------------

/**
 * The two standard 4구 table presets. Photos alone cannot recover absolute
 * real-world scale, so the user must pick one of these in Settings; the
 * known mm dimensions below are what the homography scale is anchored to.
 */
export type TableSize = '대대' | '중대';

/** Real-world mm dimensions (long side x short side) for each table preset. */
export const TABLE_DIMENSIONS_MM: Record<TableSize, { widthMm: number; heightMm: number }> = {
  대대: { widthMm: 2540, heightMm: 1270 },
  중대: { widthMm: 2438, heightMm: 1219 },
};

/** A 2D point. Unit depends on context (pixel space vs. mm space) — see the
 * specific type that embeds it (`TableDetection` vs. `TableGeometry`, `Ball.position`). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Raw vision-recognition output for the table boundary, in image pixel
 * coordinates, pre-homography. The 4 points are the **cushion nose line**
 * corners (where balls actually roll), not the outer rail corners — see
 * plan Table.boundary: computed as the intersection of the 4 cushion edge
 * lines so it survives corners being cropped out of frame.
 * Order: [topLeft, topRight, bottomRight, bottomLeft] (clockwise from the
 * camera's perspective, before rectification).
 */
export interface TableDetection {
  boundary: [Point, Point, Point, Point];
  size: TableSize;
}

/**
 * Table boundary in real-world mm coordinates, after homography rectification.
 * Origin and axes are up to the Path Calculation module's convention (e.g.
 * origin at one cushion-nose corner, x/y aligned to the table's long/short
 * sides) — document the chosen convention where this type is consumed.
 */
export interface TableGeometry {
  boundary: [Point, Point, Point, Point];
  size: TableSize;
}

/** @deprecated Use `TableDetection` (pixel space) or `TableGeometry` (mm space) explicitly. */
export interface Table {
  boundary: [Point, Point, Point, Point];
  size: TableSize;
}

// ---------------------------------------------------------------------------
// Ball
// Plan section: "Architecture / Data Model" > Ball
// ---------------------------------------------------------------------------

/** Physical ball color as printed on the ball. White/yellow are the two
 * possible cue balls (see `Settings.cueBallColor`); red1/red2 are the two
 * object balls (target balls), tracked separately since sequence/contact
 * order matters for rule validation. */
export type BallColor = 'white' | 'yellow' | 'red1' | 'red2';

/** Ball's functional role in the current shot, derived from `Settings.cueBallColor`:
 * - `cueBall`: the ball the player strikes (white or yellow, per user setting)
 * - `opponentBall`: the other of white/yellow (must NOT be contacted — foul)
 * - `targetBall`: either red ball (both must be contacted to score, per D2)
 */
export type BallRole = 'cueBall' | 'opponentBall' | 'targetBall';

export interface Ball {
  /** Stable identifier for this ball within a single `RecognitionResult`,
   * referenced by `Shot.sequence`. */
  id: string;
  color: BallColor;
  role: BallRole;
  /**
   * Real-world mm position on the table plane. This is the position AFTER
   * reprojecting from the z=0 cloth plane to the z=ball-radius plane — see
   * plan Risk "공 반지름 시차 미보정": using z=0 directly introduces up to
   * ~4.5° angle error for balls ~2m from the camera. Do not skip this
   * correction when producing `Ball.position` from vision output.
   */
  position: Point;
}

// ---------------------------------------------------------------------------
// Shot
// Plan section: "Architecture / Data Model" > Shot (확장)
// ---------------------------------------------------------------------------

/**
 * Shot technique category, also the primary sort key for `difficultyScore`
 * (direct < bank1 < bank2plus < bankShot — bankShot last: it's the one
 * technique everyone finds hard, cushion-count aside, per user feedback).
 *
 * Purely a function of the cue ball's cushion contacts — **not** of spin:
 * a shot struck with 끌어치기/밀어치기/회전 is still labelled by how many
 * cushions its path takes and when, exactly like a plain center-ball shot.
 * There is no separate "고급 기술샷(스핀)" tier — spin is a `tipOffset`
 * attribute of any shot (shown via the aim-point visual, not the technique
 * label) and a `SkillCategory` for the survey (`draw`/`follow`/`spin`), not
 * a technique of its own.
 *
 * `bank1`/`bank2plus` vs. `bankShot` distinguish shots by **when** the cushion
 * contact happens, not just how many: `bank1`/`bank2plus` are 큐볼 → 1적구 →
 * 쿠션(N회) → 2적구 — the cue ball hits an object ball *first*, then banks off
 * a cushion afterward (1쿠션 = 경로에 쿠션 1회, 2쿠션 이상 = 경로에 쿠션 2회+).
 * `bankShot` (뱅크샷/빈쿠션치기/가락) is 큐볼 → 쿠션(1회+) → 1적구 → 2적구 —
 * the cue ball hits a cushion *before touching any ball at all*. These read
 * very differently at the table (aiming at a cushion with no ball to
 * reference vs. banking off after a contact), so they get separate labels
 * rather than being folded into the same "N쿠션" bucket by cushion count
 * alone. See `lib/pathcalc/candidates.ts#classifyTechnique`.
 */
export type ShotTechnique = 'direct' | 'bank1' | 'bank2plus' | 'bankShot';

/** Discrete, human-reproducible force levels (1=softest, 5=hardest).
 * Continuous physical units (m/s) are deliberately NOT used — cushion
 * restitution and cloth friction can't be observed from a photo, so a
 * continuous number would be false precision. See plan Risk "힘(force) 물리
 * 예측 불가 변수 의존". Levels are meant to map to an observable/repeatable
 * cue like "쿠션 1개 돌 세기" .. "쿠션 3개 돌 세기". */
export type ForceLevel = 1 | 2 | 3 | 4 | 5;

export interface Shot {
  /** Stable identifier for this shot candidate within a `RecognitionResult`'s results. */
  id: string;
  technique: ShotTechnique;
  /** Aim point on the first object ball, expressed as a thickness fraction
   * (0 = thinnest/edge contact, 1 = full/center contact) — the primary,
   * "실전에서 바로 따라칠 수 있는" representation per PRD. */
  aimTarget: { thickness: number };
  /** Aim angle in degrees. Secondary/supporting display value alongside `aimTarget`. */
  angleDeg: number;
  forceLevel: ForceLevel;
  /**
   * Cue-tip strike offset (끌어치기/밀어치기/회전) — an attribute of the shot,
   * independent of `technique`. `{ vertical: 0, horizontal: 0 }` is a plain
   * center-ball hit; anything else is a spin shot, and `technique` is still
   * classified purely by its cushion contacts (see `ShotTechnique`'s doc) —
   * a spin shot that happens to need zero cushions is still `'direct'`.
   * Range convention: -1..1 on each axis (vertical: top/bottom, horizontal:
   * left/right spin), 0 = dead center.
   */
  tipOffset?: { vertical: number; horizontal: number };
  /** Ball ids (see `Ball.id`) in contact order, e.g. [cueBallId, redId1, redId2]. */
  sequence: string[];
  /**
   * Angular-tolerance based difficulty score: how much the aim angle can
   * vary and still succeed. Lower = harder (narrower tolerance window).
   * `technique` is the primary sort key when ranking candidates; this score
   * is the tie-break within the same technique (see PRD "기술 종류 우선순위").
   */
  difficultyScore: number;
  /**
   * Hard rule filter result: both red balls contacted AND the opponent ball
   * (white/yellow, whichever is not `cueBall`) never contacted AND the path
   * is not occluded by another ball. `false` candidates must be excluded
   * from results entirely, not just down-ranked (see plan Risk "후보 생성이
   * 파울 샷을 걸러내지 못함").
   */
  ruleValid: boolean;
  /**
   * Confidence in this specific shot recommendation, distinct from
   * `RecognitionResult.confidence` (which is about ball/table detection).
   * Should be pushed down when recognition error margins are large relative
   * to this shot's angular tolerance — a shot with a razor-thin tolerance
   * window is not trustworthy if ball positions themselves are uncertain.
   */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Settings
// Plan section: "Architecture / Data Model" (Settings persisted to MongoDB)
// ---------------------------------------------------------------------------

/**
 * Shot-technique categories the user self-rates comfort with, via the skill
 * survey. These are a *user-facing* vocabulary, not `ShotTechnique` — none of
 * them are technique tiers any more (see `ShotTechnique`'s doc: technique is
 * purely cushion-count based now). `draw`/`follow`/`spin` come from
 * `Shot.tipOffset`, `thinCut` from `aimTarget.thickness`, and `bank`/
 * `multiCushion` from `technique` (`bankShot`/`bank2plus` respectively). See
 * `lib/pathcalc/candidates.ts#classifySkillCategory` for the exact mapping
 * from a computed `Shot` back to one of these.
 */
export type SkillCategory = 'draw' | 'follow' | 'thinCut' | 'spin' | 'bank' | 'multiCushion';

/** Korean labels for the skill survey UI, in the order the survey presents them. */
export const SKILL_CATEGORY_LABEL: Record<SkillCategory, string> = {
  draw: '끌어치기',
  follow: '밀어치기',
  thinCut: '얇게치기',
  spin: '회전',
  bank: '뱅크샷',
  multiCushion: '3쿠션 이상',
};

export const SKILL_CATEGORIES: SkillCategory[] = [
  'draw',
  'follow',
  'thinCut',
  'spin',
  'bank',
  'multiCushion',
];

/** Self-rated comfort with a technique. `3` is the neutral default (no shift
 * in recommendation priority) — see `lib/pathcalc/candidates.ts`. */
export type SkillLevel = 1 | 2 | 3 | 4 | 5;

export type SkillProfile = Record<SkillCategory, SkillLevel>;

/** Neutral profile: every category at the midpoint, so personalization is a
 * true no-op until the user actually rates something. */
export const DEFAULT_SKILL_PROFILE: SkillProfile = {
  draw: 3,
  follow: 3,
  thinCut: 3,
  spin: 3,
  bank: 3,
  multiCushion: 3,
};

export interface Settings {
  /** Which physical ball color the user plays as the cue ball. Determines
   * `Ball.role` assignment for every recognition result. */
  cueBallColor: 'white' | 'yellow';
  /** Table size preset — needed to recover absolute mm scale from the photo
   * (see `TABLE_DIMENSIONS_MM`). */
  tableSize: TableSize;
  /**
   * Self-rated comfort per shot-technique category, from the skill survey.
   * Used by Path Calculation to re-prioritize which candidate is presented
   * first — a user who rates `bank` highly may see a bank shot ranked ahead
   * of a geometrically-easier-but-unfamiliar direct shot. Optional: absent
   * (or `DEFAULT_SKILL_PROFILE`, fully neutral) reproduces the original fixed
   * technique-hierarchy ranking exactly — see
   * `lib/pathcalc/candidates.ts#personalizedRank`. The live app's Settings
   * API always populates this (see `lib/db/models/Settings.ts`); it's
   * optional here so call sites that don't care about personalization (tests,
   * fixtures, the geometric-gate harness) aren't forced to specify it.
   */
  skillProfile?: SkillProfile;
}

// ---------------------------------------------------------------------------
// RecognitionResult
// Plan section: "Architecture / Data Model" > CalibrationConfidence
// ---------------------------------------------------------------------------

export interface RecognitionResult {
  table: TableGeometry;
  balls: Ball[];
  /**
   * Overall recognition confidence (0-1). When below the app's threshold,
   * the UI must branch to the photo-overlay manual-correction screen
   * (`needsManualCorrection`) instead of proceeding straight to results —
   * see plan "인식 확인 화면 분리" and Risk "인접 테이블/색상 오분류로 큐볼 스왑".
   */
  confidence: number;
  needsManualCorrection: boolean;
}
