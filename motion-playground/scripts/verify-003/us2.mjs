import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureStage, openEditorPage, upload } from "../verify-002/preview.mjs";
import { verifyMedia } from "../verify-002/media.mjs";
import { locateInputs } from "./baseline.mjs";
import { capture, exportFrame, fullSize, measure, render, seekFrame } from "./us1.mjs";

const input = '.production-heading input[accept=".json,application/json"]';
const rect = (id) => `.stage [data-card-id="${id}"] .hud-anchor`;
const editBox = ".stage .card-edit-box";
const slider = 'input[aria-label="卡片大小"]';
const panel = ".panel-right";
const fps = 30;

function button(page, label, parent = ".production-editactions") {
  return page.locator(`${parent} button::-p-text(${label})`);
}

async function useFile(context, file, visit) {
  let report;
  await openEditorPage(context, async (page, dialogs) => {
    await page.evaluate(() => localStorage.setItem("overlayStudioLearnTipCount", "99"));
    await upload(page, input, file);
    await page.waitForSelector(".tlb-card");
    report = await visit(page);
    assert.deepEqual(dialogs, []);
  });
  return report;
}

function box(page, selector) {
  return page.$eval(selector, (element) => {
    const stage = element.closest(".stage");
    const outer = stage.getBoundingClientRect();
    const size = outer.width / stage.offsetWidth;
    const b = element.getBoundingClientRect();
    return {
      x: (b.left - outer.left) / size - stage.clientLeft, y: (b.top - outer.top) / size - stage.clientTop,
      w: b.width / size, h: b.height / size,
    };
  });
}

