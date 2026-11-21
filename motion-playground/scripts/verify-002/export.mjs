import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { compareMedia, verifyMedia } from "./media.mjs";
import { jsonRequest, registerDirectory, verifyDestination } from "./destination.mjs";
import { openEditorPage, upload } from "./preview.mjs";

const exportInput = '.production-heading input[type=file][accept=".json,application/json"]';

async function assertTerminal(url, result) {
  const status = await jsonRequest(url, "/api/export-status");
  assert.equal(status.data.running, false);
  assert.equal(status.data.jobId, result.jobId);
  assert.deepEqual(status.data.result, result);
  return status.data;
}

async function runPanel(context, editor, doc, overlayFile, selected, manifest) {
  await openEditorPage(editor, async (page, dialogs) => {
    await page.evaluateOnNewDocument((destination) => {
      const bridge = new EventTarget();
      window.__verify002Host = { messages: [], next: "selected" };
      bridge.postMessage = (message) => {
        const state = window.__verify002Host;
        state.messages.push(message);
        if (message.type === "select-export-directory") {
          bridge.dispatchEvent(new MessageEvent("message", {
            data: { ...destination, type: "export-directory", status: state.next, error: "演练目录选择失败" },
          }));
        }
      };
      Object.defineProperty(window.chrome ??= {}, "webview", { value: bridge });
    }, selected);
    await page.reload();
    await upload(page, exportInput, overlayFile);
    await page.waitForSelector(".tlb-card");
    const open = () => page.locator(".production-editactions .production-primary").click();
    const dialog = "dialog.production-export-dialog[open]";
    const click = (text) => page.locator(`${dialog} ::-p-text(${text})`).click();
    await open();
    await page.waitForSelector(dialog);
    await context.check(`panel-${doc.aspect}-directory`, async () => {
      const choices = await page.$$eval(`${dialog} option`, (options) => options.map((item) => item.value));
      assert.equal(choices.length, doc.aspect === "16:9" ? 5 : 4);
      await click("选择文件夹");
      const output = () => page.$eval(`${dialog} output`, (element) => element.textContent);
      assert.equal(await output(), selected.path);
      await page.evaluate(() => { window.__verify002Host.next = "cancelled"; });
      await click("选择文件夹");
      assert.equal(await output(), selected.path);
      await page.evaluate(() => { window.__verify002Host.next = "error"; });
      await click("选择文件夹");
      assert.equal(await output(), selected.path);
      await page.waitForSelector(`${dialog} [role=alert]`);
      assert.equal(await page.$eval(`${dialog} .production-primary`, (button) => button.disabled), false);
      await page.evaluate(() => { window.__verify002Host.next = "selected"; });
      await click("选择文件夹");
      await page.waitForSelector(`${dialog} [role=alert]`, { hidden: true });
      const cancel = await page.locator(`${dialog} ::-p-text(取消)`).waitHandle();
      await cancel.focus();
      const before = await page.$$eval(".tlb-card", (cards) => cards.length);
      await page.keyboard.press("Delete");
      await page.keyboard.press("Escape");
      await page.waitForSelector(dialog, { hidden: true });
      assert.ok(before > 0);
      assert.equal(await page.$$eval(".tlb-card", (cards) => cards.length), before);
      return { directory: selected.path, choices, host: "测试宿主" };
    });
    if (await page.$(dialog)) {
      await page.keyboard.press("Escape");
      await page.waitForSelector(dialog, { hidden: true });
    }
    for (const fps of [24, 30]) {
      for (const resolution of ["1080p", "720p"]) {
        const label = `${doc.aspect.replace(":", "x")}-${resolution}-${fps}`;
        await context.check(`panel-${label}`, async () => {
          await open();
          await page.waitForSelector(dialog);
          await page.select(`${dialog} select`, `${resolution}:${fps}`);
          const short = resolution === "720p" ? 720 : 1080;
          const long = resolution === "720p" ? 1280 : 1920;
          const horizontal = doc.aspect === "16:9";
          const expected = {
            width: horizontal ? long : short, height: horizontal ? short : long,
            fps, rate: `${fps}/1`, frames: fps * 2, alpha: true,
          };
          assert.match(await page.$eval(dialog, (element) => element.innerText), new RegExp(`${expected.width} × ${expected.height}`));
          if (resolution === "1080p" && fps === 24) {
            await page.screenshot({ path: join(context.evidenceDir, `panel-${label}.png`) });
          }
          const submit = async () => {
            const [response] = await Promise.all([
              page.waitForResponse((response) => new URL(response.url()).pathname === "/api/export", { timeout: 240_000 }),
              click("开始导出"),
            ]);
            const result = await response.json();
            await page.waitForSelector(".production-delivery");
            return { response, result };
          };
          let { response, result } = await submit();
          let rendererRetry;
          if (!result.ok && String(result.error).includes("原始错误:TimeoutError: Navigation timeout")) {
            rendererRetry = { jobId: result.jobId, error: result.error };
            await assertTerminal(editor.url, result);
            console.log(`retrying ${label}: renderer navigation timed out`);
            await open();
            await page.waitForSelector(dialog);
            assert.equal(await page.$eval(`${dialog} select`, (select) => select.value), `${resolution}:${fps}`);
            ({ response, result } = await submit());
          }
          const request = response.request().postData() ?? await response.request().fetchPostData();
          const body = JSON.parse(request);
          assert.deepEqual(body.preset, { resolution, fps });
          assert.equal(body.doc.aspect ?? "16:9", doc.aspect);
          assert.equal(body.duration, 2);
          assert.equal(body.destinationId, selected.destinationId);
          assert.ok(result.ok && result.mov && result.webm, JSON.stringify(result));
          assert.equal(dirname(result.mov), selected.path);
          assert.equal(dirname(result.webm), selected.path);
          const status = await assertTerminal(editor.url, result);
          const notices = dialogs.splice(0);
          const unexpected = notices.filter((notice) => !notice.startsWith("💡 刚才这份「AI 排的 vs 你改完的」"));
          assert.equal(unexpected.length, 0, unexpected.join("；"));
          const mov = await verifyMedia(context, result.mov, "mov", expected);
          const webm = await verifyMedia(context, result.webm, "webm", expected);
          assert.ok(result.sfxSheet && dirname(result.sfxSheet) === selected.path);
          const remembered = await page.evaluate(() =>
            window.__verify002Host.messages.filter(({ type }) => type === "remember-export-directory").at(-1));
          assert.equal(remembered?.destinationId, selected.destinationId);
          const item = { label, aspect: doc.aspect, resolution, fps, body, result, status, mov, webm, notices, rendererRetry };
          manifest.push(item);
          return { label, jobId: result.jobId, files: result.files, frames: expected.frames, rendererRetry };
        });
      }
    }
  });
}

