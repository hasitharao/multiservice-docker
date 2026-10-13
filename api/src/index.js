import fs from 'node:fs';
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import { createClient } from 'redis';

// ---------------------------------------------------------------------------
// Config. Secrets come from FILES (Docker secrets mounted in /run/secrets).
// For each secret we look for NAME_FILE first, then fall back to plain NAME,
// which is handy when running the API outside Docker.
// ---------------------------------------------------------------------------
function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name] ?? '';
}

const env = process.env;
const config = {
  port: Number(env.PORT ?? 3000),
  cacheTtlSeconds: Number(env.CACHE_TTL_SECONDS ?? 30),
  mongo: {
    host: env.MONGO_HOST ?? 'localhost',
    port: Number(env.MONGO_PORT ?? 27017),
    user: env.MONGO_USER ?? 'admin',
    password: readSecret('MONGO_PASSWORD'),
    dbName: env.MONGO_DB ?? 'appdb',
  },
  redis: {
    host: env.REDIS_HOST ?? 'localhost',
    port: Number(env.REDIS_PORT ?? 6379),
    password: readSecret('REDIS_PASSWORD') || undefined,
  },
};

// ---------------------------------------------------------------------------
// Logging: one JSON object per line on stdout. Docker collects stdout, and the
// json-file driver in docker-compose.yml rotates it.
// ---------------------------------------------------------------------------
function log(level, msg, extra = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' ? console.error : console.log)(line);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withRetry(name, fn, attempts = 10, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      log('warn', `${name} not ready (attempt ${attempt}/${attempts})`, { error: err.message });
      if (attempt === attempts) throw err;
      await sleep(delayMs);
    }
  }
}

// ---------------------------------------------------------------------------
// Connect to MongoDB and Redis
// ---------------------------------------------------------------------------
async function connectMongo() {
  const { host, port, user, password } = config.mongo;
  const client = new MongoClient(`mongodb://${host}:${port}`, {
    auth: { username: user, password },
    authSource: 'admin',
    serverSelectionTimeoutMS: 5000,
  });
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    return client;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

const mongoClient = await withRetry('mongo', connectMongo);
const db = mongoClient.db(config.mongo.dbName);
const notes = db.collection('notes');
log('info', 'connected to mongo');

const redis = createClient({
  socket: {
    host: config.redis.host,
    port: config.redis.port,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
  },
  password: config.redis.password,
});
redis.on('error', (err) => log('error', 'redis error', { error: err.message }));
await redis.connect();
log('info', 'connected to redis');

// Cache helpers: if Redis is down the API still works, just without the cache.
const NOTES_CACHE_KEY = 'notes:all';

async function cacheGet(key) {
  try {
    return await withTimeout(redis.get(key));
  } catch (err) {
    log('warn', 'cache read failed', { error: err.message });
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds) {
  try {
    await withTimeout(redis.set(key, value, { EX: ttlSeconds }));
  } catch (err) {
    log('warn', 'cache write failed', { error: err.message });
  }
}

async function cacheDel(key) {
  try {
    await withTimeout(redis.del(key));
  } catch (err) {
    log('warn', 'cache delete failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// Request log (the healthcheck is skipped so it doesn't flood the logs)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    const ms = Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    log('info', 'request', { method: req.method, path: req.originalUrl, status: res.statusCode, ms });
  });
  next();
});

// Health: used by the Docker HEALTHCHECK and shown in the UI.
app.get('/api/health', async (_req, res) => {
  const [mongoOk, redisOk] = await Promise.all([
    withTimeout(db.command({ ping: 1 })).then(() => true, () => false),
    withTimeout(redis.ping()).then(() => true, () => false),
  ]);
  const ok = mongoOk && redisOk;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    mongo: mongoOk ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
  });
});

// Visit counter: a classic Redis use case (atomic increment).
app.get('/api/visits', async (_req, res) => {
  const visits = await redis.incr('visits');
  res.json({ visits });
});

// List notes: cache-aside pattern.
//   1. look in Redis  2. on a miss, read MongoDB  3. store the result in Redis
app.get('/api/notes', async (_req, res) => {
  const cached = await cacheGet(NOTES_CACHE_KEY);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json({ source: 'cache', notes: JSON.parse(cached) });
  }

  const docs = await notes.find().sort({ createdAt: -1 }).limit(50).toArray();
  const payload = docs.map((d) => ({ id: d._id.toString(), text: d.text, createdAt: d.createdAt }));
  await cacheSet(NOTES_CACHE_KEY, JSON.stringify(payload), config.cacheTtlSeconds);

  res.set('X-Cache', 'MISS');
  res.json({ source: 'database', notes: payload });
});

// Create a note. Writes invalidate the cache so readers never see stale data.
app.post('/api/notes', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 200) {
    return res.status(400).json({ error: 'Note text must be between 1 and 200 characters.' });
  }
  const doc = { text, createdAt: new Date() };
  const { insertedId } = await notes.insertOne(doc);
  await cacheDel(NOTES_CACHE_KEY);
  res.status(201).json({ id: insertedId.toString(), text: doc.text, createdAt: doc.createdAt });
});

// Delete a note
app.delete('/api/notes/:id', async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid note id.' });
  }
  const { deletedCount } = await notes.deleteOne({ _id: new ObjectId(req.params.id) });
  if (!deletedCount) return res.status(404).json({ error: 'Note not found.' });
  await cacheDel(NOTES_CACHE_KEY);
  res.status(204).end();
});

// Unknown API routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Error handler (Express 5 forwards errors from async handlers automatically)
app.use((err, _req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (status >= 500) log('error', 'unhandled error', { error: err.message });
  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown (tini forwards SIGTERM from `docker stop`)
// ---------------------------------------------------------------------------
const server = app.listen(config.port, '0.0.0.0', () => {
  log('info', `API listening on port ${config.port}`);
});

async function shutdown(signal) {
  log('info', `${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref(); // hard stop if something hangs
  server.close(async () => {
    await Promise.allSettled([mongoClient.close(), redis.quit()]);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
