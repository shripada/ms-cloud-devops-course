# Lab Workshop: Containerizing and Shipping a Full-Stack App

**Duration:** 3 hours. **Working mode:** pairs. One of you owns the backend, the other owns the frontend, and you swap for the Compose block.

The app is already built and lives in one repository, with `backend/` and `frontend/` beside each other: <https://github.com/shripada/ms-cloud-devops-labs>. You won't write app code today. The job is to package it, run it, test it, and set up a pipeline that checks it automatically.

## Before you start

Make sure these work on your machine:

- `docker --version` and `docker run hello-world`
- `node --version` (use the version listed in the repo README)
- `git --version`, and you can log in to GitHub
- Pre-pull the base images so you're not waiting on the network later: `docker pull node:20-alpine` and `docker pull nginx:alpine`

## 0:00-0:15 Run the app without Docker

Clone the repo. In `backend/` and then in `frontend/`, copy `.env.example` to `.env`, run `npm ci`, then `npm run dev` — two terminals. Open <http://localhost:5173> and confirm the header says the API is healthy.

Write down three things, because you'll need them all day:

1. The Node version each repo expects
2. The environment variables each one needs
3. The port each one listens on

Checkpoint: you can create or view data in the running app.

## 0:15-0:50 Backend Dockerfile, first attempt

Stop the dev server. In the backend repo, create a file named `Dockerfile` and start with the simplest thing that works:

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Build it, run it, and hit the health endpoint:

```bash
docker build -t backend:v1 .
docker run --rm -p 3000:3000 backend:v1
curl localhost:3000/health
```

Here is what each instruction does:

- `FROM` picks the base image everything else is layered on.
- `WORKDIR` sets the directory for every command after it.
- `COPY` moves files from your machine into the image.
- `RUN` executes a command at build time, and the result is saved into the image.
- `EXPOSE` documents the port. It doesn't publish anything; `-p` does that.
- `CMD` is the default command when the container starts. `ENTRYPOINT` is similar, but it's meant to be the fixed executable, with `CMD` supplying default arguments. For a Node app, `CMD` is usually enough.

Now measure two things and write them down:

- Image size: `docker images backend:v1`
- Rebuild time after changing one line in any source file. Edit a file, run `docker build` again, and time it.

You'll compare against these numbers in the next block.

## 0:50-1:20 Backend Dockerfile, better version

The first version is slow to rebuild and much larger than it needs to be. You'll fix that with five changes.

**1. Add a `.dockerignore`** so junk never enters the build:

```
node_modules
dist
.git
.env
*.log
```

**2. Order layers by how often they change.** Docker caches each layer and reuses it until something above it changes. Dependencies change rarely and your code changes constantly, so install dependencies first:

```dockerfile
COPY package*.json ./
RUN npm ci
COPY . .
```

`npm ci` installs exactly what the lockfile says, which is what you want in a build.

**3. Use a multi-stage build.** Compile TypeScript in one stage and ship only the output in another. The compiler and dev dependencies never reach the final image:

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The API writes notes into ./data. Root owns /app, so hand that one directory
# to the user we are about to become - otherwise the app exits at startup with
# EACCES, which is exactly what it is meant to do.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

**4. Run as a non-root user.** `USER node` means that if someone exploits the app, they don't get root inside the container.

**5. Add a `HEALTHCHECK`** so Docker can tell "the process is running" apart from "the app is actually answering".

Use `127.0.0.1`, not `localhost`, in the healthcheck. Inside the container `localhost` resolves to the IPv6 address `::1` first, the app listens on IPv4, and the check fails with "connection refused" while the app is perfectly fine. Your container sits there marked `unhealthy` and Compose refuses to start anything that depends on it. This one costs people an hour; spend the thirty seconds now.

Build it as `backend:v2` and compare against your v1 numbers. Change one line of source and rebuild. It should now take seconds, because the dependency layers come from cache. Run `docker ps` after a minute and look at the status column for `healthy`.

Checkpoint: the v2 image is far smaller than v1, and a code-only rebuild is fast.

## 1:20-1:35 Break

If your builds are still running, let them finish.

## 1:35-2:00 Frontend Dockerfile

