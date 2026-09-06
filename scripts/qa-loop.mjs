import { spawnSync } from "node:child_process";

const iterations = readIterations();
const commands = [
  { command: "npm", args: ["run", "test"], label: "unit + sidecar smoke tests" },
  { command: "npm", args: ["run", "build"], label: "typecheck + production build" },
  {
    command: "npm",
    args: ["audit"],
    label: "dependency audit",
    tolerateOfflineFailure: true
  }
];

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  console.log(`\nQA iteration ${iteration}/${iterations}`);
  for (const { command, args, label, tolerateOfflineFailure = false } of commands) {
    console.log(`\n→ ${label}`);
    const stdio = tolerateOfflineFailure ? "pipe" : "inherit";
    const result = spawnSync(command, args, {
      cwd: new URL("..", import.meta.url),
      stdio,
      shell: false,
      encoding: "utf8"
    });

    if (tolerateOfflineFailure) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }

    if (result.status !== 0) {
      if (tolerateOfflineFailure && isOfflineAuditError(result)) {
        console.warn("Skipping dependency audit failure due to offline or restricted network access.");
        continue;
      }
      console.error(`\nQA loop stopped on: ${label}`);
      process.exit(result.status ?? 1);
    }
  }
}

console.log(`\nQA loop passed ${iterations} iteration${iterations === 1 ? "" : "s"}.`);

function readIterations() {
  const arg = process.argv.find((value) => value.startsWith("--iterations="));
  const parsed = Number(arg?.split("=")[1] ?? "1");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isOfflineAuditError(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return (
    output.includes("ENOTFOUND") ||
    output.includes("EAI_AGAIN") ||
    output.includes("ECONNRESET") ||
    output.includes("network request to https://registry.npmjs.org") ||
    output.includes("audit endpoint returned an error")
  );
}
