import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

// Renders the Helm chart with ci/full-values.yaml. Needs helm on PATH (CI installs it); skipped without.
const helm = spawnSync("helm", ["version", "--short"]).status === 0;

function render(...set: string[]): Record<string, any>[] {
  const out = execFileSync(
    "helm",
    ["template", "t", "deploy/helm/neotags", "--namespace", "bots", "-f", "deploy/helm/neotags/ci/full-values.yaml", ...set.flatMap((s) => ["--set", s])],
    { encoding: "utf8" },
  );
  return parseAllDocuments(out)
    .map((d) => d.toJS() as Record<string, any> | null)
    .filter((d): d is Record<string, any> => !!d);
}

function renderError(...set: string[]): string {
  const r = spawnSync("helm", ["template", "t", "deploy/helm/neotags", "-f", "deploy/helm/neotags/ci/full-values.yaml", ...set.flatMap((s) => ["--set", s])], { encoding: "utf8" });
  expect(r.status).not.toBe(0);
  return r.stderr;
}

describe.skipIf(!helm)("chart: routines", () => {
  const docs = helm ? render() : [];
  const cronJobs = docs.filter((d) => d.kind === "CronJob");
  const byName = (n: string) => cronJobs.find((c) => c.metadata.name === n)!;

  it("renders one CronJob per routine, named after it, suspended while disabled", () => {
    expect(cronJobs.map((c) => c.metadata.name).sort()).toEqual(["example-daily", "example-triage"]);
    expect(byName("example-daily").spec).toMatchObject({
      schedule: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      suspend: false,
      concurrencyPolicy: "Forbid",
      startingDeadlineSeconds: 600,
      successfulJobsHistoryLimit: 3,
      failedJobsHistoryLimit: 3,
    });
    expect(byName("example-triage").spec.suspend).toBe(true);
  });

  it("labels the CronJob, the Job and the Pod, which the NetworkPolicy lets in", () => {
    const c = byName("example-daily");
    const want = { "app.kubernetes.io/component": "moose-job", "moose.neotags.io/routine": "example-daily" };
    expect(c.metadata.labels).toMatchObject(want);
    expect(c.spec.jobTemplate.metadata.labels).toMatchObject(want);
    const pod = c.spec.jobTemplate.spec.template;
    expect(pod.metadata.labels).toMatchObject(want);
    // Not the bot's selector: its Service must never route to these Pods.
    expect(pod.metadata.labels).not.toHaveProperty("app.kubernetes.io/name");
    const np = docs.find((d) => d.kind === "NetworkPolicy")!;
    const peers = np.spec.ingress.flatMap((r: any) => r.from);
    expect(peers).toContainEqual({ podSelector: { matchLabels: { "app.kubernetes.io/component": "moose-job" } } });
  });

  it("gives the Pod only fire, the bot's URL and the job key", () => {
    const job = byName("example-daily").spec.jobTemplate.spec;
    const pod = job.template.spec;
    expect(pod).toMatchObject({ restartPolicy: "Never", serviceAccountName: "moose-job-fire", automountServiceAccountToken: false });
    const [c, ...others] = pod.containers;
    expect(others).toEqual([]);
    expect(c).toMatchObject({ name: "fire", image: "ghcr.io/neotags/neotags:lint", command: ["node", "dist/index.js"], args: ["fire", "example-daily"] });
    expect(c.envFrom).toBeUndefined();
    expect(c.env).toEqual([
      { name: "JOB_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.labels['batch.kubernetes.io/job-name']" } } },
      { name: "MOOSE_URL", value: "http://t-neotags.bots:3001" },
      { name: "MOOSE_JOB_KEY", valueFrom: { secretKeyRef: { name: "neotags-secrets", key: "MOOSE_JOB_KEY" } } },
    ]);
    expect(c.resources.requests).toEqual({ cpu: "10m", memory: "64Mi" });
    const sa = docs.find((d) => d.kind === "ServiceAccount" && d.metadata.name === "moose-job-fire")!;
    expect(sa.automountServiceAccountToken).toBe(false);
  });

  it("fails the Job on a usage error, ignores disruptions, and outlasts the bot's deadline", () => {
    const job = byName("example-daily").spec.jobTemplate.spec;
    expect(job).toMatchObject({ backoffLimit: 1, activeDeadlineSeconds: 4500 });
    expect(job.podFailurePolicy.rules).toEqual([
      { action: "FailJob", onExitCodes: { containerName: "fire", operator: "In", values: [2] } },
      { action: "Ignore", onPodConditions: [{ type: "DisruptionTarget" }] },
    ]);
  });

  it("keeps AWS credentials out of the executor sidecar", () => {
    const d = docs.find((x) => x.kind === "Deployment")!;
    expect(d.spec.template.metadata.annotations["eks.amazonaws.com/skip-containers"]).toBe("executor");
  });

  it("falls back to neotags for a bot name with no ASCII letter or digit", () => {
    const c = render("config.bot.name=机器人").find((d) => d.kind === "CronJob")!;
    expect(c.metadata.labels).toMatchObject({ "app.kubernetes.io/component": "neotags-job", "neotags.neotags.io/routine": c.metadata.name });
    expect(c.spec.jobTemplate.spec.template.spec.serviceAccountName).toBe("neotags-job-fire");
  });

  it("takes the job key's name from the job caller's keyFromEnv", () => {
    const docs2 = render("config.jobsApi.callers.job.keyFromEnv=ROUTINES_KEY");
    const c = docs2.find((d) => d.kind === "CronJob")!.spec.jobTemplate.spec.template.spec.containers[0];
    expect(c.env.find((e: any) => e.name === "MOOSE_JOB_KEY").valueFrom.secretKeyRef.key).toBe("ROUTINES_KEY");
  });

  it("refuses routines without the internal API, and names a CronJob cannot have", () => {
    expect(renderError("config.jobsApi.enabled=false")).toMatch(/routines need config.jobsApi.enabled/);
    expect(renderError("routines.Bad_Name.trigger.schedule=x")).toMatch(/routines.Bad_Name: a routine name/);
    expect(renderError("routines.daily-.trigger.schedule=x")).toMatch(/routines.daily-: a routine name/);
  });
});
