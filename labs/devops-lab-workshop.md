# Lab Workshop: Containerizing and Shipping a Full-Stack App

**Duration:** 3 hours for the core lab, plus a 30-minute publishing extension. **Working mode:** pairs. One of you owns the backend, the other owns the frontend, and you swap for the Compose block.

The app is already built and lives in one repository, with `backend/` and `frontend/` beside each other: <https://github.com/shripada/ms-cloud-devops-labs>. You won't write app code today. The job is to package it, run it, test it, and set up a pipeline that checks it automatically.

## Before you start

Make sure these work on your machine:

- `docker --version` and `docker run hello-world`
- `docker buildx version` (included with current Docker Desktop installations)
- `node --version` (use the version listed in the repo README)
- `git --version`, and you can log in to GitHub
- Pre-pull the base images so you're not waiting on the network later: `docker pull node:20-alpine` and `docker pull nginx:alpine`

On Windows, use Docker Desktop in **Linux containers** mode. The Dockerfiles in this lab use Alpine Linux base images; Windows runs them in Docker Desktop's Linux VM rather than as native Windows containers.

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

Build and run the image:

```bash
docker build --build-arg API_URL=http://localhost:3000 -t frontend:v1 .
docker run --rm -p 8080:80 frontend:v1
```

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
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run test:int
      - run: npm run build

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm test -- --passWithNoTests
      - run: npm run build

  docker:
    needs: [backend, frontend]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t notes-backend:${{ github.sha }} ./backend
      - run: docker build --build-arg API_URL=http://localhost:3000 -t notes-frontend:${{ github.sha }} ./frontend
```

After `actions/checkout`, the runner starts in the root of the repository. GitHub does not inspect the repo and automatically enter `backend/` or `frontend/`. The `defaults.run.working-directory` setting above changes the directory for every `run` step in that job. For example, the backend's `npm ci` is equivalent to running `cd backend && npm ci` locally.

That default applies only to `run` steps, not to actions listed with `uses`. This is why each `setup-node` step also has a `cache-dependency-path`: it tells the action which lockfile belongs to that job. The Docker commands deliberately run from the repository root because `./backend` and `./frontend` are their build contexts.

The order matters. Lint is fastest, so it fails first. Unit tests come next, followed by the backend's integration tests and each app's production build. The Docker job starts only after both application jobs pass; `needs: [backend, frontend]` enforces that. It then builds both images, using the same frontend API URL you used in Compose.

The starter frontend does not contain a test file yet, so its test command uses Vitest's `--passWithNoTests` option. Once you add a frontend test, Vitest will discover and run it normally.

Now the exercise:

1. Push the workflow and watch the run in the **Actions** tab. It should be green.
2. Check out the `lab/ci-broken` branch. It has a lint error and a real bug planted in it. Push it and watch the pipeline go red. Open the failed step and read the log — notice that lint fails first, and the Docker build never even starts.
3. Fix it, push again, and confirm it goes green.
4. Add one small test of your own.

## 2:50-3:00 Core lab wrap-up

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

The core lab finishes here. Continue with the publishing extension if you have another 30 minutes.

## 3:00-3:15 Publish the images to GitHub Container Registry

Container images are not committed to a Git repository. They are uploaded as packages to a container registry. GitHub's registry is GitHub Container Registry (GHCR), and its image names start with `ghcr.io`:

```text
ghcr.io/OWNER/REPOSITORY-backend:TAG
ghcr.io/OWNER/REPOSITORY-frontend:TAG
```

Image names must be lowercase. In the examples below, replace `OWNER` and `REPOSITORY` with lowercase versions of your GitHub account or organization name and repository name.

### Optional: push once from your laptop

Use the automated workflow in the next section for the main exercise. This optional route is useful for learning the registry commands. It pushes the single-platform images you built on your current machine; the workflow replaces them with multi-platform tags. Create a GitHub personal access token (classic) with the `write:packages` scope, then keep it in an environment variable. Do not paste the token into a Dockerfile, workflow, or committed file.

```bash
export CR_PAT=your_token_here
echo "$CR_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

docker tag backend:v2 ghcr.io/OWNER/REPOSITORY-backend:manual
docker tag frontend:v1 ghcr.io/OWNER/REPOSITORY-frontend:manual

