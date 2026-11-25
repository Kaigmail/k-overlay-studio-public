import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { isolateWorkspace, withEditor } from "./verify-002/editor.mjs";
import { generateFixtures } from "./verify-002/fixtures.mjs";
import { verifyGeometry } from "./verify-002/geometry.mjs";
import { verifyPreview } from "./verify-002/preview.mjs";
import { verifyExport } from "./verify-002/export.mjs";
import { verifyDesktop } from "./verify-002/desktop.mjs";
import { verifyG5Handoff } from "./verify-002/g5-handoff.mjs";

const exec = promisify(execFile);
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const productPort = 5177;
const suites = new Map([
  ["smoke", smoke],
  ["fixtures", generateFixtures],
  ["preview", verifyPreview],
  ["geometry", verifyGeometry],
  ["export", verifyExport],
  ["desktop", verifyDesktop],
  ["g5-handoff", verifyG5Handoff],
]);
const usage = "npm run verify:002 -- --suite <smoke|fixtures|preview|geometry|export|desktop|g5-handoff> [--case-dir <path>] [--run-id <id>] [--fixture-run-id <id>] [--baseline-run-id <id>] [--export-run-id <id>]";

async function smoke(context) {
  await context.check("editor", () =>
    withEditor(context, async ({ browser, url, profile }) => {
      const page = await browser.newPage();
      const response = await page.goto(url);
      if (!response?.ok()) throw new Error(`编辑台请求失败：${response?.status()}`);
      await page.waitForSelector("#root > *");
      return {
        url,
        title: await page.title(),
        browser: await browser.version(),
        browserPid: browser.process()?.pid,
        profile,
      };
    }),
  );
}

