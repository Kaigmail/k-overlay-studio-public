import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, stat, statfs, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer";
import { importSources, saveFraming, seekVideo, upload, videoReady } from "./preview.mjs";
import { verifyMedia } from "./media.mjs";

const app = fileURLToPath(new URL("../../", import.meta.url));
const native = fileURLToPath(new URL("desktop.ps1", import.meta.url));
const url = "http://localhost:5177";
const dialog = "dialog.production-export-dialog[open]";
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function until(action, message, timeout = 35_000) {
  const end = Date.now() + timeout;
  do {
    const value = await action();
    if (value) return value;
    await delay(200);
  } while (Date.now() < end);
  throw new Error(message);
}

async function reserve(port) {
  const listener = createServer((_request, response) => {
    response.setHeader("Connection", "close");
    response.end("OK");
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", resolve);
  });
  return listener;
}

async function fetchStatus() {
  return fetch(url + "/api/export-status", { signal: AbortSignal.timeout(4000) }).then((response) => response.json());
}

export async function verifyDesktop(context, inspectEditor) {
  if (process.platform !== "win32") {
    context.skip("windows-desktop", "真实 EXE 验收需要 Windows 桌面会话。");
    return;
  }
  const workspace = await context.isolateWorkspace();
  const testDesktop = join(workspace, "desktop");
  await mkdir(testDesktop);
  await cp(join(app, "desktop", "bin"), join(testDesktop, "bin"), { recursive: true });
  await cp(join(app, "desktop", "server.mjs"), join(testDesktop, "server.mjs"));
  const exe = join(testDesktop, "bin", "K-Overlay-Studio.exe");
  const builtHash = await hash(exe);
  const reservation = await reserve(0);
  const debugPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const profile = join(context.evidenceDir, "test-profile");
  const debugUrl = "http://127.0.0.1:" + debugPort;
  const saved = join(profile, "last-export-directory.txt");
  const selected = join(context.evidenceDir, "中文成品目录");
  const displaced = join(context.evidenceDir, "中文成品目录-已移走");
  if (!inspectEditor) await mkdir(selected);
  const processes = [];
  let browser, running, page, identity;
  const dialogs = [];
  const ps = (...args) => context.command("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", ...args,
  ], { timeout: 28_000 });
  const ui = async (proc, action, ...args) => {
    const stdout = await ps("-File", native, "-HostProcessId", String(proc.pid), "-Action", action, ...args);
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const start = (port = debugPort, env = process.env) => {
    context.signal.throwIfAborted();
    const proc = spawn(exe, ["--verify", context.evidenceDir, String(port)], {
      cwd: context.evidenceDir, stdio: "ignore", env,
    });
    proc.on("error", (error) => { proc.startError = error; });
    processes.push(proc);
    return proc;
  };
  const isAlive = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const gone = (proc, timeout = 20_000) => until(
    () => proc.exitCode !== null || !isAlive(proc.pid), "桌面进程未按预期退出。", timeout,
  );
  const descendants = async (...pids) => {
    const result = await ps("-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.Name }");
    const rows = result.trim().split(/\r?\n/).map((row) => {
      const [pid, parent, name] = row.split(",");
      return { pid: Number(pid), parent: Number(parent), name };
    });
    const observed = new Set(pids);
    let previous;
    do {
      previous = observed.size;
      for (const row of rows) if (observed.has(row.parent)) observed.add(row.pid);
    } while (observed.size > previous);
    return rows.filter((row) => observed.has(row.pid));
  };
  const connect = async () => {
    await until(async () => {
      if (running.startError) throw running.startError;
      if (running.exitCode !== null) throw new Error("桌面应用提前退出。");
      return fetch(debugUrl + "/json/version").then((r) => r.ok).catch(() => false);
    }, "WebView2 调试连接未就绪，请查看桌面窗口内的启动提示。", 55_000);
    browser = await puppeteer.connect({ browserURL: debugUrl, defaultViewport: null });
    const target = await browser.waitForTarget((item) => item.type() === "page" && item.url() === url + "/", { timeout: 20_000 });
    page = await target.page();
    page.setDefaultTimeout(18_000);
    await page.waitForFunction((origin) => location.origin === origin && !!document.querySelector(".production-heading"), {}, url);
    // Keep the native dialog checks focused on the export and folder flows.
    await page.evaluate(() => localStorage.setItem("overlayStudioLearnTipCount", "3"));
    page.on("dialog", async (event) => {
      if (event.type() === "confirm") await event.accept().catch(() => {});
      else {
        const message = event.message();
        if (!message.startsWith("💡 刚才这份「AI 排的 vs 你改完的」")) dialogs.push(message);
        await event.dismiss().catch(() => {});
      }
    });
    identity = JSON.parse(await readFile(join(profile, "session-info.json"), "utf8"));
    assert.equal(identity.hostPid, running.pid);
    return identity;
  };
  const openPanel = async () => {
    await page.locator(".production-editactions .production-primary").click();
    await page.waitForSelector(dialog);
  };
  const click = (text) => page.locator(dialog + " ::-p-text(" + text + ")").click();
  const pathShown = () => page.$eval(dialog + " output", (element) => element.textContent);
  const showPath = (directory) => page.waitForFunction((expected) => (
    document.querySelector("dialog[open] output")?.textContent === expected
  ), {}, directory);
  const activatePicker = async (action, label) => {
    // A native modal may take focus before Puppeteer reports the click as complete.
    const trigger = click("选择文件夹");
    trigger.catch(() => {});
    const args = label ? ["-Picture", join(context.evidenceDir, label + ".png")] : [];
    if (action === "select") args.push("-Folder", selected);
    let result;
    try {
      [result] = await Promise.all([ui(running, action, ...args), trigger]);
    } catch (error) {
      const alert = await page.$eval(dialog + " [role=alert]", (element) => element.textContent).catch(() => "");
      await page.screenshot({ path: join(context.evidenceDir, "picker-error.png") }).catch(() => {});
      throw new Error(alert ? error.message + "\n" + alert : error.message);
    }
    assert.equal(result.title, "选择动效成品文件夹");
    return result;
  };
  const close = async (choice) => {
    const ids = await descendants(running.pid, identity.servicePid, identity.webviewPid);
    await ui(running, "close");
    if (choice) {
      const result = await ui(running, choice, "-ExpectedTitle", "导出进行中");
      assert.equal(result.title, "导出进行中");
    }
    await gone(running, choice === "wait" ? 120_000 : undefined);
    browser.disconnect();
    browser = undefined;
    await until(() => ids.every(({ pid }) => !isAlive(pid)), "退出后仍可找到属于该桌面的进程。", 25_000);
    const temporary = await readdir(join(workspace, "exports"));
    assert.ok(temporary.every((name) => !name.startsWith(".desktop-")), "桌面临时导出目录未回收。");
    return ids;
  };

  try {
    if (inspectEditor) {
      const available = await reserve(5177);
      await new Promise((resolve) => available.close(resolve));
    } else {
      const portCase = await context.check("desktop-foreign-port", async () => {
        const external = await reserve(5177);
        const blocked = start(0);
        try {
          const info = await until(async () => {
            const current = await ui(blocked, "inspect");
            return current.texts.some((line) => line.includes("5177 已被其他程序占用")) && current;
          }, "窗口没有说明 5177 端口被占用。", 5000);
          await ui(blocked, "close");
          await gone(blocked);
          assert.equal(external.listening, true);
          const response = await fetch("http://127.0.0.1:5177/", { signal: AbortSignal.timeout(3000) });
          assert.equal(await response.text(), "OK");
          return info;
        } finally {
          external.closeAllConnections();
          await new Promise((resolve) => external.close(resolve));
        }
      });
      if (!portCase) return;

      await context.check("desktop-missing-node", async () => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
        const missing = start(0, { ...env, Path: join(process.env.SystemRoot, "System32") });
        try {
          const info = await until(async () => {
            const state = await ui(missing, "inspect");
            return state.texts.some((line) => !line.includes("正在启动")) && state;
          }, "窗口没有显示启动结果。", 10_000);
          assert.ok(info.texts.some((line) => line.includes("找不到 Node.js")), info.texts.join("；"));
          return info;
        } finally {
          if (isAlive(missing.pid)) await ui(missing, "close");
          await gone(missing);
        }
      });

      await context.check("desktop-debug-off-by-default", async () => {
        const standard = start(0);
        await until(() => fetchStatus().catch(() => false), "常规桌面服务未启动。", 45_000);
        const children = await until(async () => {
          const current = await descendants(standard.pid);
          return current.some(({ name }) => name.toLowerCase() === "msedgewebview2.exe") && current;
        }, "常规桌面 WebView2 未启动。");
        for (const { pid, name } of children) {
          assert.ok(!["msedge.exe", "chrome.exe", "firefox.exe"].includes(name.toLowerCase()), "桌面启动了外部浏览器。");
          if (name.toLowerCase() === "msedgewebview2.exe") {
            const args = await ps("-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`);
            assert.doesNotMatch(args, /--remote-debugging-(?:port|pipe)/i);
          }
        }
        await ui(standard, "close");
        await gone(standard);
        await until(() => children.every(({ pid }) => !isAlive(pid)), "常规退出后仍有自有进程。", 25_000);
        return { processes: children, testDebuggingEnabled: false };
      });

    }

    running = start();
    const started = await context.check("desktop-exe-launch", async () => {
      await connect();
      await page.waitForSelector(".production-heading");
      const info = await ui(running, "inspect", "-Picture", join(context.evidenceDir, "desktop-window.png"));
      assert.equal(info.title, "K-Overlay-Studio");
      assert.ok(info.iconWidth > 0 && info.handle > 0);
      const before = await page.evaluate(() => ({
        width: window.innerWidth, height: window.innerHeight, webview: Boolean(window.chrome?.webview),
      }));
      assert.ok(before.webview && before.width >= 760);
      const forbidden = await fetch(url + "/api/desktop-session");
      assert.equal(forbidden.status, 403);
      return { ...info, ...before, identity, binarySha256: builtHash, workingDirectory: context.evidenceDir };
    });
    if (!started) return;
    if (inspectEditor) {
      await context.check("desktop-editor-fields", () => inspectEditor(page, (action, ...args) => ui(running, action, ...args)));
      await context.check("desktop-shutdown", () => close());
      return;
    }
    await context.check("desktop-single-instance", async () => {
      await ui(running, "minimize");
      const minimized = await until(async () => {
        const state = await ui(running, "inspect");
        return state.minimized && state;
      }, "无法最小化主窗。");
      const second = start();
      await gone(second);
      const restored = await until(async () => {
        const state = await ui(running, "inspect");
        return !state.minimized && state;
      }, "重复启动未唤醒主窗。");
      assert.equal(restored.handle, minimized.handle);
      return { secondPid: second.pid, restored };
    });

    await context.check("desktop-native-subtitle-output", async () => {
      const folder = join(context.evidenceDir, "字幕和成品");
      await mkdir(folder);
      const srt = join(folder, "口播字幕.srt");
      await writeFile(srt, "1\n00:00:00,000 --> 00:00:01,000\n测试原始字幕路径\n", { flag: "wx" });
      const doc = { version: 1, aspect: "9:16", cards: [
        { id: "manual-placement", kind: "chapter-bar", start: 0, end: 2, params: { chapters: "测试章节 0" } },
      ], handoff: { srt: "口播字幕.srt", srtSha256: await hash(srt), missing: [] } };
      await page.locator("::-p-text(选择 SRT 文件)").click();
      const picked = await ui(running, "select", "-ExpectedTitle", "选择口播字幕", "-Folder", srt);
      const first = join(folder, "口播字幕-动效-Agent-01.json");
      const second = join(folder, "口播字幕-动效-Agent-02.json");
      const showHandoff = (file) => page.waitForFunction((srtPath, agentPath) => {
        const prompt = document.querySelector('textarea[aria-label="Agent 指令"]')?.value;
        return prompt?.includes(srtPath) && prompt.includes(agentPath);
      }, {}, srt, file);
      await page.locator("::-p-text(查看指令)").click();
      await showHandoff(first);
      await writeFile(first, JSON.stringify(doc), { flag: "wx" });
      await page.locator("::-p-text(新一轮编排)").click();
      await showHandoff(second);
      await writeFile(second, JSON.stringify(doc), { flag: "wx" });
      await page.locator(".production-actions button::-p-text(读取编排结果)").click();
      await page.locator("::-p-text(应用到时间轴)").click();
      assert.equal(await hash(first), await hash(second));
      const chapter = await page.waitForSelector(".stage [data-chapter-drag] .chapter-plate", { visible: true });
      await delay(750);
      const { x, y, width, height } = await chapter.boundingBox();
      await page.mouse.move(x + width / 2, y + height / 2);
      await page.mouse.down();
      await page.mouse.move(x + width / 2, y + height / 2 + 95, { steps: 8 });
      await page.mouse.up();
      const moved = await chapter.boundingBox();
      assert.ok(moved.y > y + 75, "章节条未跟随鼠标移出默认区域。");
      await openPanel();
      await showPath(folder);
      assert.equal(await page.$eval(dialog + " select", (element) => getComputedStyle(element).colorScheme), "dark");
      await click("取消");
      await page.locator(".production-editactions ::-p-text(导出编排 JSON)").click();
      const output = join(folder, "口播字幕-动效编排.json");
      await until(async () => (await stat(output).catch(() => null))?.isFile(), "编排 JSON 没有写到原始字幕同级目录。");
      const edited = JSON.parse(await readFile(output, "utf8")).cards[0];
      assert.equal(edited.id, doc.cards[0].id);
      assert.ok(edited.params.manualY > 0, "手调位置没有写入 JSON。");
      await page.locator("::-p-text(恢复默认位置)").click();
      await page.waitForFunction((top) => Math.abs(document.querySelector(".stage .chapter-plate").getBoundingClientRect().top - top) < 3, {}, y);
      await page.reload();
      return { picked, folder, output };
    });

    if (!context.caseDir) {
      context.skip("desktop-case", "未提供 --case-dir。");
      await context.check("desktop-shutdown", () => close());
      return;
    }
    const files = await readdir(context.caseDir);
    const [video] = files.filter((name) => /\.mp4$/i.test(name));
    const [overlay] = files.filter((name) => /\.json$/i.test(name));
    assert.ok(video && overlay, "缺少佩雷斯 MP4 或编排 JSON。");
    const source = join(context.caseDir, video);
    const docFile = join(context.caseDir, overlay);
    const inputHashes = await Promise.all([hash(source), hash(docFile)]);
    const doc = JSON.parse((await readFile(docFile, "utf8")).replace(/^\uFEFF/, ""));
    const decoded = await context.check("desktop-real-hevc-preview", async () => {
      await importSources(page, source, docFile, "json-first");
      let info;
      try {
        info = await videoReady(page, dialogs);
      } catch (error) {
        await page.screenshot({ path: join(context.evidenceDir, "hevc-failure.png") }).catch(() => {});
        throw error;
      }
      const timing = await seekVideo(page, 12.25, info.duration);
      const frame = await saveFraming(context, page, source, info, timing, "desktop-hevc");
      return { ...frame, sourceSha256: inputHashes[0], overlaySha256: inputHashes[1] };
    });
    const end = 2;
    const excerpt = {
      ...doc,
      cards: doc.cards.filter((card) => card.start < end).map((card) => ({ ...card, end: Math.min(card.end, end) })),
    };
    const excerptFile = join(context.evidenceDir, "peres-intro-excerpt.json");
    await writeFile(excerptFile, JSON.stringify(excerpt, null, 2) + "\n", { flag: "wx" });
    await upload(page, '.topbar input[type=file][accept=".json,application/json"]', excerptFile);
    await page.waitForFunction((count) => document.querySelectorAll(".tlb-card").length === count, {}, excerpt.cards.length);
    await openPanel();
    const picked = await context.check("desktop-native-directory", async () => {
      const chosen = await activatePicker("select", "native-folder-picker");
      await showPath(selected);
      const cancelled = await activatePicker("cancel", "native-folder-cancel");
      assert.equal(await pathShown(), selected);
      return { chosen, cancelled, selected };
    });
    if (!decoded || !picked) return;

    const exported = await context.check("desktop-real-dual-export", async () => {
      const duration = Math.max(...excerpt.cards.map((card) => card.end)) + 0.5;
      const disk = await statfs(workspace);
      const freeBytes = disk.bavail * disk.bsize;
      assert.ok(freeBytes > duration * 43 * 1024 ** 2 + 2 * 1024 ** 3, "工作盘余量不足以运行真实编排导出。");
      await page.select(dialog + " select", "720p:24");
      const response = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/export", { timeout: 10 * 60_000 });
      response.catch(() => {});
      await click("开始导出");
      const res = await response;
      const result = await res.json();
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(dirname(result.mov), selected);
      assert.equal(dirname(result.webm), selected);
      const request = JSON.parse(res.request().postData() ?? await res.request().fetchPostData());
      assert.equal(request.duration, duration);
      const specification = { width: 720, height: 1280, fps: 24, rate: "24/1", frames: Math.ceil(duration * 24) };
      const [mov, webm] = await Promise.all([
        verifyMedia(context, result.mov, "mov", specification),
        verifyMedia(context, result.webm, "webm", specification),
      ]);
      for (const [format, file] of [["mov", result.mov], ["webm", result.webm]]) {
        const alpha = await context.command("ffmpeg", [
          "-v", "error", ...(format === "webm" ? ["-c:v", "libvpx-vp9"] : []), "-i", file,
          "-vf", "alphaextract,scale=90:160", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
        ], { encoding: "buffer", maxBuffer: 2 * 1024 * 1024 });
        assert.equal(alpha.length, specification.frames * 90 * 160);
        assert.ok(alpha.some((pixel) => pixel < 5) && alpha.some((pixel) => pixel > 80), `${format} 缺少透明底或可见动效`);
      }
      assert.deepEqual(await Promise.all([hash(source), hash(docFile)]), inputHashes);
      assert.equal(await until(() => readFile(saved, "utf8").catch(() => null), "导出完成后未保存所选目录。"), selected);
      await page.screenshot({ path: join(context.evidenceDir, "desktop-delivery.png") });
      return {
        freeBytes, duration, specification, mov, webm, jobId: result.jobId,
        input: { source, docFile, excerptFile, excerptSha256: await hash(excerptFile), range: [0, end] },
      };
    });
    if (!exported) return;
    await context.check("desktop-shutdown", () => close());
    if (running.exitCode === null) return;
    running = start();
    await connect();
    await context.check("desktop-directory-restored", async () => {
      await page.locator("::-p-text(恢复上次草稿)").click();
      await openPanel();
      await showPath(selected);
      await rename(selected, displaced);
      const upcoming = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/export");
      upcoming.catch(() => {});
      await click("开始导出");
      const result = await (await upcoming).json();
      assert.equal(result.ok, false);
      assert.match(result.error, /失效|不可写/);
      await openPanel();
      assert.equal(await page.$eval(dialog + " .production-primary", (button) => button.disabled), true);
      await rename(displaced, selected);
      await activatePicker("select");
      await page.waitForSelector(dialog + " [role=alert]", { hidden: true });
      await showPath(selected);
      await page.waitForFunction(() => !document.querySelector("dialog[open] .production-primary")?.disabled);
      return { restartedPid: running.pid, restored: selected, invalidPathError: result.error };
    });

    const cancelled = await context.check("desktop-cancel-active-export", async () => {
      await page.keyboard.press("Escape");
      await upload(page, '.topbar input[type=file][accept=".json,application/json"]', docFile);
      await page.waitForFunction((count) => document.querySelectorAll(".tlb-card").length === count, {}, doc.cards.length);
      await openPanel();
      await page.select(dialog + " select", "1080p:30");
      await click("开始导出");
      const state = await until(async () => {
        const current = await fetchStatus();
        return current.stage === "extract" && current;
      }, "未观察到进行中的视频抽帧。");
      const ids = await close("confirm");
      assert.ok(ids.some(({ name, pid }) => name.toLowerCase() === "node.exe" && pid !== identity.servicePid), "没有记录到导出子进程。");
      const entries = await readdir(selected);
      assert.equal(entries.filter((file) => /\.(mov|webm)$/i.test(file)).length, 2, "取消后出现额外成品。");
      const caches = join(workspace, "public", "_fxframes");
      for (const cache of await readdir(caches)) {
        assert.ok((await stat(join(caches, cache, "manifest.json"))).isFile(), "取消抽帧后留下未完成的缓存。");
      }
      return { cancelledJobId: state.jobId, observedStage: state.stage, reaped: ids, completeCachesOnly: true };
    });
    if (!cancelled) return;
    running = start();
    await connect();
    await context.check("desktop-wait-for-active-export", async () => {
      const completion = fetch(url + "/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: excerpt, duration: 0.5, preset: { resolution: "720p", fps: 24 } }),
      }).then((res) => res.json());
      completion.catch(() => {});
      const active = await until(async () => {
        const state = await fetchStatus();
        return state.running && state;
      }, "未观察到等待退出所用的导出任务。");
      await ui(running, "close");
      const stayed = await ui(running, "stay", "-ExpectedTitle", "导出进行中");
      assert.equal(stayed.title, "导出进行中");
      assert.ok((await fetchStatus()).running, "返回编辑台后导出没有继续。");
      const ids = await close("wait");
      const outcome = await completion;
      assert.equal(outcome.jobId, active.jobId);
      assert.ok(outcome.ok && (await stat(outcome.mov)).size && (await stat(outcome.webm)).size);
      return { jobId: active.jobId, mov: outcome.mov, webm: outcome.webm, reaped: ids };
    });
    if (running.exitCode === null) return;
    await context.check("desktop-default-directory-after-restart", async () => {
      assert.equal(await stat(saved).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }), null, "默认目录导出成功后仍保存着旧的自选目录。");
      running = start();
      await connect();
      await page.locator("::-p-text(恢复上次草稿)").click();
      await openPanel();
      const expected = join(workspace, "exports", "output");
      await showPath(expected);
      assert.equal(await pathShown(), expected);
      return { restoredDefault: expected, reaped: await close() };
    });
  } finally {
    if (browser?.connected) browser.disconnect();
    for (const proc of processes) {
      if (!proc.pid || !isAlive(proc.pid)) continue;
      try { await ui(proc, "close"); await gone(proc); }
      catch { if (isAlive(proc.pid)) proc.kill(); }
    }
    if (await stat(displaced).catch(() => null)) await rename(displaced, selected);
  }
}
