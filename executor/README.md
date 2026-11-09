# neotags executor

The executor is the sidecar that runs skill-pack code for neotags. The
neotags container never executes commands itself. It sends a request over a unix
socket inside the Pod, and the executor runs the command under the constraints
in that request and returns JSON with stdout, stderr, exit code, and duration.

The image is `debian:bookworm-slim` with bubblewrap, the egress proxy, and
Debian's Python 3.11. The code uses the standard library plus Debian's
libseccomp bindings (`python3-seccomp`), so it runs with a read-only root
filesystem and has no packages from PyPI.

<!-- prettier-ignore -->
> [!NOTE]
> neotags calls `/v1/exec` through its `Sandbox` client (`src/sandbox/`,
> backend `local`). The client is off by default (`sandbox.backend: none`),
> and its tool guard refuses every execution from a skill pack without a
> `sandbox` declaration.

## How it works

The executor offers two execution modes behind one server.

| Mode | Endpoint | Isolation | Used by |
| --- | --- | --- | --- |
| Per call | `POST /v1/exec` | A fresh bubblewrap sandbox for each call | Commands from interactive troubleshooting |
| Resident worker | `POST /v1/call` | The sidecar container only | Alert-gate checks (function calls, low latency) |

### Per-call sandbox

Each `/v1/exec` call starts `prlimit … bwrap … sandbox_init.py … <argv>` and
gets the following isolation:

- **Namespaces:** new user, mount, PID, network, IPC, UTS, and cgroup
  namespaces (`--unshare-all`). When `/proc` is available, `--disable-userns`
  also stops the command from creating more user namespaces; the seccomp
  filter blocks them in every mode.
- **Filesystem:** `/usr` and the libraries are read-only, `/tmp` is a private
  tmpfs, and `/work` is a fresh directory that's deleted after the call.
  Credentials, the executor socket, and other sandboxes' files aren't mounted.
- **Environment:** bwrap starts with `--clearenv`. The sandbox only gets
  `PATH`, `HOME=/work`, `LANG`, the request's `env`, credential placeholders,
  and the proxy variables.
- **seccomp:** `sandbox_init.py` compiles a filter with libseccomp and loads
  it before it runs the command. `RULES` in that file lists every denied
  syscall:
  - io_uring;
  - new `AF_UNIX` sockets;
  - `clone` and `unshare` with `CLONE_NEWUSER`, and `setns`;
  - mount operations, both the old and the new mount API;
  - `ptrace` and `process_vm_readv`/`process_vm_writev`;
  - `bpf`, `perf_event_open`, `userfaultfd`, and the keyring syscalls.

  `clone3` returns `ENOSYS`, so libc falls back to `clone`, whose flags the
  filter can check. libseccomp adds only the native ABI, so a syscall from
  another ABI (x32 or 32-bit compat) kills the process.
- **Limits:** `prlimit` sets CPU seconds (`cpu × timeoutSec`), address space
  (`mem`), file size, open files, and process count. The executor kills the
  sandbox at `timeoutSec`. Because bwrap runs with `--die-with-parent`, that
  tears down every process the command started.
- **Capabilities:** all capabilities are dropped (`--cap-drop ALL`).

### Network and credentials

The sandbox has no network interface except loopback. When a request declares
`net`, the executor starts a proxy for that call only, on a unix socket that
it binds into the sandbox. Inside the sandbox, a small bridge listens on
`127.0.0.1:3128` and forwards to that socket. `HTTP_PROXY` and `HTTPS_PROXY`
point at the bridge. A tool that ignores those variables has no network at
all, so the policy never depends on them.

The proxy enforces these rules:

- The host must exactly match a `net` entry. Wildcards aren't accepted. An
  entry without a port matches only ports 80 and 443.
- Every address the host resolves to must be outside loopback, link-local,
  unspecified, and multicast ranges, and must not be a cloud metadata address
  (including `fd00:ec2::254`). The proxy then connects to the address it
  checked.
