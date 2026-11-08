# syntax=docker/dockerfile:1
#
# neotags executor sidecar. Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/OWNER/neotags-executor:<tag> .
# Tests (needs a runtime that allows user namespaces, see README):
#   docker build --target test -t neotags-executor:test .

# Debian's own Python (3.11) so the distribution's libseccomp bindings
# (python3-seccomp) work; they're built for the system interpreter only.
# Pinned by digest so CI's checked build and its pushed build start from the
# same base (build-executor-image.yml); Dependabot bumps it.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS base

# bubblewrap: per-call sandbox. python3-seccomp: the sandbox's syscall
# filter. util-linux (prlimit) is already in the base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bubblewrap ca-certificates python3 python3-seccomp \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 65532 executor \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent \
       --shell /usr/sbin/nologin executor \
    && install -d -o 65532 -g 65532 -m 0750 /run/executor

COPY executor/ /opt/executor/executor/
RUN python3 -m compileall -q /opt/executor

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/executor \
    EXECUTOR_SOCKET=/run/executor/exec.sock \
    EXECUTOR_WORK_ROOT=/tmp/executor
WORKDIR /opt/executor
USER 65532:65532

FROM base AS test
COPY --chown=65532:65532 tests/ /opt/executor/tests/
CMD ["python3", "-m", "unittest", "discover", "-v", "-s", "tests", "-t", "."]

# Runtime target last, so a plain `docker build` produces it.
# Writable paths with a read-only root filesystem: /run/executor (socket,
# shared with neotags) and /tmp (per-call workdirs). Mount both as emptyDir.
FROM base AS runtime
ENTRYPOINT ["python3", "-m", "executor"]