Same idea, with one difference. A frontend is just static files once it's built, so you don't need Node at runtime. You need a web server.

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG API_URL
ENV VITE_API_URL=$API_URL
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
```

Two things to understand here:

- **Build-time vs runtime configuration.** The API URL gets baked into the JavaScript bundle when you run `npm run build`. Changing an environment variable on a running container won't change it. That's why it's an `ARG` passed with `docker build --build-arg API_URL=...`. Try building with a wrong URL and see what breaks in the browser.
- **SPA routing.** If a user refreshes on `/some/page`, nginx looks for a file with that name and returns a 404. Your `nginx.conf` needs a `try_files $uri /index.html;` rule so the app's router handles the path.

Checkpoint: the frontend loads from a container on port 8080 (`-p 8080:80`).

## 2:00-2:20 Docker Compose

Right now you're starting two containers by hand with long commands. Swap roles with your partner, then write a `docker-compose.yml` that starts both:

```yaml
services:
  backend:
    build: ./backend
    environment:
      PORT: 3000
      DATA_FILE: /app/data/notes.json
      CORS_ORIGIN: http://localhost:8080
    volumes:
      - notes-data:/app/data
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/health"]
      interval: 10s
      retries: 5

  frontend:
    build:
      context: ./frontend
      args:
        API_URL: http://localhost:3000
    ports:
      - "8080:80"
    depends_on:
      backend:
        condition: service_healthy

volumes:
  notes-data:
```

Set the variables here rather than with `env_file`, because `.env` is gitignored — your partner's checkout does not have one, and Compose fails outright when the file named in `env_file` is missing.

Run it with `docker compose up --build`.

Points to notice:

- Compose puts both services on one network, and each is reachable by its service name. Containers talk to each other as `backend:3000`, not `localhost`.
- The browser runs on your machine, not in a container, so the frontend's API URL still has to be something your browser can reach.
- `depends_on` with `service_healthy` waits for the backend's healthcheck to pass, not just for the container to start.
- The named volume is what keeps your notes. Create a note, then run `docker compose down` and `up` again — still there. Run `docker compose down -v` and they are gone. That single letter is the whole volumes lesson.

If you have time, add a `docker-compose.override.yml` with bind mounts so code edits show up without rebuilding.

Checkpoint: `docker compose up` brings up the whole app, and `docker compose down` cleans it up.

## 2:20-2:50 Automated checks with GitHub Actions

Everything you've run by hand can run automatically on every push. The rule is to have the pipeline run the same commands you'd run locally. If CI does something you can't reproduce on your laptop, you can't debug it.

Create `.github/workflows/ci.yml` in your repo:

```yaml
name: CI
on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run test:int

  docker:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t notes-backend:${{ github.sha }} ./backend
```

The order matters. Lint is fastest, so it fails first. Unit tests come next, then integration tests, which are slower because they exercise the real app. The Docker build only runs if all of that passes, because there's no point packaging code that's already broken. `needs: test` enforces that.

Now the exercise:

1. Push the workflow and watch the run in the **Actions** tab. It should be green.
2. Check out the `lab/ci-broken` branch. It has a lint error and a real bug planted in it. Push it and watch the pipeline go red. Open the failed step and read the log — notice that lint fails first, and the Docker build never even starts.
3. Fix it, push again, and confirm it goes green.
4. Add one small test of your own.

If you finish early, push the built image to GitHub Container Registry (GHCR) at the end of the pipeline.

## 2:50-3:00 Wrap-up

Before you leave, you should be able to answer these without looking:

- Why does the order of `COPY` and `RUN` lines change build speed?
- What does a multi-stage build remove from the final image?
- Why can't you change the frontend's API URL on a running container?
- Why does the pipeline run lint before the Docker build?

**Common mistakes:**

- Forgetting `.dockerignore`, so `node_modules` gets copied in and overwrites the clean install
- Using `localhost` between containers instead of the service name, or `localhost` in a healthcheck where `127.0.0.1` is meant
- Using `npm install` where `npm ci` belongs
- Committing `.env` files
- Tagging everything `latest`, so you can't tell which build is which

**Take-home tasks:**

1. Add a Postgres service to your Compose file with a named volume and see what happens to your data on `docker compose down` vs `down -v`.
2. Scan your image with `docker scout quickview` or Trivy and read what it reports.
3. Tag images with the git commit SHA and push them to GHCR from the pipeline.

If you fall behind at any point, ask for the checkpoint branch for the next stage and keep going. Reading a working version and comparing it to yours is a legitimate way to learn.
