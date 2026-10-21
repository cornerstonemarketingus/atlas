# The image every Atlas cloud environment starts from (Cloudflare Sandbox SDK 1.0,
# `durable_object` scheduling policy). Built by `wrangler deploy` only when
# apps/web/sandbox.config.json has "enabled": true.
FROM node:24.20.0-trixie-slim

# git: workspaces are git repositories and the tree manifest follows .gitignore.
# coreutils: `timeout` bounds every command and what it starts.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git coreutils \
	&& rm -rf /var/lib/apt/lists/*

# The helper that Files and DirectoryBackup run. Its tag must match the
# @cloudflare/sandbox version in apps/web/package.json (a mismatch is a SandboxProtocolError).
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Lists the workspace tree for snapshot digests (same scheme as a local snapshot).
COPY tree-manifest.mjs /opt/atlas/tree-manifest.mjs

# /workspace/project itself is created at runtime, so a restore can replace it.
RUN mkdir -p /workspace
WORKDIR /workspace
CMD ["sleep", "infinity"]