function close(actual, expected, tolerance = 1) {
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${key}: ${JSON.stringify({ actual, expected, tolerance })}`);
  }
}

async function drag(page, selector, dx, dy, { hold = 0, cancel = false, snap = false } = {}) {
  const handle = await page.waitForSelector(selector);
  const b = await handle.boundingBox();
  assert.ok(b, selector);
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  const zoom = await page.$eval(".stage", (stage) => stage.getBoundingClientRect().width / stage.offsetWidth);
  if (!snap) await page.keyboard.down("Alt");
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    if (dx || dy) await page.mouse.move(x + zoom * dx, y + zoom * dy, { steps: 4 });
    if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
    if (cancel === true) await page.keyboard.press("Escape");
    if (cancel === "pointer") await page.evaluate(() =>
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })));
  } finally {
    await page.mouse.up();
    if (!snap) await page.keyboard.up("Alt");
  }
}

async function select(page, id) {
  await page.locator(`.fx-item[data-card-id="${id}"]`).click();
  await page.waitForSelector(`${editBox}[data-edit-card="${id}"]`);
}

async function scale(page, value) {
  await page.$eval(slider, (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function wheel(page, id, deltaY, count) {
  await page.$eval(rect(id), (card, { deltaY, count }) => new Promise((resolve) => {
    const step = () => {
      card.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY }));
      if (--count) requestAnimationFrame(step);
      else resolve();
    };
    step();
  }), { deltaY, count });
  await page.waitForFunction(() => !document.querySelector(".production-editactions button[title='Ctrl / Cmd + Z']").disabled);
}

function zoom(page) {
  return page.$eval("[data-edit-scale]", (node) => parseFloat(node.value));
}

async function saveJson(page, path) {
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName", browserContextId: page.browserContext().id, downloadPath: path, eventsEnabled: true,
  });
  try {
    const download = new Promise((resolve, reject) => {
      const done = (event) => {
        if (event.state === "completed") resolve(join(path, event.guid));
        if (event.state === "canceled") reject(new Error("编排 JSON 下载取消"));
      };
      cdp.on("Browser.downloadProgress", done);
    });
    await button(page, "导出编排 JSON").click();
    const file = await Promise.race([download, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("编排 JSON 下载超时")), 8000);
      timer.unref();
    })]);
    return JSON.parse(await readFile(file, "utf8"));
  } finally {
    await cdp.detach();
  }
}

async function compareLayout(context, caseFile, first, second) {
  return useFile(context, caseFile, async (page) => {
    await seekFrame(page, 660, 23.75);
    await page.evaluate(() => document.fonts.ready);
    await select(page, second.id);
    const untouched = await box(page, rect(first.id));
    const base = await box(page, rect(second.id));
    const initialScale = await zoom(page);
    assert.ok(initialScale > 0.4);
    assert.ok(base.x >= 78 && base.y >= 351 && base.x + base.w <= 998 && base.y + base.h <= 691, JSON.stringify(base));
    const undo = () => button(page, "撤销").click();
    const redo = () => button(page, "重做").click();

    // 手柄固定左上角。相同倍率由面板和滚轮达到，另外一张卡尺寸保持。
    const handle = '[aria-label="右下角缩放"]';
    const target = (Math.round(initialScale * 20) - 2) / 20;
    const ratio = target / initialScale - 1;
    await drag(page, handle, base.w * ratio, base.h * ratio);
    const corner = await box(page, rect(second.id));
    close(corner, { x: base.x, y: base.y });
    await undo();
    close(await box(page, rect(second.id)), base);
    await scale(page, target);
    const panelSize = await box(page, rect(second.id));
    close(panelSize, { w: corner.w, h: corner.h }, 1.2);
    await page.focus(slider);
    await page.keyboard.down("Control");
    try {
      await page.keyboard.press("KeyZ");
    } finally {
      await page.keyboard.up("Control");
    }
    close(await box(page, rect(second.id)), base);
    await wheel(page, second.id, 100, 2);
    const wheelScale = await zoom(page);
    assert.ok(Math.abs(wheelScale - target) <= 0.001, JSON.stringify({ initialScale, target, wheelScale }));
    const wheelSize = await box(page, rect(second.id));
    close(wheelSize, { w: corner.w, h: corner.h }, 1.2);
    close(await box(page, rect(first.id)), untouched);
    await undo();
    close(await box(page, rect(second.id)), base);
    await redo();
    close(await box(page, rect(second.id)), wheelSize);

    // 原始位置的另一张同时在场卡，独立层序可以穿过组。
    await button(page, "置顶", panel).click();
    const ranks = await page.evaluate((ids) => ids.map((id) => {
      const shell = document.querySelector(`.stage [data-card-id="${id}"]`);
      return Number(getComputedStyle(shell.closest(".overlay-layout-member, .overlay-layout-card")).zIndex);
    }), [first.id, "overlap", second.id]);
    assert.ok(ranks[0] < ranks[1] && ranks[1] < ranks[2], JSON.stringify(ranks));
    close(await box(page, rect(second.id)), wheelSize);

    await button(page, "移动整组", panel).click();
    await page.waitForSelector(`${editBox}[data-edit-group]`);
    const stack = () => page.$eval(".overlay-layout-group", (node) => ({
      x: Number(node.dataset.originX), y: Number(node.dataset.originY),
    }));
    const origin = await stack();
    await drag(page, ".card-edit-label", 100, 350, { hold: 1000 });
    const moved = await stack();
    close(moved, { x: origin.x + 100, y: origin.y + 350 });
    await undo();
    close(await stack(), origin);
    await redo();
    close(await stack(), moved);
    await drag(page, ".card-edit-label", 180, 40, { cancel: true });
    close(await stack(), moved);
    await drag(page, ".card-edit-label", 180, 40, { cancel: "pointer" });
    close(await stack(), moved);
    await undo();
    close(await stack(), origin);
    await redo();
    close(await stack(), moved);
    await button(page, "移动整组", panel).click();

    const beforeDetach = await box(page, rect(second.id));
    await button(page, "脱离自动排版", panel).click();
    close(await box(page, rect(second.id)), beforeDetach);
    const afterDetachOther = await box(page, rect(first.id));
    await drag(page, ".card-edit-label", 4 - beforeDetach.x, 0, { snap: true });
    close(await box(page, rect(second.id)), { x: 0 });
    await undo();
    close(await box(page, rect(second.id)), beforeDetach);
    await drag(page, ".card-edit-label", 2000, 2000);
    const edge = await box(page, rect(second.id));
    close({ right: edge.x + edge.w, bottom: edge.y + edge.h }, { right: 1080, bottom: 1920 });
    close(await box(page, rect(first.id)), afterDetachOther);

    const text = ["精修英文标题", "精修中文标题", "精修英文附注"];
    const fields = await page.$$eval(`${panel} input[type=text]`, (inputs) => inputs
      .filter((element) => ["RAILWAY ACTS", "议会一年通过的铁路法案", "SOURCE · UK PARLIAMENT · 1846"].includes(element.value))
      .map((element) => element.value));
    assert.equal(fields.length, text.length);
    for (const [i, current] of fields.entries()) {
      await page.$$eval(`${panel} input[type=text]`, (inputs, { current, value }) => {
        const input = inputs.find((element) => element.value === current);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, { current, value: text[i] });
    }
    const changed = await box(page, rect(second.id));
    const download = join(context.evidenceDir, "downloads");
    await mkdir(download);
    const refined = await saveJson(page, download);
    assert.deepEqual(refined.refinement.paintOrder.slice(-1), [second.id]);
    assert.equal(refined.refinement.byCard[second.id].frames["9:16"].current.mode, "free");
    await button(page, "恢复编排位置与大小", panel).click();
    const restored = await box(page, rect(second.id));
    const restoredDoc = await saveJson(page, download);
    for (const value of text) assert.ok(Object.values(restoredDoc.cards.find(({ id }) => id === second.id).params).includes(value));
    assert.equal(restoredDoc.refinement.byCard[second.id].frames["9:16"].current.mode, "auto");
    await undo();
    close(await box(page, rect(second.id)), changed);
    await redo();
    close(await box(page, rect(second.id)), restored);
    await undo();
    const movedScale = await zoom(page);
    const type = `${panel} .kind-select`;
    await page.select(type, "punch-pill");
    const swapped = await saveJson(page, download);
    const swappedCard = swapped.cards.find(({ id }) => id === second.id);
    assert.equal(swappedCard.kind, "punch-pill");
    assert.deepEqual([swappedCard.start, swappedCard.end], [second.start, second.end]);
    assert.deepEqual(swapped.refinement.byCard[second.id], refined.refinement.byCard[second.id]);
    assert.equal(await zoom(page), movedScale);
    await undo();
    assert.equal(await page.$eval(type, (element) => element.value), second.kind);
    const undone = await saveJson(page, download);
    assert.deepEqual(undone.cards.find(({ id }) => id === second.id).params, restoredDoc.cards.find(({ id }) => id === second.id).params);
    close(await box(page, rect(second.id)), changed);
    await redo();
    assert.equal(await page.$eval(type, (element) => element.value), "punch-pill");
    await undo();
    await button(page, "恢复编排位置与大小", panel).click();

    await page.select('select[aria-label="画幅"]', "16:9");
    await button(page, "确认画幅").click();
    await page.waitForSelector(".stage:not(.is-vertical)");
    await captureStage(page, join(context.evidenceDir, "landscape-edited.png"));
    await button(page, "恢复编排位置与大小", panel).click();
    await page.select('select[aria-label="画幅"]', "9:16");
    await button(page, "确认画幅").click();
    await page.waitForSelector(".stage.is-vertical");
    close(await box(page, rect(second.id)), restored);

    return { refined, changed, restored, origin, moved, ranks, initialScale, target, wheelScale, corner, panelSize, wheelSize, edge };
  });
}

async function firstExit(context, file, first, second) {
  return useFile(context, file, async (page) => {
    const frames = [];
    for (const index of [659, 660, 659]) {
      await seekFrame(page, index, 23.75);
      frames.push({
        index,
        origin: await page.$eval(".overlay-layout-group", (node) => [Number(node.dataset.originX), Number(node.dataset.originY)]),
        second: await box(page, rect(second.id)),
        first: !!(await page.$(rect(first.id))),
      });
    }
    assert.deepEqual(frames.map(({ first }) => first), [true, false, true]);
    close({ x: frames[0].origin[0], y: frames[0].origin[1] }, { x: frames[1].origin[0], y: frames[1].origin[1] }, 0.1);
    assert.ok(frames[1].second.y < frames[0].second.y);
    close(frames[0].second, frames[2].second, 0.1);
    return frames;
  });
}

async function verifyTimingAndDraft(context, file, first, second) {
  return useFile(context, file, async (page) => {
    await seekFrame(page, 660, 23.75);
    await page.evaluate(() => document.fonts.ready);
    await select(page, first.id);
    await button(page, "恢复编排位置与大小", panel).click();
    const endOfDrag = `.tlb-card[data-card-id="${first.id}"]`;
    const timing = `${panel} .time-fields input:first-child`;
    const start = second.start + 0.5;
    const changeStart = (value) => page.$eval(timing, (input, next) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(next));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    const draft = () => page.evaluate(() => JSON.parse(localStorage.getItem("overlayStudioAutosave"))?.overlay);
    await page.waitForFunction(() => !!localStorage.getItem("overlayStudioAutosave"));
    assert.equal((await draft()).refinement, undefined, "未手调的编排无需写入恢复覆盖");
    await changeStart(start);
    await page.waitForFunction((selector, value) => Number(document.querySelector(selector)?.value) === value, {}, timing, start);
    await button(page, "撤销").click();
    assert.equal(await page.$eval(timing, (input) => Number(input.value)), first.start);
    await button(page, "重做").click();
    assert.equal(await page.$eval(timing, (input) => Number(input.value)), start);
    await select(page, second.id);
    await drag(page, ".card-edit-label", 0, 0, { hold: 1000 });
    assert.equal((await draft()).cards.find(({ id }) => id === first.id).start, start,
      "下一次手势长按时，已完成的时间修改仍应保存");
    await drag(page, ".card-edit-label", 82, 81);
    const moved = await box(page, rect(second.id));
    const getOrder = () => page.evaluate(() => Array.from(
      document.querySelectorAll(".overlay-layout-group .overlay-layout-member [data-card-id]"),
      (node) => node.dataset.cardId));
    assert.deepEqual(await getOrder(), [first.id, second.id]);
    await page.waitForFunction(({ id, start, edited, group }) => {
      const doc = JSON.parse(localStorage.getItem("overlayStudioAutosave"))?.overlay;
      return doc?.cards.some((card) => card.id === id && card.start === start) &&
        doc.refinement?.groups?.[group]?.order[0] === id &&
        doc.refinement?.byCard?.[edited]?.frames["9:16"]?.current?.mode === "group";
    }, {}, { id: first.id, start, edited: second.id, group: first.seg });
    await page.reload();
    await page.locator("button::-p-text(恢复上次草稿)").click();
    await page.waitForSelector(endOfDrag);
    await seekFrame(page, 660, 23.75);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(await getOrder(), [first.id, second.id]);
    const restored = await box(page, rect(second.id));
    close(restored, moved);
    return { start, order: await getOrder(), moved, restored };
  });
}

async function verifyProductionRoundtrip(context, file, refined, second, expected) {
  const directory = join(context.evidenceDir, "production-fixture");
  await mkdir(directory);
  let written;
  await openEditorPage(context, async (page, dialogs) => {
    await page.locator('.production-path input[placeholder]').fill(directory);
    await page.locator("button::-p-text(读取目录)").click();
    await page.waitForSelector(".production-meta strong");
    await upload(page, input, file);
    await page.waitForSelector(".tlb-card");
    const [response] = await Promise.all([
      page.waitForResponse((item) => item.url().endsWith("/api/production/save-json")),
      button(page, "导出编排 JSON").click(),
    ]);
    const payload = await response.json();
    assert.ok(response.ok(), JSON.stringify(payload));
    written = payload.path;
    assert.deepEqual(dialogs, []);
  });
  const actual = JSON.parse(await readFile(written, "utf8"));
  assert.deepEqual(actual.refinement, refined.refinement);
  const reopened = await useFile(context, written, async (page) => {
    await seekFrame(page, 660, 23.75);
    await page.evaluate(() => document.fonts.ready);
    const actual = await box(page, rect(second.id));
    close(actual, expected);
    return actual;
  });
  return { written, reopened };
}

export async function verifyUS2(context) {
  const [, , source] = await locateInputs(context.caseDir);
  const original = JSON.parse(await readFile(source, "utf8"));
  const [first, second] = original.cards.filter(({ seg, start, end }) => seg && start < 22 && end > 22)
    .filter(({ kind }) => ["pin-board", "stat-proof"].includes(kind));
  assert.ok(first?.seg && first.seg === second?.seg);
  const save = async (name, value) => {
    const file = join(context.evidenceDir, name);
    await writeFile(file, JSON.stringify(value, null, 2));
    return file;
  };
  const fixture = await save("placement-fixture.json", {
    ...original, cards: [first, second, { ...second, id: "overlap", seg: undefined,
      params: { ...second.params, position: "right" } }],
  });
  const exit = await save("first-exit.json", { ...original, cards: [{ ...first, end: 22 }, second] });
  const groupFrames = await firstExit(context, exit, first, second);
  const timingAndDraft = await verifyTimingAndDraft(context, fixture, first, second);
  const { refined, changed, ...checks } = await compareLayout(context, fixture, first, second);
  const file = await save("hand-edited.json", refined);
  const roundtrip = await useFile(context, file, async (page) => {
    await seekFrame(page, 660, 23.75);
    await page.evaluate(() => document.fonts.ready);
    const actual = await box(page, rect(second.id));
    close(actual, changed);
    await captureStage(page, join(context.evidenceDir, "portrait-edited.png"));
    await select(page, second.id);
    await button(page, "恢复编排位置与大小", panel).click();
    close(await box(page, rect(second.id)), checks.restored);
    return actual;
  });

  const production = await verifyProductionRoundtrip(context, file, refined, second, changed);

  // 保留节目相对时序及卡龄，从 22 秒前一帧起导出 12 帧。
  const offset = 22 - 1 / fps;
  const shifted = { ...refined, cards: refined.cards.map((card) => ({
    ...card, start: card.start - offset, end: card.end - offset,
    params: { ...card.params, dimAt: Number(card.params.dimAt) ? card.params.dimAt - offset : undefined },
  })) };
  const index = 1;
  const short = await save("mov-fixture.json", shifted);
  const preview = join(context.evidenceDir, "mov-preview.png");
  await useFile(context, short, async (page) => {
    await fullSize(page);
    await seekFrame(page, index, Math.max(...shifted.cards.map(({ end }) => end)));
    await capture(page, preview);
  });
  const output = await render(context, { doc: shifted, duration: 12 / fps }, "phase4");
  const run = promisify(execFile);
  const command = async (file, args) => (await run(file, args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const mov = await verifyMedia({ command }, output.mov, "mov", { width: 1080, height: 1920, frames: 12, rate: "30/1" });
  assert.match(mov.video.pix_fmt, /yuva/);
  const still = join(context.evidenceDir, "mov-frame.png");
  await exportFrame(output.mov, index, still);
  const difference = await measure(preview, still);
  assert.ok(difference.boundsDelta <= 1 && difference.alphaError <= 3 &&
    difference.premultipliedColorError <= 6, JSON.stringify(difference));
  return { checks, groupFrames, timingAndDraft, roundtrip, production, file, mov, preview, still, difference };
}
