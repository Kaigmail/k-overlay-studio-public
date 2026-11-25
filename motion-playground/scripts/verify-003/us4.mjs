import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openEditorPage, upload, videoReady } from "../verify-002/preview.mjs";
import { locateInputs } from "./baseline.mjs";

const command = promisify(execFile);
const prepInput = '.production-heading input[accept=".json,application/json"]';
const editorInput = '.topbar input[accept=".json,application/json"]';
const loopButton = ".tlb-loop-btn";
const draftKey = "overlayStudioAutosave";

function button(page, label) {
  return page.locator(`button::-p-text(${label})`);
}

async function draft(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), draftKey);
}

async function waitSaved(page, revision = -1) {
  await page.waitForFunction((key, previous) =>
    document.querySelector('[data-draft-status="saved"]') &&
    JSON.parse(localStorage.getItem(key))?.revision > previous, {}, draftKey, revision);
  return draft(page);
}

async function reopenEditor(page, url, dialogs) {
  const next = await page.browserContext().newPage();
  next.setDefaultTimeout(12_000);
  await next.setCacheEnabled(false);
  await next.setViewport(page.viewport());
  next.on("dialog", async (dialog) => {
    if (dialog.type() === "confirm") await dialog.accept();
    else {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    }
  });
  await page.close();
  await next.goto(new URL("/index.html", url).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await next.waitForSelector(prepInput);
  return next;
}

async function restore(page, expectedName) {
  await page.waitForSelector(".production-heading nav");
  const info = await page.$eval(".production-heading nav", (nav) =>
    [...nav.querySelectorAll("button")].find((item) => item.textContent.includes("恢复上次草稿"))?.textContent.trim());
  assert.ok(info?.includes(expectedName), info);
  await button(page, "恢复上次草稿").click();
  await page.waitForSelector('[data-draft-status="saved"]');
  return info.replace(/\s+/g, " ");
}

async function verifyDrafts(context, file) {
  let report;
  const production = join(context.evidenceDir, "production");
  const subtitle = join(context.evidenceDir, "本期字幕.srt");
  await mkdir(production);
  await writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,500\n这句字幕随空稿保留\n");
  let step = "读取目录";
  await openEditorPage(context, async (page, dialogs) => {
    try {
      await page.locator(".production-path input[placeholder]").fill(production);
      await button(page, "读取目录").click();
      await page.waitForSelector(".production-meta strong");
      await upload(page, prepInput, file);
      await page.waitForSelector(".tlb-card");
      await upload(page, '.panel-left input[accept=".srt"]', subtitle);
      await page.waitForSelector('.tlb-card[data-card-id="caption-track-2"]');
      const initial = await waitSaved(page);
      assert.equal(initial.overlay.cards.length, 2);
      step = "恢复第一份草稿";
      page = await reopenEditor(page, context.url, dialogs);
      const label = await restore(page, "production");
      assert.ok(label.includes(String(new Date(initial.savedAt).getFullYear())));
      assert.equal((await draft(page)).savedAt, initial.savedAt, "打开草稿沿用上次实际写入时间");

      step = "返回准备页";
      await page.locator(".production-editbar button::-p-text(准备页)").click();
      await page.locator(".production-path input[placeholder]").fill(production);
      await button(page, "读取目录").click();
      await page.waitForSelector(".production-meta strong");
      await upload(page, prepInput, file);
      await page.waitForSelector('.tlb-card[data-card-id="draft-target"]');
      await upload(page, '.panel-left input[accept=".srt"]', subtitle);
      await page.waitForSelector('.tlb-card[data-card-id="caption-track-2"]');
      step = "等待第二份草稿";
      const beforeFailure = await waitSaved(page, initial.revision);
      await page.evaluate((key) => {
        const write = Storage.prototype.setItem;
        window.__verifyDraftWrites = 0;
        Storage.prototype.setItem = function (name, ...args) {
          if (name === key && window.__verifyDraftWrites++ === 0) throw new Error("模拟本机存储写入失败");
          return write.call(this, name, ...args);
        };
      }, draftKey);
      step = "删除两张卡";
      for (const id of ["draft-target", "caption-track-2"]) {
        await page.locator(`.fx-item[data-card-id="${id}"]`).click();
        await page.keyboard.press("Delete");
        await page.waitForSelector(`.tlb-card[data-card-id="${id}"]`, { hidden: true });
      }
      step = "等待写入失败";
      await page.waitForSelector('[data-draft-status="failed"]');
      assert.equal((await draft(page)).savedAt, beforeFailure.savedAt);
      step = "交付零卡 JSON";
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url().endsWith("/api/production/save-json")),
        page.waitForResponse((item) => item.url().endsWith("/api/review-log")),
        button(page, "导出编排 JSON").click(),
      ]);
      const delivered = await response.json();
      assert.ok(response.ok(), JSON.stringify(delivered));
      assert.deepEqual(JSON.parse(await readFile(delivered.path, "utf8")).cards, []);
      await page.waitForFunction(() => document.querySelector("[data-json-delivery]")?.textContent.includes("已交付"));
      await page.waitForSelector('[data-draft-status="failed"]');
      await page.screenshot({ path: join(context.evidenceDir, "draft-failed-json-delivered.png") });
      step = "重试草稿";
      await button(page, "重试保存草稿").click();
      const empty = await waitSaved(page, beforeFailure.revision);
      assert.ok(Date.parse(empty.savedAt) > Date.parse(beforeFailure.savedAt));
      assert.deepEqual(empty.overlay.cards, []);
      assert.equal(empty.srt[0].text, "这句字幕随空稿保留");
      assert.equal(empty.project.id, beforeFailure.project.id);
      step = "恢复空稿";
      page = await reopenEditor(page, context.url, dialogs);
      await restore(page, "production");
      await button(page, "字幕稿 1").click();
      await page.waitForSelector(".srt-text");
      assert.match(await page.$eval(".srt-text", (node) => node.textContent), /这句字幕随空稿保留/);
      assert.equal((await page.$$(".tlb-card")).length, 0);
      await page.screenshot({ path: join(context.evidenceDir, "draft-empty-restored.png") });

      await page.locator(".production-editbar button::-p-text(准备页)").click();
      step = "打开示例";
      await button(page, "打开示例").click();
      await page.waitForSelector(".tlb-card");
      page = await reopenEditor(page, context.url, dialogs);
      assert.deepEqual(await draft(page), empty, "示例不能覆盖正式草稿");
      step = "重开交付 JSON";
      await upload(page, prepInput, delivered.path);
      await waitSaved(page, empty.revision);
      assert.equal((await page.$$(".tlb-card")).length, 0, "交付稿须能通过普通导入重开");

      step = "迟到的目录交付响应";
      await page.locator(".production-editbar button::-p-text(准备页)").click();
      await page.locator(".production-path input[placeholder]").fill(production);
      await button(page, "读取目录").click();
      await page.waitForSelector(".production-meta strong");
      await upload(page, prepInput, file);
      await page.waitForSelector('.tlb-card[data-card-id="draft-target"]');
      const beforeEdit = await waitSaved(page, empty.revision);
      await page.evaluate(() => {
        const fetchOriginal = window.fetch;
        window.fetch = async (...args) => {
          const response = await fetchOriginal(...args);
          if (args[0] === "/api/production/save-json") {
            const parse = response.json.bind(response);
            response.json = async () => {
              const payload = await parse();
              window.__lateDeliveryParsed = true;
              return payload;
            };
            window.__lateDeliveryParsed = false;
            await new Promise((resolve) => { window.__releaseDelivery = resolve; });
          }
          return response;
        };
      });
      const startDelivery = async () => {
        await button(page, "导出编排 JSON").click();
        await page.waitForFunction(() => typeof window.__releaseDelivery === "function");
      };
      const releaseDelivery = async () => {
        await page.evaluate(() => {
          window.__releaseDelivery();
          delete window.__releaseDelivery;
        });
        await page.waitForFunction(() => window.__lateDeliveryParsed === true);
        await page.waitForSelector("[data-json-delivery]", { hidden: true });
      };

      step = "同一期编辑后旧交付回调";
      await startDelivery();
      await page.keyboard.press("Delete");
      await page.waitForSelector('[data-card-id="draft-target"]', { hidden: true });
      const afterEdit = await waitSaved(page, beforeEdit.revision);
      assert.deepEqual(afterEdit.overlay.cards, []);
      await releaseDelivery();
      assert.deepEqual(await draft(page), afterEdit);
      await button(page, "撤销").click();
      await page.waitForSelector('.tlb-card[data-card-id="draft-target"]');
      const beforeSwitch = await waitSaved(page, afterEdit.revision);

      step = "迟到的目录交付响应";
      await startDelivery();
      step = "等待切稿后的草稿写入";
      await upload(page, editorInput, delivered.path);
      await page.waitForSelector(".tlb-card", { hidden: true });
      const afterSwitch = await waitSaved(page, beforeSwitch.revision);
      assert.notEqual(afterSwitch.project.id, beforeSwitch.project.id);
      step = "等待旧交付响应被读取";
      await releaseDelivery();
      assert.deepEqual(await draft(page), afterSwitch);

      step = "显式清空";
      await button(page, "清空").click();
      await page.waitForFunction((key) => !localStorage.getItem(key), {}, draftKey);
      await page.locator(".production-editbar button::-p-text(准备页)").click();
      assert.equal(await page.$('button::-p-text(恢复上次草稿)'), null);
      assert.deepEqual(dialogs, []);
      report = { label, delivered: delivered.path, beforeFailure: beforeFailure.savedAt, afterRetry: empty.savedAt,
        latestRevision: empty.revision, emptyCards: empty.overlay.cards.length, subtitle: empty.srt[0].text,
        lateDeliveryIgnored: true, sameProjectLateDeliveryIgnored: true, explicitClear: true };
    } catch (error) {
      if (!page.isClosed()) await page.screenshot({ path: join(context.evidenceDir, "draft-failure.png") });
      throw new Error(`草稿验收「${step}」：${error.stack}`, { cause: error });
    }
  });
  return report;
}

