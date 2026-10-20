# Atlas render image: ffmpeg and headless Blender for the render runner
# (apps/local-control/src/platform/render/render-runner.mjs).
#
# - The base image is pinned by digest. docker/render/README.md says how to
#   refresh it. A tag alone can move under us; a digest cannot.
# - There is no ENTRYPOINT. The runner passes the tool as the command
#   (`ffmpeg ...` or `blender ...`): images configured through
#   ATLAS_RENDER_FFMPEG_IMAGE / ATLAS_RENDER_BLENDER_IMAGE run with
#   entrypointRunsTool=false. One image serves both tools.
# - Nothing here needs the network at runtime: the runner always starts the
#   container with --network none, a read-only root filesystem, all
#   capabilities dropped, a tmpfs /tmp and the job's staging copy at /workspace.
# - The runner passes --user <uid>:<gid> of the Atlas daemon; the USER below is
#   the non-root default for anyone running the image by hand.
FROM debian:trixie-20261005-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

ARG DEBIAN_FRONTEND=noninteractive
# drawtext finds its default font through fontconfig; the cache is built here so
# a render never writes one into /workspace (the runner refuses undeclared files).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg blender fontconfig fonts-dejavu-core \
 && fc-cache --force --system-only \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
 && groupadd --system --gid 10001 render \
 && useradd --system --uid 10001 --gid render --home-dir /workspace --no-create-home --shell /usr/sbin/nologin render \
 && mkdir -p /workspace \
 && chown render:render /workspace

# Per-user state goes to the tmpfs /tmp, never into /workspace, where any file
# the job did not declare fails the render. The runner sets HOME and TMPDIR.
ENV XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    BLENDER_USER_CONFIG=/tmp/.blender/config \
    BLENDER_USER_SCRIPTS=/tmp/.blender/scripts \
    BLENDER_USER_DATAFILES=/tmp/.blender/datafiles \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace
USER 10001:10001
CMD ["ffmpeg", "-hide_banner", "-version"]