- `CONNECT` (HTTPS) is tunneled without inspection, so no credentials are
  injected into it.
- For plain `http://` requests to a host in a credential's `hosts`, the proxy
  replaces the placeholder with the real value, and only inside that
  credential's `header`. Each call gets a new random placeholder.

Real credential values are files in `EXECUTOR_CREDENTIALS_DIR`, one file per
name. The sandbox only sees the placeholder in the environment variable of
the same name. In-cluster HTTP targets get direct injection; external HTTPS
targets go through an MCP server until the proxy terminates TLS.

### Startup self-check

At startup, the executor runs a probe sandbox. If bubblewrap can't create the
namespaces, every `/v1/exec` request gets a `503 sandbox_unavailable`
response, and the startup log contains the reason:

```json
{"level": "error", "event": "sandbox_unavailable", "reason": "bubblewrap probe failed: bwrap: No permissions to create new namespace, …", "msg": "per-call execution is disabled; every /v1/exec request will be refused"}
```

There's no fallback to running without a sandbox. Resident workers don't
depend on bubblewrap, so they keep working.

The probe tries three modes in order and uses the first that works:

1. `procfs=on, disable-userns=on`: a private `/proc`, plus bwrap's
   `--disable-userns`.
2. `procfs=off, disable-userns=on`: no `/proc`. Docker, and Kubernetes
   without `procMount: Unmasked`, mask `/proc`, so a new procfs can't be
   mounted. The sandbox then runs without `/proc` rather than with the host's
   view of it.
3. `procfs=off, disable-userns=off`: `--disable-userns` needs `/proc`, so
   only the seccomp filter blocks new user namespaces.

`/healthz` (`exec.mode`) and the `sandbox_ready` log line report the chosen
mode. If every mode fails, the reason lists each mode's error.