async function observeWraps(page, first, endExclusive, withVideo) {
  return page.evaluate(({ first, endExclusive, withVideo }) => new Promise((resolve, reject) => {
    const video = document.querySelector(".stage-video");
    const samples = [];
    const wraps = [];
    const presented = [];
    const started = performance.now();
    let videoRequest;
    if (video) {
      const capture = (_, metadata) => {
        presented.push(metadata.mediaTime);
        videoRequest = video.requestVideoFrameCallback(capture);
      };
      videoRequest = video.requestVideoFrameCallback(capture);
    }
    const finish = (error) => {
      if (videoRequest) video.cancelVideoFrameCallback(videoRequest);
      if (error) reject(new Error(error));
      else resolve({ samples, wraps, presented, muted: video?.muted });
    };
    let previous;
    const tick = (now) => {
      const frame = Number(document.querySelector("[data-frame-index]").dataset.frameIndex);
      const shown = [...document.querySelectorAll(".stage [data-card-id]:not([data-past])")]
        .filter((item) => getComputedStyle(item).visibility !== "hidden")
        .map((item) => item.dataset.cardId);
      if (frame !== previous || !samples.length) {
        const sample = { frame, shown, videoTime: video?.currentTime };
        samples.push(sample);
        if (previous > frame) wraps.push(sample);
        previous = frame;
      }
      if (wraps.length >= 2 && (!withVideo || presented.filter((time, index) => index > 0 && time < presented[index - 1]).length >= 2)) {
        return finish();
      }
      if (now - started > 10_000) return finish(`循环取样超时 ${JSON.stringify({ first, endExclusive, samples, wraps })}`);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { first, endExclusive, withVideo });
}

async function verifyLoop(context, file, videoFile) {
  let report;
  const withVideo = !!videoFile;
  const target = withVideo ? "tail-target" : "middle-target";
  const first = withVideo ? 48 : 15;
  const endExclusive = withVideo ? 90 : 45;
  await openEditorPage(context, async (page, dialogs) => {
    await upload(page, prepInput, file);
    await page.waitForSelector(".tlb-card");
    if (videoFile) {
      await upload(page, '.topbar input[accept="video/*"]', videoFile);
      await videoReady(page, dialogs);
      assert.ok(await page.$eval(".stage-video", (video) => Math.abs(video.duration - 3) < 0.05));
    }
    assert.equal(await page.$eval(loopButton, (item) => item.getAttribute("aria-pressed")), "false");
    await page.locator('.fx-item[data-card-id="tiny"]').click();
    assert.equal(await page.$eval(loopButton, (item) => item.disabled), true);
    await page.waitForFunction(() => document.querySelector(".tlb-loop").textContent.includes("没有可播放的成品帧"));
    await page.locator(`.fx-item[data-card-id="${target}"]`).click();
    await page.locator(loopButton).click();
    await page.waitForSelector(`[data-loop-card="${target}"]`);
    const pausedAt = await page.evaluate(() => {
      const frame = Number(document.querySelector("[data-frame-index]").dataset.frameIndex);
      document.querySelector('.fx-item[data-card-id="witness"]').click();
      return frame;
    });
    await page.waitForSelector('.tlb-card.is-sel[data-card-id="witness"]');
    assert.equal(await page.$eval("[data-loop-card]", (item) => item.dataset.loopCard), target);
    const playButton = page.locator(".topbar button::-p-text(播放)");
    await playButton.wait();
    assert.equal(await page.$eval("[data-frame-index]", (item) => Number(item.dataset.frameIndex)), pausedAt);
    await playButton.click();
    const trace = await observeWraps(page, first, endExclusive, withVideo);
    assert.equal(trace.wraps.length, 2);
    assert.ok(trace.samples.every(({ frame }) => frame >= first && frame < endExclusive), JSON.stringify(trace.samples));
    assert.ok(trace.wraps.every(({ frame }) => frame === first), JSON.stringify(trace.wraps));
    assert.ok(trace.samples.some(({ shown }) => shown.includes(target) && shown.includes("witness")));
    assert.ok(Math.max(...trace.samples.map(({ frame }) => frame)) >= endExclusive - 4);
    if (withVideo) {
      assert.equal(trace.muted, false);
      const presentedWraps = trace.presented.filter((time, index) => index && time < trace.presented[index - 1]);
      assert.ok(presentedWraps.length === 2 && presentedWraps.every((time) => Math.abs(time - first / 30) < 0.11), JSON.stringify(presentedWraps));
      assert.ok(trace.wraps.every(({ videoTime }) => Math.abs(videoTime - first / 30) < 0.11));
    }
    await page.screenshot({ path: join(context.evidenceDir, `loop-${withVideo ? "video" : "timeline"}.png`) });
    await page.waitForFunction((first) =>
      Number(document.querySelector("[data-frame-index]").dataset.frameIndex) < first + 8, {}, first);
    const exit = await page.evaluate(async () => {
      const index = () => Number(document.querySelector("[data-frame-index]").dataset.frameIndex);
      const before = index();
      document.querySelector(".tlb-loop-btn").click();
      await new Promise(requestAnimationFrame);
      return { before, after: index() };
    });
    assert.ok(exit.after >= exit.before && exit.after <= exit.before + 3, JSON.stringify(exit));
    await page.waitForSelector("[data-loop-card]", { hidden: true });
    await page.waitForFunction((end) => Number(document.querySelector("[data-frame-index]").dataset.frameIndex) >= end,
      {}, withVideo ? endExclusive - 1 : endExclusive);

    if (!withVideo) {
      await page.locator(`.fx-item[data-card-id="${target}"]`).click();
      await page.locator(loopButton).click();
      await page.waitForSelector("[data-loop-card]");
      await page.keyboard.press("Delete");
      await page.waitForSelector(`.tlb-card[data-card-id="${target}"]`, { hidden: true });
      await page.waitForSelector("[data-loop-card]", { hidden: true });
      assert.equal(await page.$eval(loopButton, (item) => item.disabled), true);
      await page.locator('.fx-item[data-card-id="witness"]').click();
      await page.locator(loopButton).click();
      await page.waitForSelector('[data-loop-card="witness"]');
      await upload(page, editorInput, file);
      await page.waitForSelector(`.tlb-card[data-card-id="${target}"]`);
      await page.waitForSelector("[data-loop-card]", { hidden: true });
    }
    assert.deepEqual(dialogs, []);
    report = { target, firstFrame: first, endExclusive, exit, trace };
  });
  return report;
}

async function verifyLegacyDraft(context, file) {
  const legacy = {
    overlay: JSON.parse(await readFile(file, "utf8")),
    origin: null,
    srt: [{ start: 0, end: 1, text: "旧草稿字幕" }],
    savedAt: "2026-11-23T12:00:00.000Z",
  };
  const subtitle = join(context.evidenceDir, "手动编排字幕.srt");
  await writeFile(subtitle, "1\n00:00:00,000 --> 00:00:01,000\n启用本次正式草稿\n");
  await openEditorPage(context, async (page, dialogs) => {
    await page.evaluate((key, saved) => localStorage.setItem(key, JSON.stringify(saved)), draftKey, legacy);
    page = await reopenEditor(page, context.url, dialogs);
    await restore(page, "本机草稿");
    await page.waitForSelector('.tlb-card[data-card-id="draft-target"]');
    page = await reopenEditor(page, context.url, dialogs);
    await button(page, "手动编排").click();
    await page.waitForSelector(".production-editor:not([hidden])");
    await page.locator(".topbar button::-p-text(示例)").click();
    await page.waitForSelector(".tlb-card");
    await button(page, "撤销").click();
    await page.waitForSelector(".tlb-card", { hidden: true });
    page = await reopenEditor(page, context.url, dialogs);
    assert.deepEqual(await draft(page), legacy, "只打开空白手动编排，不应覆盖上一份正式草稿");
    await restore(page, "本机草稿");
    await button(page, "字幕稿 1").click();
    assert.equal(await page.$eval(".srt-text", (item) => item.textContent), "旧草稿字幕");

    await page.evaluate((key, saved) => localStorage.setItem(key, JSON.stringify({
      ...saved, overlay: { ...saved.overlay, cards: [] },
    })), draftKey, legacy);
    page = await reopenEditor(page, context.url, dialogs);
    await restore(page, "本机草稿");
    await page.evaluate(() => {
      window.__restartPrompts = [];
      window.confirm = (message) => {
        window.__restartPrompts.push(message);
        return false;
      };
    });
    await button(page, "重新开始").click();
    const prompts = await page.evaluate(() => window.__restartPrompts);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /放弃尚未导出的手调稿/);
    assert.equal((await draft(page)).srt[0].text, "旧草稿字幕");

    page = await reopenEditor(page, context.url, dialogs);
    await button(page, "手动编排").click();
    await page.waitForSelector(".production-editor:not([hidden])");
    await upload(page, '.panel-left input[accept=".srt"]', subtitle);
    await page.waitForSelector('.tlb-card[data-card-id="caption-track-1"]');
    const edited = await waitSaved(page);
    await button(page, "撤销").click();
    const blank = await waitSaved(page, edited.revision);
    assert.equal(blank.project.id, edited.project.id);
    assert.deepEqual(blank.overlay.cards, []);
    assert.equal(blank.srt, null);
    assert.deepEqual(dialogs, []);
  });
  return { legacyRestored: true, blankManualPreservedDraft: true, subtitleOnlyProtected: true, undoToBlankSaved: true };
}

async function verifyLateFiles(context, file) {
  await openEditorPage(context, async (page, dialogs) => {
    await upload(page, prepInput, file);
    await page.waitForSelector('.tlb-card[data-card-id="draft-target"]');
    await page.evaluate(() => {
      const read = File.prototype.text;
      window.__releaseReads = {};
      File.prototype.text = async function () {
        if (this.name.startsWith("慢")) {
          await new Promise((resolve) => { window.__releaseReads[this.name] = resolve; });
        }
        return read.call(this);
      };
      window.__dropEditorFile = (name, contents) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([contents], name));
        document.querySelector(".production-editor").dispatchEvent(new DragEvent("drop", {
          dataTransfer, bubbles: true, cancelable: true,
        }));
      };
    });
    const drop = (name, text) => page.evaluate((name, text) => window.__dropEditorFile(name, text), name, text);
    const waitRead = (name) => page.waitForFunction((name) => !!window.__releaseReads[name], {}, name);
    const release = (name) => page.evaluate(async (name) => {
      window.__releaseReads[name]();
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    }, name);
    const subtitle = (text) => `1\n00:00:00,000 --> 00:00:01,000\n${text}\n`;

    await drop("慢字幕.srt", subtitle("读盘期间原卡仍可删除"));
    await waitRead("慢字幕.srt");
    await page.keyboard.press("Delete");
    await page.waitForSelector('.tlb-card[data-card-id="draft-target"]', { hidden: true });
    await release("慢字幕.srt");
    await page.waitForSelector('.tlb-card[data-card-id="caption-track-1"]');
    assert.equal((await page.$$(".tlb-card")).length, 1);

    await drop("慢旧字幕.srt", subtitle("过期字幕"));
    await waitRead("慢旧字幕.srt");
    await drop("新字幕.srt", subtitle("只保留这份最新字幕"));
    await button(page, "字幕稿 1").click();
    await page.waitForFunction(() => document.querySelector(".srt-text")?.textContent === "只保留这份最新字幕");
    await release("慢旧字幕.srt");
    const saved = await waitSaved(page);
    assert.equal(saved.srt[0].text, "只保留这份最新字幕");

    const original = await readFile(file, "utf8");
    const latest = JSON.stringify({ ...JSON.parse(original), cards: [] });
    await drop("慢旧稿.json", original);
    await waitRead("慢旧稿.json");
    await drop("最新稿.json", latest);
    await page.waitForSelector(".tlb-card", { hidden: true });
    await release("慢旧稿.json");
    const final = await waitSaved(page, saved.revision);
    assert.equal(final.project.name, "最新稿.json");
    assert.deepEqual(final.overlay.cards, []);
    assert.deepEqual(dialogs, []);
  });
  return { editsDuringSubtitleReadPreserved: true, latestSubtitleRetained: true, latestDocumentRetained: true };
}

