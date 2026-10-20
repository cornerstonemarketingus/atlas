# Atlas render image

`docker/render/Dockerfile` builds one image with **ffmpeg** and **headless Blender**. The local daemon's render runner uses it (`apps/local-control/src/platform/render/`). The same image serves both tools.

- **No entrypoint.** The runner passes the tool as the command (`ffmpeg …`, `blender -b …`). An image named in `ATLAS_RENDER_*_IMAGE` runs with `entrypointRunsTool=false`.
- **Non-root.** The default user is `render` (uid/gid 10001). The runner also passes `--user <uid>:<gid>` of the Atlas daemon.
- **No network at runtime.** The runner always starts it with `--network none`, a read-only root filesystem, all capabilities dropped and a tmpfs `/tmp`. It mounts only a staging copy of the job's declared inputs at `/workspace`.
- **Nothing written to `/workspace` by itself.** The runner fails a render that leaves an undeclared file behind. So the fontconfig cache is built into the image, and the XDG and Blender user directories point at `/tmp`.

## Build and use

```sh
docker build -t atlas/render:local docker/render
docker image inspect --format '{{.Id}}' atlas/render:local    # local image id

# Tell the daemon (same runtime the terminal sandbox uses):
export ATLAS_TERMINAL_CONTAINER_RUNTIME=/usr/bin/docker      # or podman
export ATLAS_RENDER_FFMPEG_IMAGE=atlas/render:local
export ATLAS_RENDER_BLENDER_IMAGE=atlas/render:local
```

Restart Atlas. `GET /v1/render` should then report `available: true` with `render.ffmpeg` and `render.blender`. A Genesis project page in the console (Build → a project → **Render a clip**) offers the presets.

Quick check by hand, with the same isolation the runner uses:

```sh
mkdir -p /tmp/render-check/out
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp \
  --user "$(id -u):$(id -g)" -e HOME=/workspace \
  --mount type=bind,source=/tmp/render-check,target=/workspace -w /workspace \
  atlas/render:local ffmpeg -hide_banner -f lavfi -i "color=c=black:size=640x360:duration=2" \
  -vf "drawtext=text='Atlas':fontcolor=white:fontsize=h/8:x=(w-text_w)/2:y=(h-text_h)/2" out/check.mp4
docker run --rm --network none atlas/render:local blender --version
```

## Pinning

### The base image

The `FROM` line pins `debian:trixie-20261005-slim` by its multi-platform index digest:

`sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f`

This digest comes from Docker Hub. It is what `debian:trixie-slim` and `debian:trixie-20261005-slim` pointed to on 2026-10-06. The tag is kept next to the digest so people can read it. The digest is what Docker uses.

To refresh it:

```sh
# Pick the newest dated slim tag at https://hub.docker.com/_/debian/tags?name=trixie-
docker buildx imagetools inspect debian:trixie-YYYYMMDD-slim --format '{{json .Manifest.Digest}}'
# or, without Docker:
curl -s https://hub.docker.com/v2/repositories/library/debian/tags/trixie-YYYYMMDD-slim | jq -r .digest
```

Replace both the tag and the digest on the `FROM` line. Then rebuild and run the quick check above. `apps/local-control/tests/render-ui.test.mjs` fails if `FROM` is not digest-pinned or if `USER` is root.

### Your built image

Point the daemon at the image's digest, not a moving tag:

```sh
docker tag atlas/render:local ghcr.io/<owner>/atlas-render:<date>
docker push ghcr.io/<owner>/atlas-render:<date>
docker buildx imagetools inspect ghcr.io/<owner>/atlas-render:<date> --format '{{json .Manifest.Digest}}'
export ATLAS_RENDER_FFMPEG_IMAGE=ghcr.io/<owner>/atlas-render@sha256:<digest>
export ATLAS_RENDER_BLENDER_IMAGE=ghcr.io/<owner>/atlas-render@sha256:<digest>
```

The runner's image grammar accepts `name@sha256:…` references.

Debian packages come from the archive at build time, so two builds of the same Dockerfile can differ in package versions. For byte-for-byte rebuilds, point apt at `snapshot.debian.org` for a fixed date, or keep using the pushed digest.

## Notes

- **Blender** is Debian trixie's packaged build, run with `-b` (background). Headless containers have no GPU or display, so use **Cycles** on the CPU. EEVEE and Workbench need an OpenGL context and usually fail without one.
- **Fonts.** ffmpeg `drawtext` uses DejaVu Sans through fontconfig. The render policy refuses `fontfile=`, so captions always use the image's default font.

## Follow-up for the owner: publishing from CI

Workflows are protected paths, so this change does not add one. A workflow to publish the image could work like this:

- **Trigger:** `workflow_dispatch`, plus `push` to `main` on `docker/render/**`.
- **Permissions:** `contents: read` and `packages: write`.
- **Steps:**
  1. `docker/setup-buildx-action`.
  2. `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN`.
  3. `docker/build-push-action` with `context: docker/render`, `platforms: linux/amd64,linux/arm64`, tags `ghcr.io/<owner>/atlas-render:<date>-<sha>`, and `provenance: true` / `sbom: true`.
- **Smoke test:** run the image with `--network none` and render a 1-second lavfi clip, as in the quick check above.
- **Output:** write the pushed digest to the job summary, so the owner can set `ATLAS_RENDER_*_IMAGE=…@sha256:<digest>`.
- **Before pushing a workflow:** run `python3 .github/atlas/check-workflows.py`.
