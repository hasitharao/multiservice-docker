> Solution for the [roadmap.sh Multi-Service Docker project](https://roadmap.sh/projects/multiservice-docker).

# Multi-service Docker app

A small "notes" application that runs as **five containers** and demonstrates a production-style Docker setup: Compose, custom base images, multi-stage builds, networks, volumes, secrets, health checks and log rotation.

```
                          ┌─────────────────────── frontend network ───────────────────────┐
 Browser ──► :8080 ──►  proxy (nginx) ──┬──► web   (nginx + React build, port 8080)         │
                          │             └──► api   (Node.js + Express, port 3000) ──┐       │
                          └─────────────────────────────────────────────────────────┼───────┘
                                                                                    │
                          ┌──────────── backend network (internal, no internet) ────┼───────┐
                          │                          api ◄──────────────────────────┘       │
                          │                           ├──► mongo (MongoDB 8, volume)        │
                          │                           └──► redis (Redis 7, volume)          │
                          └─────────────────────────────────────────────────────────────────┘
```

Only the **proxy** is published to your machine. MongoDB and Redis can't be reached from outside Docker at all.

What the app does: you save notes (stored in **MongoDB**), the list is cached for 30 seconds in **Redis**, and a page-load counter lives in Redis. The UI tells you whether a list came from the cache or the database.

---

## Prerequisites

- Docker Desktop (or Docker Engine) with **Docker Compose v2** — check with `docker compose version`
- Optional: `make` (Linux/macOS/WSL). Every Makefile target is just a normal docker command, listed below.

## Quick start

**1. Create the secrets** (random passwords, stored in `./secrets/`, never committed):

```bash
sh scripts/generate-secrets.sh
```

<details><summary>Windows PowerShell version</summary>

```powershell
New-Item -ItemType Directory -Force secrets | Out-Null
foreach ($n in 'mongo_root_password','redis_password') {
  -join (1..48 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) | Set-Content -NoNewline "secrets/$n.txt"
}
```
</details>

**2. Build the two custom base images** (once; see "Why build base images first?" below):

```bash
docker compose --profile base build api-base web-base
```

**3. Build the app images and start everything:**

```bash
docker compose up -d --build
```

Open **http://localhost:8080**. The first start takes a minute because MongoDB initialises itself; watch the containers become healthy with `docker compose ps`.

> Shortcut for all three steps: `make up`

---

## Try it: a checklist that proves each feature works

| What to check | Command | Expected |
|---|---|---|
| Health checks | `docker compose ps` | every service shows `(healthy)` |
| API through the proxy | `curl localhost:8080/api/health` | `{"status":"ok","mongo":"up","redis":"up"}` |
| Caching | Reload the page twice | 1st list: "read from MongoDB", then "from the Redis cache" |
| Persistence | Add a note, run `docker compose down`, then `docker compose up -d` | the note is still there (volumes survived) |
| Secrets are not in env vars | `docker compose exec api env \| grep -i pass` | only `*_FILE` paths, no passwords |
| Secrets are files | `docker compose exec api ls /run/secrets` | `mongo_root_password  redis_password` |
| Network isolation | `docker compose exec proxy wget -T2 -qO- mongo:27017` | fails: proxy isn't on the backend network |
| Not exposed to host | `docker compose ps` | only `proxy` has a `0.0.0.0:8080->80` mapping |
| Log rotation config | `docker inspect multiservice-api-1 --format '{{json .HostConfig.LogConfig}}'` | `max-size 10m`, `max-file 3` |
| Self-healing view | `docker compose stop redis`, wait ~45s, `docker compose ps` | `api` turns `unhealthy`; the UI shows Redis down. `docker compose start redis` recovers it |
| Image sizes | `docker images \| grep multiservice` | `multiservice/web` is small: it holds only nginx + static files |

---

## Where each requirement is implemented

| Requirement | Where |
|---|---|
| Docker Compose | `docker-compose.yml` |
| React web app | `web/` (Vite + React) |
| Node/Express API | `api/src/index.js` |
| MongoDB / Redis | `mongo` and `redis` services in `docker-compose.yml` |
| Nginx reverse proxy | `nginx/default.conf` + `proxy` service |
| Custom base images | `base-images/api/Dockerfile`, `base-images/web/Dockerfile` |
| Multi-stage builds | `web/Dockerfile` (3 stages), `api/Dockerfile` (2 stages) |
| Network | `frontend` + `backend` (`internal: true`) at the bottom of the compose file |
| Volumes | `mongo_data`, `mongo_config`, `redis_data` |
| Secrets | `secrets:` blocks in compose; read as files at `/run/secrets/*` |
| Health checks | compose for mongo/redis/proxy; the Dockerfile for web/api |
| Image optimisation | see below |
| Logging + rotation | `x-logging` anchor in compose (json-file, 10 MB × 3 files, compressed); apps log to stdout |

## Concepts, briefly

**Why build base images first?** A base image is a shared starting point (`FROM multiservice/api-base:1.0`). Compose can't know that `api` needs it built before `api` itself, so step 2 builds the bases and tags them locally. In a real company you'd push them to a registry once and everyone would just pull them. The `api-base` adds `tini` (a proper init process so `docker stop` shuts the app down cleanly) and sets production defaults. The `web-base` is a **non-root** nginx already tuned for single-page apps (gzip, long-lived caching for hashed files, security headers).

**Two networks.** `frontend` connects proxy ↔ web ↔ api. `backend` connects api ↔ mongo ↔ redis and is `internal: true`, which cuts it off from the internet. The API is the only service on both, so it's the only bridge to the data layer.

**Secrets.** Passwords live in `secrets/*.txt` and are mounted into containers as files. MongoDB reads its password natively through `MONGO_INITDB_ROOT_PASSWORD_FILE`; the API reads the file at startup; Redis gets its password from the file inside its start command. Passwords never appear in the compose file, the images, or `docker inspect`.

**Health checks + `depends_on`.** `depends_on: condition: service_healthy` makes Compose wait until a dependency passes its check, so the start order is mongo/redis → api → web → proxy. The API's `/api/health` really pings MongoDB and Redis, so "healthy" means "actually working".

**Dockerfile optimisations used**
- Copy `package*.json` first, then `npm ci`, then source → the slow install layer is cached until dependencies change.
- Multi-stage: the web image contains nginx and static files only (no Node, no `node_modules`, no source); the API image has production dependencies only (`--omit=dev`).
- Alpine base images, `--no-cache` for apk, BuildKit cache mount for npm downloads.
- `.dockerignore` keeps `node_modules`, `.git` and secrets out of the build context.
- Non-root users everywhere the image allows it; `no-new-privileges` on custom services.
- No `curl` needed in the API image: its health check uses Node's built-in `fetch`.

---

## Everyday commands

```bash
docker compose ps                      # status + health
docker compose logs -f api             # follow one service's logs
docker compose logs -f --tail=50       # all services
docker compose exec mongo mongosh -u admin -p "$(cat secrets/mongo_root_password.txt)" --authenticationDatabase admin
docker compose exec redis sh -c 'REDISCLI_AUTH="$(cat /run/secrets/redis_password)" redis-cli keys "*"'
docker compose up -d --build api       # rebuild + restart only the API after a code change
docker compose down                    # stop (data is kept)
docker compose down -v                 # stop AND delete data volumes
```

## Troubleshooting

- **`pull access denied for multiservice/api-base`** → you skipped step 2. Build the base images first.
- **Port 8080 already in use** → copy `.env.example` to `.env` and change `HTTP_PORT`.
- **Mongo "Authentication failed" after changing the password or user** → MongoDB only reads those on the *first* start with an empty volume. Run `docker compose down -v` (deletes data) and start again.
- **A service stays `unhealthy`** → `docker compose logs <service>`; on first start Mongo can need up to ~30 s.
- **`permission denied` on `/run/secrets/...` (Linux)** → `chmod 644 secrets/*.txt`.
- **Windows: scripts fail with `\r` errors** → keep `*.sh` files with LF line endings.

## Known limitations and ideas to go further

- The API connects to MongoDB as the **root** user to keep the project simple. A real setup would create an app-specific user with access to one database only (via an init script in `/docker-entrypoint-initdb.d`).
- Redis receives its password as a command-line argument, so it is visible to `ps` *inside* that container. A mounted config file avoids this.
- Add resource limits (`deploy.resources.limits`), `read_only: true` + `tmpfs` for stateless services, and image scanning (`docker scout cves multiservice/api:1.0` or Trivy).
- Add HTTPS to the proxy (Let's Encrypt / Caddy), a CI pipeline that builds and pushes images, and pin images by digest.
- Image versions (`node:24-alpine`, `mongo:8.0`, `redis:7.4-alpine`, `nginx:1.28-alpine`) are pinned on purpose; update them from time to time.

## Project layout

```
.
├── docker-compose.yml
├── .env.example
├── Makefile
├── base-images/
│   ├── api/Dockerfile            # custom Node base (tini, prod defaults)
│   └── web/                      # custom non-root nginx base for the SPA
├── api/                          # Express API (Dockerfile, package.json, src/)
├── web/                          # React app (Dockerfile, Vite, src/)
├── nginx/default.conf            # reverse proxy config
├── scripts/generate-secrets.sh
└── secrets/                      # generated passwords (git-ignored)
```