docker push ghcr.io/OWNER/REPOSITORY-backend:manual
docker push ghcr.io/OWNER/REPOSITORY-frontend:manual
```

If you used a different local frontend tag, substitute it for `frontend:v1`. A package first pushed from the command line is private by default and is not automatically linked to the source repository. Before using the workflow below with the same package names, open **Packages → package name → Package settings**, connect the source repository, and give that repository access under **Manage Actions access**. You can also change the package visibility there.

### Publish automatically from GitHub Actions

The normal approach is to publish from CI with the repository's short-lived `GITHUB_TOKEN`. You do not need to create or save a PAT for this workflow. Add the following job to `.github/workflows/ci.yml`, at the same indentation level as the existing `backend`, `frontend`, and `docker` jobs:

```yaml
  publish:
    needs: docker
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Normalize the GHCR image prefix
        id: image
        shell: bash
        run: echo "prefix=ghcr.io/${GITHUB_REPOSITORY,,}" >> "$GITHUB_OUTPUT"

      - name: Log in to GHCR
        uses: docker/login-action@v4
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v4

      - name: Build and push backend
        uses: docker/build-push-action@v7
        with:
          context: ./backend
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ${{ steps.image.outputs.prefix }}-backend:${{ github.sha }}
            ${{ steps.image.outputs.prefix }}-backend:latest
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}

      - name: Build and push frontend
        uses: docker/build-push-action@v7
        with:
          context: ./frontend
          platforms: linux/amd64,linux/arm64
          push: true
          build-args: |
            API_URL=http://localhost:3000
          tags: |
            ${{ steps.image.outputs.prefix }}-frontend:${{ github.sha }}
            ${{ steps.image.outputs.prefix }}-frontend:latest
          labels: |
            org.opencontainers.image.source=https://github.com/${{ github.repository }}
            org.opencontainers.image.revision=${{ github.sha }}
```

The job publishes only after the test and Docker jobs pass on a push to `main`. Pull requests build and test the images but cannot publish them. Each image gets two tags:

- The commit-SHA tag tells you which source revision produced the image. A registry tag can still be overwritten; use the image digest when you need an immutable deployment reference.
- `latest` is convenient for the workshop, but it moves on every successful `main` build. Use the SHA tag for deployments that must be reproducible.

The frontend's API URL is build-time configuration. Replace `http://localhost:3000` with the URL browsers will use in your real environment before treating this as a production image.

Push the workflow, open the **Actions** tab, and wait for the `publish` job. Then open the repository or account **Packages** page and find both images. Publishing with this workflow links new packages to the repository automatically.

If the first workflow push receives `permission_denied: write_package`, check **Repository settings → Actions → General → Workflow permissions** and your organization's package policy. If a package with the same name already exists from a manual push, connect the repository under that package's settings and grant the repository Actions write access.

## 3:15-3:30 Make one image work across common machines

Operating system and CPU architecture are separate concerns:

| Developer machine | Docker runs for this lab | Image platform needed |
| --- | --- | --- |
| Intel/AMD Linux | Linux containers directly | `linux/amd64` |
| Apple silicon Mac | Linux containers in Docker Desktop's Linux VM | `linux/arm64` |
| Intel Mac | Linux containers in Docker Desktop's Linux VM | `linux/amd64` |
| Windows on an Intel/AMD PC | Linux containers in Docker Desktop/WSL 2 | `linux/amd64` |
| ARM Linux or Windows on ARM | Linux containers directly or in Docker Desktop | `linux/arm64` |

The publish job builds both `linux/amd64` and `linux/arm64`. GHCR stores them behind one tag in a multi-platform manifest. When someone runs `docker pull`, Docker reads the manifest and downloads the matching variant automatically.

This does **not** make the images native Windows containers. A native Windows container needs a Windows base image and usually a separate Dockerfile and CI runner. This application does not need that: Docker Desktop on Windows runs the Linux images used throughout the lab.

You can also create and push a multi-platform image from your laptop. Buildx cannot load a multi-platform result into the classic local image store, so use `--push` rather than `--load`:

```bash
docker buildx create --name workshop-builder --use
docker buildx inspect --bootstrap

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/OWNER/REPOSITORY-backend:multi \
  --push ./backend
```

If `workshop-builder` already exists, select it with `docker buildx use workshop-builder` instead of creating it again. Emulation makes this easy but may be slower than a normal single-platform build.

Inspect the published manifest before testing it:

```bash
docker buildx imagetools inspect ghcr.io/OWNER/REPOSITORY-backend:latest
```

The output should list both `linux/amd64` and `linux/arm64`. Then have one person on each available architecture run a smoke test:

```bash
docker pull ghcr.io/OWNER/REPOSITORY-backend:latest
docker image inspect ghcr.io/OWNER/REPOSITORY-backend:latest \
  --format '{{.Os}}/{{.Architecture}}'
docker run --rm -d --name notes-backend-test \
  -p 3000:3000 ghcr.io/OWNER/REPOSITORY-backend:latest
curl http://localhost:3000/health
docker stop notes-backend-test
```

For a private package, run `docker login ghcr.io` first with a token that has `read:packages`. For a public package, pulling does not require authentication.

Checkpoint: both image tags appear in GHCR, the manifest lists `linux/amd64` and `linux/arm64`, and the backend health endpoint responds after pulling the image on another machine.

## Take-home tasks

1. Add a Postgres service to your Compose file with a named volume and see what happens to your data on `docker compose down` vs `down -v`.
2. Scan your image with `docker scout quickview` or Trivy and read what it reports.
3. Replace the frontend's workshop API URL with the URL for a deployed backend, publish a new SHA tag, and verify the browser calls that backend.
4. Add an OCI description label and inspect it on the GHCR package page.

References: [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry), [publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), and [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/).

If you fall behind at any point, ask for the checkpoint branch for the next stage and keep going. Reading a working version and comparing it to yours is a legitimate way to learn.
