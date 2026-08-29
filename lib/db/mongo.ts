/**
 * Serverless-friendly cached MongoDB (Mongoose) connection.
 *
 * Vercel serverless functions can spin up many concurrent instances, each
 * with its own module scope but a shared warm container across invocations.
 * Without caching, every cold start (and in the worst case every invocation)
 * would open a brand-new connection to MongoDB Atlas, exhausting the
 * cluster's connection pool. This uses the standard "cache the connection
 * promise on a global" pattern recommended by Vercel/MongoDB for Next.js
 * API routes so repeated `connectToDatabase()` calls within the same warm
 * container reuse one connection.
 *
 * See plan Risk "MongoDB 서버리스 연결 오버헤드".
 *
 * This module only manages the raw connection. Mongoose models (e.g. the
 * Settings model) are intentionally NOT defined here — that's the next
 * wave's responsibility, so it can own its own schema file(s) without
 * touching this one.
 */

import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

// Reuse the connection across hot invocations in the same serverless
// container by stashing it on `global`. Module-level `let` is not enough
// because bundlers/dev-mode hot-reload can re-evaluate this module while
// the underlying Node process (and its open sockets) persists.
declare global {
  var __danggu_mongoose_cache: MongooseCache | undefined;
}

const cache: MongooseCache = global.__danggu_mongoose_cache ?? { conn: null, promise: null };
global.__danggu_mongoose_cache = cache;

/**
 * Connect to MongoDB Atlas, reusing an existing connection/in-flight
 * connection attempt when one is already cached. Call this at the top of
 * every API route handler that touches the database.
 *
 * @throws if `MONGODB_URI` is not set in the environment (see `.env.local.example`).
 */
export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) {
    return cache.conn;
  }

  if (!MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Copy .env.local.example to .env.local and fill in your ' +
        'MongoDB Atlas connection string.'
    );
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        // Fail fast instead of buffering indefinitely if the DB is unreachable —
        // clearer errors in a serverless function than a silent timeout.
        bufferCommands: false,
      })
      .then((m) => m);
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    // Reset the cached promise so the next invocation retries instead of
    // permanently reusing a failed connection attempt.
    cache.promise = null;
    throw err;
  }

  return cache.conn;
}