async function legacyAndInvalid(context, url, doc) {
  const job = { doc, duration: 0.4 };
  await context.check("invalid-presets", async () => {
    const invalid = [
      { ...job, preset: { resolution: "4k", fps: 30 } },
      { ...job, preset: { resolution: "720p", fps: 30 }, fps: 29.97 },
      { ...job, preset: { resolution: "720p", fps: "30000/1001" } },
      { ...job, preset: { resolution: "1080p", fps: 30 }, destinationId: "expired" },
    ];
    const responses = [];
    for (const body of invalid) {
      const result = await jsonRequest(url, "/api/export", body);
      assert.equal(result.status, 400);
      assert.equal(result.data.ok, false);
      responses.push(result);
    }
    return responses;
  });
  for (const fps of [undefined, 29.97]) {
    await context.check(fps === undefined ? "legacy-default-and-lock" : "legacy-horizontal-29.97", async () => {
      const ongoing = jsonRequest(url, "/api/export", { ...job, fps });
      if (fps === undefined) {
        let running = false;
        for (let i = 0; i < 100 && !running; i++) {
          running = (await jsonRequest(url, "/api/export-status")).data.running;
          if (!running) await delay(25);
        }
        assert.equal(running, true);
        const concurrent = await jsonRequest(url, "/api/export", job);
        assert.equal(concurrent.status, 429);
      }
      const { data: result } = await ongoing;
      assert.equal(result.ok, true, JSON.stringify(result));
      const status = await assertTerminal(url, result);
      assert.equal(dirname(result.mov), status.defaultDirectory);
      const expected = { width: 1920, height: 1080, frames: 12, rate: fps === undefined ? "30/1" : "30000/1001" };
      await verifyMedia(context, result.mov, "mov", expected);
      await verifyMedia(context, result.webm, "webm", expected);
      return result;
    });
  }
}

export async function verifyExport(context) {
  const fixtures = await context.fixtures();
  const session = randomUUID();
  const oldSession = process.env.OVERLAY_DESKTOP_SESSION;
  process.env.OVERLAY_DESKTOP_SESSION = session;
  const manifest = [];
  try {
    await context.withEditor(async (editor) => {
      const directory = join(context.evidenceDir, "透明成品");
      await mkdir(directory);
      const registered = await registerDirectory(editor.url, directory, session);
      let horizontal;
      for (const label of ["landscape", "portrait"]) {
        const file = join(fixtures.dir, `${label}-export-overlay.json`);
        const doc = JSON.parse(await readFile(file, "utf8"));
        if (label === "landscape") horizontal = doc;
        await context.check(`panel-${label}`, () => runPanel(context, editor, doc, file, registered, manifest));
      }
      for (const aspect of ["16:9", "9:16"]) {
        for (const fps of [24, 30]) {
          await context.check(`compose-${aspect}-${fps}`, async () => {
            const matching = manifest.filter((item) => item.aspect === aspect && item.fps === fps);
            assert.equal(matching.length, 2, "同画幅和帧率的两个清晰度均须通过");
            const pair = Object.fromEntries(matching.map(({ resolution, result }) => [resolution, result]));
            return compareMedia(context, pair, aspect === "16:9");
          });
        }
      }
      await legacyAndInvalid(context, editor.url, horizontal);
      await verifyDestination(context, {
        url: editor.url, session, directory, registered,
        sample: manifest[0]?.result,
        job: { doc: horizontal, duration: 0.4, preset: { resolution: "720p", fps: 24 } },
      });
    });
  } finally {
    if (oldSession === undefined) delete process.env.OVERLAY_DESKTOP_SESSION;
    else process.env.OVERLAY_DESKTOP_SESSION = oldSession;
    await writeFile(join(context.evidenceDir, "manifest.json"), JSON.stringify({
      type: "local-export-test-host", fixtureRunId: fixtures.runId, presets: manifest,
    }, null, 2) + "\n");
  }
  await context.check("export-matrix", () => {
    assert.equal(manifest.length, 8, "八档成品未全部通过");
    return { mov: 8, webm: 8 };
  });
}
