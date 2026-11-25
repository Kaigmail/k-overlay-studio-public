import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
import { verifyDesktop } from "./verify-002/desktop.mjs";
import { isolateWorkspace, withEditor } from "./verify-002/editor.mjs";
import { verifyBaseline } from "./verify-003/baseline.mjs";
import { verifyUS1 } from "./verify-003/us1.mjs";
import { verifyUS2 } from "./verify-003/us2.mjs";

import { saveUS3Fixture, verifyUS3, verifyUS3Desktop } from "./verify-003/us3.mjs";
import { verifyUS4 } from "./verify-003/us4.mjs";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const suites = new Map([
  ["baseline", { run: verifyBaseline, editor: true }],
  ["frames", { run: async () => (await tsImport("./verify-003/frames.mjs", import.meta.url)).verifyFrames() }],
  ["document", { run: async () => (await tsImport("./verify-003/document.mjs", {
    parentURL: import.meta.url, tsconfig: join(appRoot, "tsconfig.app.json"),
  })).verifyDocument() }],
  ["us1", { run: verifyUS1, editor: true }],
  ["us2", { run: verifyUS2, editor: true }],
  ["us3", { run: verifyUS3, editor: true }],
  ["us3-desktop", { desktop: true }],
  ["us4", { run: verifyUS4, editor: true }],
]);
const usage = "npm run verify:003 -- --suite <baseline|frames|document|us1|us2|us3|us3-desktop|us4|all> [--case-dir <path>] [--run-id <id>] [--desktop]";

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string", multiple: true },
      "case-dir": { type: "string" },
      "run-id": { type: "string" },
      desktop: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const selected = [...new Set((values.suite ?? ["all"]).flatMap((name) =>
    name.toLowerCase() === "all" ? [...suites.keys()].filter((key) => !suites.get(key).desktop) : [name.toLowerCase()],
  ))];
  if (selected.some((name) => !suites.has(name))) throw new Error(usage);

  const runId = values["run-id"] ?? `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(runId)) throw new Error("无效的验收批次 ID。");
  const evidenceRoot = resolve(process.env.VERIFY_003_ROOT ?? join(
    process.platform === "win32" ? parse(appRoot).root : tmpdir(), "Codex-acceptance", "k-overlay-studio", "003",
  ));
  const caseDir = values["case-dir"] ? await realpath(values["case-dir"]) : undefined;
  if (caseDir) {
    const fromCase = relative(caseDir, evidenceRoot);
    if (!isAbsolute(fromCase) && !/^\.\.(?:[/\\]|$)/.test(fromCase)) {
      throw new Error("验收输出目录须位于只读案例目录之外。");
    }
  }
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceDir = join(evidenceRoot, runId);
  await mkdir(evidenceDir);

  const report = { runId, caseDir, evidenceDir, startedAt: new Date().toISOString(), checks: [] };
  async function check(name, run) {
    let entry;
    try {
      entry = run ? { name, status: "passed", details: await run() }
        : { name, status: "pending", reason: "此用户故事在后续阶段接入。" };
    } catch (error) {
      entry = { name, status: "failed", error: error.message, stack: error.stack };
    }
    report.checks.push(entry);
    console.log(`${entry.status} ${name} ${entry.error ?? entry.reason ?? ""}`.trimEnd());
  }

  const context = { appRoot, evidenceDir, caseDir };
  const editorSuites = [];
  for (const name of selected) {
    const suite = suites.get(name);
    if (suite.desktop) continue;
    if (suite.editor) editorSuites.push([name, suite.run]);
    else await check(name, suite.run && (() => suite.run(context)));
  }
  if (editorSuites.length) {
    await check("editor", () => withEditor({ ...context, signal: new AbortController().signal }, async (editor) => {
      for (const [name, run] of editorSuites) {
        const target = join(evidenceDir, name);
        await check(name, async () => {
          await mkdir(target);
          return run({ ...context, ...editor, evidenceDir: target });
        });
      }
    }, { isolateUploads: true, demo: true }));
  }
  if (selected.includes("us3-desktop") || (values.desktop && selected.includes("us3"))) {
    await check("us3-desktop", async () => {
      const target = join(evidenceDir, "us3-desktop");
      await mkdir(target);
      const file = await saveUS3Fixture(target);
      const exec = promisify(execFile);
      await verifyDesktop({
        evidenceDir: target,
        signal: new AbortController().signal,
        isolateWorkspace: () => isolateWorkspace(target, { demo: true }),
        command: async (...args) => (await exec(...args)).stdout,
        check: async (name, run) => {
          await check(name, run);
          return report.checks.at(-1).details;
        },
        skip: (name, reason) => report.checks.push({ name, status: "pending", reason }),
      }, (page, ui) => verifyUS3Desktop(page, { file, ui, evidenceDir: target }));
      const ime = report.checks.find(({ name }) => name === "desktop-editor-fields")?.details?.ime;
      if (ime?.status === "pending") report.checks.push({ name: "desktop-native-ime", ...ime });
    });
  }
  report.status = report.checks.some(({ status }) => status === "failed") ? "failed"
    : report.checks.some(({ status }) => status === "pending") ? "pending" : "passed";
  report.finishedAt = new Date().toISOString();
  const result = join(evidenceDir, "result.json");
  await writeFile(result, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(result);
  process.exitCode = { passed: 0, failed: 1, pending: 2 }[report.status];
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
