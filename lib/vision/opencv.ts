/**
 * OpenCV.js (WASM) loader + small lifetime helpers.
 *
 * `@techstark/opencv-js` is typed as the `cv` namespace, but at runtime its
 * CommonJS `module.exports` *is a Promise* that resolves once the WASM runtime
 * has initialised (older builds instead expose an `onRuntimeInitialized`
 * hook). Both shapes are handled here so nothing else in the codebase has to.
 *
 * It is loaded through `createRequire` rather than a static `import`. A CJS
 * module whose exports object is a Promise makes the ESM namespace object
 * itself *thenable*, and any loader that awaits the namespace — Vite's SSR
 * transform does, which is what vitest runs under — then calls
 * `Promise.prototype.then` with a Module as the receiver and throws
 * `called on incompatible receiver [object Module]` before a single line of
 * our code executes. Going through `require` sidesteps that interop entirely
 * and hands back the Promise directly. This module is server-only either way:
 * the pipeline runs in the Node runtime (see `app/api/recognize/route.ts`).
 *
 * The resolved module is cached at module scope, which on Vercel means one
 * WASM instantiation per warm serverless container rather than per request —
 * the same reasoning as the Mongoose connection cache in `lib/db/mongo.ts`.
 */

import { createRequire } from 'node:module';
import type * as CvNamespace from '@techstark/opencv-js';

export type CV = typeof CvNamespace;

interface LegacyRuntimeHook {
  Mat?: unknown;
  onRuntimeInitialized?: () => void;
}

let cvPromise: Promise<CV> | null = null;

/**
 * Resolve the initialised OpenCV.js namespace. Safe to call concurrently and
 * repeatedly; the WASM module is instantiated at most once per process.
 */
export function loadOpenCv(): Promise<CV> {
  if (!cvPromise) {
    cvPromise = resolveRuntime(requireOpenCv()).catch((err: unknown) => {
      // Let a later request retry rather than caching a permanently failed init.
      cvPromise = null;
      throw err;
    });
  }
  return cvPromise;
}

function requireOpenCv(): unknown {
  const require = createRequire(import.meta.url);
  return require('@techstark/opencv-js');
}

async function resolveRuntime(raw: unknown): Promise<CV> {
  if (raw instanceof Promise) {
    return (await raw) as CV;
  }
  const candidate = raw as LegacyRuntimeHook;
  if (candidate?.Mat) {
    return raw as CV;
  }
  return new Promise<CV>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('OpenCV.js did not finish initialising within 30s')),
      30_000
    );
    candidate.onRuntimeInitialized = () => {
      clearTimeout(timer);
      resolve(raw as CV);
    };
  });
}

/**
 * Anything with a `delete()` method. OpenCV.js allocates inside the WASM heap,
 * which the JS garbage collector knows nothing about — every `Mat`,
 * `MatVector` and `RotatedRect` must be released explicitly or a warm
 * serverless container leaks a few megabytes per request until it OOMs.
 */
export interface CvDeletable {
  delete(): void;
}

/**
 * Track OpenCV allocations and release them all, even on the error path.
 *
 * Usage:
 * ```ts
 * const scope = new CvScope();
 * try {
 *   const gray = scope.track(new cv.Mat());
 *   ...
 * } finally {
 *   scope.dispose();
 * }
 * ```
 */
export class CvScope {
  private readonly tracked: CvDeletable[] = [];

  track<T extends CvDeletable>(value: T): T {
    this.tracked.push(value);
    return value;
  }

  dispose(): void {
    // Reverse order so derived Mats go before the buffers they were built from.
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      try {
        this.tracked[i].delete();
      } catch {
        // A double-delete must not mask the real error that led us here.
      }
    }
    this.tracked.length = 0;
  }
}