async function checkProductPort() {
  // Windows 的地址复用会让绑定探测漏报，直接检查两种回环地址是否已在监听。
  for (const host of ["127.0.0.1", "::1"]) {
    const occupied = await new Promise((resolveProbe, rejectProbe) => {
      const probe = connect({ host, port: productPort });
      probe.once("connect", () => {
        probe.destroy();
        resolveProbe(true);
      });
      probe.once("error", (error) => {
        if (["ECONNREFUSED", "EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) {
          resolveProbe(false);
        } else {
          rejectProbe(error);
        }
      });
      probe.setTimeout(2000, () => {
        probe.destroy();
        rejectProbe(new Error(`探测桌面端口 ${productPort} 超时。`));
      });
    });
    if (occupied) throw new Error(`桌面端口 localhost:${productPort} 已被占用（${host}）。`);
  }
  return { port: productPort };
}

async function main() {
  const { values } = parseArgs({
    options: {
      suite: { type: "string" },
      "case-dir": { type: "string" },
      "run-id": { type: "string" },
      "fixture-run-id": { type: "string" },
      "baseline-run-id": { type: "string" },
      "export-run-id": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const suite = values.suite;
  if (!suites.has(suite)) throw new Error(`请选择有效的 --suite。\n${usage}`);
  const runId = values["run-id"] ?? `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const fixtureRunId = values["fixture-run-id"] ?? runId;
  const baselineRunId = values["baseline-run-id"];
  const exportRunId = values["export-run-id"] ?? runId;
  const runIds = [runId, fixtureRunId, baselineRunId, exportRunId].filter((id) => id !== undefined);
  if (!runIds.every((id) => /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id))) {
    throw new Error("批次 ID 仅接受 1–80 个英文字母、数字、连字符或下划线，并须以字母或数字开头。");
  }

  const caseDir = values["case-dir"] === undefined ? null : resolve(values["case-dir"]);
  const defaultRoot = process.platform === "win32" ? parse(appRoot).root : tmpdir();
  const evidenceRoot = resolve(process.env.VERIFY_002_ROOT ?? join(defaultRoot, "Codex-acceptance", "k-overlay-studio", "002"));
  if (caseDir) {
    const fromCase = relative(caseDir, evidenceRoot);
    if (!isAbsolute(fromCase) && !/^\.\.(?:[/\\]|$)/.test(fromCase)) {
      throw new Error("验收输出目录须位于只读案例目录之外。");
    }
  }
  const runDir = join(evidenceRoot, runId);
  await mkdir(runDir, { recursive: true });
  const evidenceDir = join(runDir, suite);
  await mkdir(evidenceDir);

  const controller = new AbortController();
  const exitSignals = { SIGINT: 130, SIGTERM: 143 };
  const handlers = new Map(Object.entries(exitSignals).map(([name, code]) => [
    name, () => controller.abort(Object.assign(new Error(`收到 ${name}`), { exitCode: code })),
  ]));
  for (const [name, handler] of handlers) process.on(name, handler);

  const report = {
    suite, runId, fixtureRunId, baselineRunId, startedAt: new Date().toISOString(), evidenceDir,
    command: [process.execPath, ...process.argv.slice(1)],
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    case: caseDir && { directory: caseDir, type: "real-case-read-only" },
    checks: [],
    commands: [],
  };
  const context = {
    evidenceDir,
    exportDir: join(evidenceRoot, exportRunId, "export"),
    baselineDir: baselineRunId && join(evidenceRoot, baselineRunId, suite),
    caseDir,
    signal: controller.signal,
    withEditor: (inspect) => withEditor(context, inspect, { isolateUploads: true }),
    isolateWorkspace: () => isolateWorkspace(evidenceDir),
    async fixtures() {
      const dir = join(evidenceRoot, fixtureRunId, "fixtures");
      const data = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
      if (data.status !== "passed") throw new Error(`测试素材批次未通过：${fixtureRunId}`);
      return { dir, checks: data.checks, runId: fixtureRunId };
    },
    async command(program, args, options = {}) {
      const entry = { program, args };
      report.commands.push(entry);
      try {
        const result = await exec(program, args, {
          cwd: appRoot, signal: controller.signal, timeout: 120_000, ...options,
        });
        entry.exitCode = 0;
        return result.stdout;
      } catch (error) {
        entry.exitCode = error.code ?? null;
        entry.error = String(error.stderr || error.message);
        throw error;
      }
    },
    async check(name, action) {
      try {
        controller.signal.throwIfAborted();
        console.log(`checking ${name}`);
        const details = await action();
        report.checks.push({ name, status: "passed", details });
        return true;
      } catch (error) {
        report.checks.push({ name, status: "failed", error: error.message });
        return false;
      }
    },
    skip(name, reason) {
      report.checks.push({ name, status: "pending", reason });
    },
  };

  try {
    const caseReady = !caseDir || await context.check("case-directory", async () => {
      if (!(await stat(caseDir)).isDirectory()) throw new Error("案例路径须为文件夹。");
      return report.case;
    });
    const portReady = suite !== "desktop" || await context.check("desktop-port", checkProductPort);
    const run = suites.get(suite);
    if (caseReady && portReady && run) {
      await run(context);
    } else if (!run) {
      report.checks.push({ name: suite, status: "pending", reason: "此组验收由 002 后续阶段接入。" });
    }
  } catch (error) {
    report.checks.push({ name: suite, status: "failed", error: error.message });
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
    const failed = report.checks.some(({ status }) => status === "failed");
    const pending = report.checks.some(({ status }) => status === "pending");
    report.exitCode = controller.signal.reason?.exitCode ?? (failed ? 1 : pending ? 2 : 0);
    report.status = controller.signal.aborted ? "interrupted" : failed ? "failed" : pending ? "pending" : "passed";
    report.finishedAt = new Date().toISOString();
    const resultPath = join(evidenceDir, "result.json");
    await writeFile(resultPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    for (const check of report.checks) console.log(`${check.status} ${check.name} ${check.error ?? check.reason ?? ""}`.trimEnd());
    console.log(resultPath);
    process.exitCode = report.exitCode;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