async function verifyAfterVideo(context, file, videoFile) {
  const exits = [];
  await openEditorPage(context, async (page, dialogs) => {
    await upload(page, prepInput, file);
    await page.waitForSelector('.tlb-card[data-card-id="longer-than-video"]');
    await upload(page, '.topbar input[accept="video/*"]', videoFile);
    await videoReady(page, dialogs);
    for (const first of [94, 97, 100, 103]) {
      await page.locator(loopButton).click();
      await page.waitForFunction((first) => Number(document.querySelector("[data-frame-index]").dataset.frameIndex) >= first,
        {}, first);
      const result = await page.evaluate(() => new Promise((resolve) => {
        const frame = () => Number(document.querySelector("[data-frame-index]").dataset.frameIndex);
        const video = document.querySelector(".stage-video");
        const before = frame();
        document.querySelector(".tlb-loop-btn").click();
        const start = performance.now();
        let lowest = before;
        const check = (now) => {
          const current = frame();
          lowest = Math.min(current, lowest);
          if (current >= 114 || now - start >= 1500) {
            resolve({ before, after: current, lowest, mediaTime: video.currentTime, mediaPaused: video.paused });
          } else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }));
      assert.ok(result.after >= 114 && result.lowest === result.before, JSON.stringify(result));
      assert.ok(result.mediaPaused && result.mediaTime >= 2.99, JSON.stringify(result));
      exits.push(result);
    }
  });
  return exits;
}

export async function verifyUS4(context) {
  const draftFile = join(context.evidenceDir, "草稿验收.json");
  const loopFile = join(context.evidenceDir, "循环验收.json");
  const videoFile = join(context.evidenceDir, "loop-voice.mp4");
  const extendedFile = join(context.evidenceDir, "编排长于口播.json");
  const card = (id, kind, start, end) => ({ id, kind, start, end, params: {} });
  const doc = (cards) => JSON.stringify({ version: 1, aspect: "9:16", cards });
  await writeFile(draftFile, doc([card("draft-target", "stat-proof", 0, 2)]));
  await writeFile(loopFile, doc([
    card("tiny", "stat-proof", 0.001, 0.01),
    card("middle-target", "stat-proof", 0.5, 1.5),
    card("witness", "checklist", 0.55, 3),
    card("tail-target", "stat-proof", 1.6, 3),
  ]));
  await writeFile(extendedFile, doc([
    card("longer-than-video", "stat-proof", 2.4, 3.7),
    card("tail-witness", "checklist", 2.7, 4.2),
  ]));
  const [source] = context.caseDir ? await locateInputs(context.caseDir) : [];
  const inputs = source ? ["-ss", "20", "-i", source] : [
    "-f", "lavfi", "-i", "testsrc2=s=240x426:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
  ];
  await command("ffmpeg", ["-v", "error", ...inputs, "-t", "3", "-vf", "scale=240:426,fps=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoFile]);
  const probe = JSON.parse((await command("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,duration",
    "-of", "json", videoFile])).stdout);
  assert.ok(probe.streams.some(({ codec_type }) => codec_type === "audio"));
  const competingTabs = await verifyCompetingTabs(context, draftFile, loopFile);
  return {
    "SC-06": await verifyDrafts(context, draftFile),
    legacyDraft: await verifyLegacyDraft(context, draftFile),
    lateFiles: await verifyLateFiles(context, draftFile),
    competingTabs,
    afterVideo: await verifyAfterVideo(context, extendedFile, videoFile),
    "SC-07": { input: source ?? "合成画面和测试音", streams: probe.streams,
      withVideo: await verifyLoop(context, loopFile, videoFile), withoutVideo: await verifyLoop(context, loopFile) },
  };
}

async function verifyCompetingTabs(context, oldFile, newFile) {
  const openTab = async (page) => {
    const next = await page.browserContext().newPage();
    await next.setViewport(page.viewport());
    await next.setCacheEnabled(false);
    await next.goto(new URL("/index.html", context.url).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await next.waitForSelector(prepInput);
    return next;
  };

  await openEditorPage(context, async (oldTab, dialogs) => {
    const newTab = await openTab(oldTab);
    // 将旧标签页的防抖保存推迟，保证新标签页先完成写入。
    await oldTab.evaluate(() => {
      const setTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => setTimeout(callback, delay === 800 ? 60_000 : delay, ...args);
    });
    await upload(oldTab, prepInput, oldFile);
    await oldTab.waitForSelector('[data-draft-status="saving"]');
    await upload(newTab, prepInput, newFile);
    const latest = await waitSaved(newTab);
    assert.equal(latest.revision, 1, "两个标签页可以生成同一个本地修订号");
    assert.ok(latest.overlay.cards.some(({ id }) => id === "middle-target"));

    await oldTab.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    const conflict = await oldTab.waitForSelector('[data-draft-status="conflict"]');
    assert.match(await conflict.evaluate((node) => node.textContent), /导出当前编排 JSON/);
    await oldTab.waitForSelector('.tlb-card[data-card-id="draft-target"]');
    await oldTab.evaluate(() => {
      window.alert = () => {};
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = (blob) => {
        if (blob.type === "application/json") window.__verifyDraftDownload = blob.text();
        return createObjectURL(blob);
      };
    });
    await oldTab.bringToFront();
    await oldTab.locator(".production-editbar button::-p-text(导出编排 JSON)").click();
    await oldTab.waitForSelector("[data-json-delivery]");
    const exported = await oldTab.evaluate(() => window.__verifyDraftDownload);
    assert.equal(JSON.parse(exported).cards[0].id, "draft-target");
    await oldTab.goto("about:blank");
    assert.deepEqual(await draft(newTab), latest, "旧标签页退出不能覆盖已保存的新稿");
    await oldTab.close();
    assert.deepEqual(dialogs, []);

    const otherEditor = await openTab(newTab);
    otherEditor.on("dialog", (dialog) => dialog.accept());
    await restore(otherEditor, "循环验收");
    await newTab.bringToFront();
    await newTab.locator('.fx-item[data-card-id="middle-target"]').click();
    await newTab.keyboard.press("Delete");
    const edited = await waitSaved(newTab, latest.revision);
    assert.equal(edited.project.id, latest.project.id);
    await otherEditor.bringToFront();
    await button(otherEditor, "清空").click();
    await otherEditor.waitForSelector(".tlb-card", { hidden: true });
    assert.deepEqual(await draft(newTab), edited, "旧标签页清空同一期不能删除新版本");
  });
  return { conflictReported: true, conflictedDraftExportable: true,
    newerDraftPreservedOnExit: true, newerRevisionPreservedOnClear: true };
}