With `EXECUTOR_REQUIRE_PROCFS=1`, the probe tries only mode 1 and refuses all
executions if it fails, instead of falling back silently. Set it in
production, where the Pod settings in
[Deploy as a sidecar](#deploy-as-a-sidecar) make mode 1 available.

## API

The server speaks HTTP/1.1 on the unix socket (`EXECUTOR_SOCKET`, default
`/run/executor/exec.sock`). From Node.js, use `http.request({ socketPath })`.
Errors return `{"error": {"code": "…", "message": "…"}}`.

### `POST /v1/exec`

The following request runs a read-only CLI against one declared host with an
injected token:

```json
{
  "id": "run-42/call-3",
  "argv": ["example-cli", "items", "list"],
  "env": {"API_ORG": "default"},
  "stdin": "",
  "files": {"query.json": "{\"limit\": 10}"},
  "constraints": {
    "tools": ["example-cli"],
    "net": ["api.example.com:8080"],
    "credentials": [
      {"name": "API_TOKEN", "hosts": ["api.example.com"], "header": "Authorization"}
    ],
    "limits": {"cpu": 1, "mem": "512Mi", "timeoutSec": 60}
  }
}
```

The fields have these rules:

- `argv[0]` must be a bare command name listed in `constraints.tools`.
- `env` can't set `PATH`, proxy variables, `LD_*`, or a credential's name.
- `files` are written under `/work` and must use relative paths.
- `constraints` uses the same shape as the skill pack's `sandbox` front
  matter. The neotags Tool Guard checks a request against that declaration before
  it forwards the request; the executor checks the request again.

The response looks like this:

```json
{
  "id": "run-42/call-3",
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "durationMs": 184,
  "stdout": "…",
  "stderr": "",
  "truncated": {"stdout": false, "stderr": false},
  "egress": [{"method": "GET", "host": "api.example.com", "port": 8080, "decision": "allow", "injected": ["API_TOKEN"]}]
}
```

An `exitCode` above 128 means the command was killed by signal
`exitCode - 128`, and `signal` holds its name (for example `SIGXCPU` when the
CPU limit is reached). This is the shell convention, so a command that exits
with such a status itself reads the same.

The endpoint can return these status codes:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_*`, `tool_not_declared` | The request fails validation |
| 422 | `credential_unavailable` | A declared credential isn't configured in the executor |
| 429 | `busy` | The executor is at `EXECUTOR_MAX_CONCURRENCY` |
| 503 | `sandbox_unavailable` | The startup self-check failed; the reason is in `message` |

### `POST /v1/call`

This endpoint calls `function(args)` from a `.py` file under
`EXECUTOR_WORKER_ROOT` in a resident worker. A call that times out kills its
worker, and the executor starts a replacement.

```json
{"id": "gate-7", "entry": "alert-gate/checks/collection_chain.py", "function": "run", "args": {"alert": {}}, "timeoutSec": 3}
```

The response is `{"ok": true, "result": …}` or `{"ok": false, "error": {…}}`,
with `timedOut` and `durationMs`. An exception in the function returns its
type and message. If the worker itself fails, `error.type` is `Timeout`,
`WorkerDied`, `ResponseTooLarge` (over 4 MiB), or `ProtocolError`, and the
executor kills the worker's process group and starts a replacement. Workers are disabled by default
(`EXECUTOR_WORKERS=0`).

### `GET /healthz`

This endpoint reports whether per-call execution is available, the reason if
it isn't, and the worker count.

### Audit

Every call writes one JSON line to stderr. The line holds the request id,
tool, declared hosts, credential names, limits, exit code, duration, denied
destinations, and which credentials were injected. It never includes
credential values, arguments, or output.

## Configuration

All settings are environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXECUTOR_SOCKET` | `/run/executor/exec.sock` | Unix socket to listen on |
| `EXECUTOR_SOCKET_MODE` | `660` | Socket permissions (octal) |
| `EXECUTOR_WORK_ROOT` | `/tmp/executor` | Parent of the per-call directories |
| `EXECUTOR_CREDENTIALS_DIR` | `/run/executor/credentials` | One file per credential name |
| `EXECUTOR_SKILLS_DIR` | empty | Mounted read-only at `/skills` in the sandbox |
| `EXECUTOR_RO_BINDS` | empty | Extra read-only paths, colon-separated, for example CLI tool directories |
| `EXECUTOR_TOOL_PATH` | empty | Directories prepended to `PATH` in the sandbox |
| `EXECUTOR_REQUIRE_PROCFS` | empty | `1` accepts only the strongest sandbox mode (private `/proc` and `--disable-userns`) and refuses execution otherwise |
| `EXECUTOR_MAX_CONCURRENCY` | `4` | Concurrent `/v1/exec` calls |
| `EXECUTOR_MAX_OUTPUT_BYTES` | `1048576` | Limit for each of stdout and stderr |
| `EXECUTOR_DEFAULT_CPU`, `_MEM_MIB`, `_TIMEOUT_SEC` | `1`, `512`, `60` | Limits when a request omits them |
| `EXECUTOR_MAX_CPU`, `_MEM_MIB`, `_TIMEOUT_SEC` | `4`, `4096`, `300` | Highest limits a request can ask for |
| `EXECUTOR_WORKERS` | `0` | Resident worker count; `0` disables `/v1/call` |
| `EXECUTOR_WORKER_ROOT` | `EXECUTOR_SKILLS_DIR` | Root for `/v1/call` entries |
| `EXECUTOR_WORKER_MAX_TIMEOUT_SEC` | `30` | Highest `timeoutSec` for a call |

## Deploy as a sidecar

The neotags Helm chart adds it with `executor.enabled: true` and every
setting below (README "CI / deploy"). To run it as a sidecar of the neotags
Pod in some other way, give it the following settings:

- **Image:** this image, built for `linux/amd64` and `linux/arm64`.
- **Pod user namespace:** `hostUsers: false` on the Pod. The Pod gets its own
  user namespace, so root in any of its containers maps to an unprivileged
  host UID. It's also required for `procMount: Unmasked`.
- **procMount:** `procMount: Unmasked` in the sidecar's security context, so
  bwrap can mount a private `/proc` for each sandbox (mode 1). With the
  default (`Default`, masked), the kernel refuses a new procfs and the
  executor falls back to running without `/proc`.
- **Strict mode:** `EXECUTOR_REQUIRE_PROCFS=1` in the sidecar's environment,
  so a Pod that loses either setting refuses executions instead of running
  in a weaker mode.
- **Security context:** `runAsNonRoot: true`, `runAsUser: 65532`,
  `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and
  `capabilities.drop: [ALL]`.
- **seccomp:** `seccompProfile.type: Unconfined` for this container (or a
  `Localhost` profile that allows `unshare` and `clone` with
  `CLONE_NEWUSER`). containerd's and Docker's `RuntimeDefault` profiles block
  user namespaces, and the self-check then refuses all executions. The
  executor applies its own seccomp filter inside every sandbox.
- **Volumes:**
  - an `emptyDir` at `/run/executor`, shared with the neotags container, for the
    socket. Set `fsGroup` so both containers can use the socket (mode `660`);
  - an `emptyDir` at `/tmp` for per-call directories;
  - optionally, the executor's own Secret at `/run/executor/credentials`,
    holding only execution credentials. Never mount the neotags Secrets (bot
    token, aigw key, MCP credentials).
- **Service account token:** set `automountServiceAccountToken: false` on the
  Pod, and mount a projected token volume into the neotags container only.
- **Network:** with `net` declared, the sidecar's own egress is what the
  proxy uses. Limit it with a NetworkPolicy to the hosts that skill packs
  declare.

### Measured on EKS

On November 6, 2026, two probe Pods with `hostUsers: false` and
`seccompProfile: Unconfined` ran bubblewrap as UID 65532 on an EKS cluster
(EKS 1.36.4, Amazon Linux 2023, kernel 6.18, containerd 2.2.7, arm64):

| Probe | `procMount: Unmasked` | `procMount: Default` |
| --- | --- | --- |
| bwrap without `/proc` | Works | Works |
| bwrap `--proc /proc` | Works | `Can't mount proc on /newroot/proc: Operation not permitted` |
| bwrap `--proc /proc --disable-userns` | Works | Fails (same error) |
| PIDs visible in the sandbox's `/proc` | 2 (private) | Not applicable |
| `unshare -U` inside, with `--disable-userns` | Refused (`No space left on device`) | Not applicable |

The Pod's `uid_map` was `0 3201171456 65536`, so the Pod user namespace was
active. Both settings together give the executor mode 1.

### Verify user namespaces on a node

bubblewrap needs unprivileged user namespaces. Check this on every target
before you rely on per-call execution:

1. On an EKS node (AL2023), run the following commands. The second command
   must print `ok`:

   ```bash
   cat /proc/sys/user/max_user_namespaces   # must be greater than 0
   unshare -U -r true && echo ok
   ```

2. On Rancher Desktop, run the same check inside the VM:

   ```bash
   rdctl shell sh -c 'cat /proc/sys/user/max_user_namespaces; unshare -U -r true && echo ok'
   ```

3. In the cluster, check the executor's own result:

   ```bash
   kubectl logs <neotags-pod> -c executor | grep -E 'sandbox_ready|sandbox_unavailable'
   ```

If the node check passes but the executor logs `sandbox_unavailable`, the Pod's
seccomp or AppArmor profile is blocking `unshare`. See the seccomp setting
earlier in this section. If it logs `sandbox_ready` with a mode other than
`procfs=on, disable-userns=on`, check `hostUsers: false` and
`procMount: Unmasked`.

## Build and test

The unit tests for policy, proxy, seccomp rules, server, and workers run on
any OS. The libseccomp compile tests skip where `python3-seccomp` isn't
installed, so they run only in the image:

```bash
cd executor
python3 -m unittest discover -s tests -t .
```

The sandbox tests (`tests/test_sandbox.py`) need Linux, bubblewrap, and user
namespaces, so run them in the test image. Docker's default seccomp profile
blocks user namespaces, so the test container needs `seccomp=unconfined`:

```bash
docker build --target test -t neotags-executor:test .
docker run --rm --read-only --tmpfs /tmp:exec \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -e EXECUTOR_REQUIRE_SANDBOX=1 neotags-executor:test
```

`EXECUTOR_REQUIRE_SANDBOX=1` turns the sandbox tests' skip into a failure.
Docker masks `/proc`, so this run uses mode 3. To test mode 1 locally, also
unmask the system paths and require it:

```bash
docker run --rm --read-only --tmpfs /tmp:exec \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -e EXECUTOR_REQUIRE_SANDBOX=1 -e EXECUTOR_REQUIRE_PROCFS=1 neotags-executor:test
```

Without the `--security-opt` flags, the same image shows the refusal path:
the sandbox tests skip with the self-check reason.

To build both architectures:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/neotags-executor:<tag> .
```

## Publish the image

CI publishes the image to GitHub Container Registry as
`ghcr.io/neotags/neotags-executor:<tag>`. The tag has the same form as the
neotags image's: `<latest git tag>-<7-character commit SHA>`.

The image is published in two workflows:

1. `executor-check.yml` runs on each platform's own runner (amd64 and
   arm64). It builds the runtime image and scans it with Trivy, which fails
   on fixed HIGH and CRITICAL vulnerabilities. Then it builds the test image
   and runs the sandbox tests with `EXECUTOR_REQUIRE_SANDBOX=1` twice:
   without `/proc` (mode 3), then with `EXECUTOR_REQUIRE_PROCFS=1` (mode 1).
   `ci.yml` runs it on every pull request; it never pushes.
2. `build-executor-image.yml` runs on a push to `main` that changes
   `executor/`, or by hand for a branch. It runs the checks first, then
   builds both platforms from the build cache that the checks wrote, pushes
   the image, and scans the pushed image again.

To use the image with extra CLI tools, build your own image `FROM` it and add
them. You can also mount tool directories and point `EXECUTOR_RO_BINDS` and
`EXECUTOR_TOOL_PATH` at them.

## Known limitations

These gaps are known and accepted for now:

- **Memory limit:** `mem` is an address-space limit (`RLIMIT_AS`), not a
  cgroup limit. Runtimes that reserve large virtual ranges, such as Node.js,
  need a higher `mem`. The container's memory limit is the hard cap.
- **CPU limit:** `cpu` is a CPU-seconds budget over the timeout, not a core
  quota.
- **Process count:** `RLIMIT_NPROC` counts all processes of UID 65532 in the
  container, so it limits fork bombs but is shared with the executor.
- **Resident workers:** workers run as the executor user without bubblewrap.
  They can read the credentials directory, so don't enable workers and
  credentials together until the workers are isolated further.
- **Header injection:** credentials are injected only into plain HTTP
  requests. A tool that base64-encodes its credential (HTTP Basic) can't use a
  placeholder; store the full header value instead (for example, `Basic …`) and
  send the placeholder as the whole header.
- **Without `/proc` (modes 2 and 3):** programs that read `/proc` fail, for
  example `ps`, or binaries whose library path uses `$ORIGIN` (ld.so reads
  `/proc/self/exe`). Mode 1 doesn't have this gap.
- **Contents:** the image ships only the executor and the Python runtime. It
  has no CLI tools for skill packs; see
  [Publish the image](#publish-the-image) for adding them.

## Next steps

These pieces build on the executor and are planned:

- An executor sidecar option in the Helm chart with the settings in
  [Deploy as a sidecar](#deploy-as-a-sidecar).
