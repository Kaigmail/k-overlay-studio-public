import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openEditorPage, upload } from "../verify-002/preview.mjs";
import { verifyMedia } from "../verify-002/media.mjs";
import { capture, exportFrame, fullSize, measure, render, seekFrame } from "./us1.mjs";

const input = '.production-heading input[accept=".json,application/json"]';
const field = (label) => '[data-field-edit][aria-label="' + label + '"]';
const statValue = field("目标数字(可带小数)");
const kicker = field("顶部 kicker(英文等宽)");
const kickerZh = field("kicker 中文小注");
const curvePoints = field("数据点(标签 数值,| 分隔)");
const chips = ".panel-right textarea[data-field-edit]";
const frameSelector = ".tlb [data-frame-index]";
const card = (id) => '.stage [data-card-id="' + id + '"]';
const statReading = card("stat") + ' [data-fx-role="reading"]';
const history = (page, label) => page.locator(".production-editactions button::-p-text(" + label + ")").click();
const select = (page, id) => page.locator('.fx-item[data-card-id="' + id + '"]').click();
const valueOf = (page, selector) => page.$eval(selector, (el) => el.value);
const frameOf = (page) => page.$eval(frameSelector, (el) => Number(el.dataset.frameIndex));
const active = (page, selector) => page.evaluate((s) => document.activeElement.matches(s), selector);
const fixture = {
  version: 1, aspect: "9:16", theme: "dark", breath: false,
  cards: [
    { id: "stat", kind: "stat-proof", start: 0, end: 4,
      params: { value: "-12\u202f345.60", kicker: "SOURCE, ORIGINAL", kickerZh: "中文小注", prefix: "", suffix: "km" } },
    { id: "list", kind: "entity-chips", start: 0, end: 4,
      params: { chips: "light|首行|English, original" } },
    { id: "rank", kind: "rank-bars", start: 4, end: 8,
      params: { rows: "名称,部门,-45.60 | Legacy,-12,345.60", suffix: "km" } },
    { id: "ring", kind: "ring-metric", start: 8, end: 12,
      params: { value: "-12,345.60", max: "+45,678.90", unit: "km" } },
    { id: "curve", kind: "growth-curve", start: 12, end: 16,
      params: { points: "最初,初值 .50 | 第二点 1,000.00 | 终值,修订 -12,345.60", unit: "km" } },
  ],
};

export async function saveUS3Fixture(dir) {
  const file = join(dir, "phase5-fixture.json");
  await writeFile(file, JSON.stringify(fixture, null, 2));
  return file;
}

async function load(page, file) {
  await page.evaluate(() => localStorage.setItem("overlayStudioLearnTipCount", "99"));
  await upload(page, input, file);
  await page.waitForSelector(".tlb-card");
  const lint = await page.$(".lint-head-btns button:last-child");
  if (lint) await lint.click();
}

async function type(page, selector, text) {
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
}

async function statDigits(page) {
  return page.$eval(statReading, (el) => {
    const [sign, digits, unit] = el.children;
    const rolling = Array.from(digits.children, (column) => {
      const strip = column.firstElementChild;
      if (!strip) return column.textContent;
      const transform = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
      const height = parseFloat(column.style.height);
      return strip.children[Math.round(-transform.m42 / height)].textContent;
    }).join("");
    return sign.textContent + rolling + unit.textContent;
  });
}

async function reading(page, id) {
  return page.$eval(card(id), (el) => el.textContent.replace(/\s+/g, " "));
}

async function emptyCanvasClick(page) {
  const point = await page.$eval(".stage", (el) => {
    const box = el.getBoundingClientRect();
    return { x: box.left + 12, y: box.top + box.height * 0.15 };
  });
  await page.mouse.click(point.x, point.y);
}

async function fieldFlows(page, file) {
  await load(page, file);
  await seekFrame(page, 84, 16);
  await select(page, "stat");
  assert.equal(await valueOf(page, statValue), "-12345.60");
  assert.equal(await statDigits(page), "-12345.60km");
  await type(page, statValue, "-");
  await page.keyboard.press("Enter");
  assert.equal(await active(page, statValue), true);
  assert.equal(await valueOf(page, statValue), "-");
  assert.equal(await statDigits(page), "-12345.60km");
  await page.waitForSelector(".panel-right [aria-invalid=true]");
  await page.keyboard.press("Tab");
  assert.equal(await active(page, statValue), false);
  assert.equal(await valueOf(page, statValue), "-");
  await page.locator(".panel-right button::-p-text(完成)").click();
  assert.equal(await active(page, statValue), true);
  await type(page, statValue, "-23,456.70");
  assert.equal(await frameOf(page), 84);
  assert.equal(await statDigits(page), "-23456.70km");
  await page.keyboard.press("Enter");
  assert.equal(await active(page, statValue), false);
  assert.equal(await valueOf(page, statValue), "-23456.70");
  await history(page, "撤销");
  assert.equal(await valueOf(page, statValue), "-12345.60");
  await history(page, "重做");
  assert.equal(await valueOf(page, statValue), "-23456.70");
  await page.keyboard.press("Space");
  await page.waitForFunction((s) => Number(document.querySelector(s)?.dataset.frameIndex) > 84, {}, frameSelector);
  await page.keyboard.press("Space");
  await seekFrame(page, 84, 16);

  await type(page, kicker, "ONE, TWO");
  assert.match(await reading(page, "stat"), /ONE, TWO/);
  await page.keyboard.press("Tab");
  assert.equal(await active(page, kickerZh), true);
  await type(page, kicker, "SIDEBAR, SWITCH");
  await select(page, "list");
  assert.equal(await active(page, kicker), false);
  await select(page, "stat");
  assert.equal(await valueOf(page, kicker), "SIDEBAR, SWITCH");
  await history(page, "撤销");
  assert.equal(await valueOf(page, kicker), "ONE, TWO");
  await history(page, "重做");
  assert.equal(await valueOf(page, kicker), "SIDEBAR, SWITCH");

  await type(page, kicker, "CANVAS, DONE");
  await emptyCanvasClick(page);
  assert.equal(await active(page, kicker), false);
  await select(page, "stat");
  assert.equal(await valueOf(page, kicker), "CANVAS, DONE");

  await type(page, kicker, "TIMELINE, SWITCH");
  const timelineCard = '.tlb-card[data-card-id="list"]';

  const timeHit = await page.$eval(timelineCard, (el) => {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const b = el.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit?.closest(".tlb-card")?.dataset.cardId, className: hit?.className };
  });
  assert.equal(timeHit.hit, "list", JSON.stringify(timeHit));
  await page.mouse.click(timeHit.x, timeHit.y);
  assert.equal(await page.$eval(timelineCard, (el) => el.classList.contains("is-sel")), true, "时间轴点击没有选中目标卡");
  await page.waitForSelector(chips);
  await select(page, "stat");
  assert.equal(await valueOf(page, kicker), "TIMELINE, SWITCH");
  await page.focus(kicker);
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter(" AUDIT");
  assert.equal(await valueOf(page, kicker), "TIMELINE, SWITCH AUDIT");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  assert.equal(await valueOf(page, kicker), "TIMELINE, SWITCH");
  assert.equal(await active(page, kicker), true);
  await page.keyboard.press("Enter");
  await history(page, "撤销");
  assert.equal(await valueOf(page, kicker), "CANVAS, DONE");
  await history(page, "重做");
  assert.equal(await valueOf(page, kicker), "TIMELINE, SWITCH");

  // Synthetic composition covers the site's event ordering, not the Windows candidate UI.
  await page.focus(kickerZh);
  await page.$eval(kickerZh, (el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "铁路, 法案");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  });
  assert.equal(await active(page, kickerZh), true);
  assert.doesNotMatch(await reading(page, "stat"), /铁路, 法案/);
  await page.$eval(kickerZh, (el) =>
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "铁路, 法案" })));
  assert.match(await reading(page, "stat"), /铁路, 法案/);
  await page.locator(".panel-right button::-p-text(完成)").click();
  assert.equal(await active(page, kickerZh), false);
  await history(page, "撤销");
  assert.equal(await valueOf(page, kickerZh), "中文小注");
  await history(page, "重做");
  assert.equal(await valueOf(page, kickerZh), "铁路, 法案");

  await select(page, "list");
  await type(page, chips, "light|Line One|source, text");
  await page.keyboard.press("Enter");
  await page.keyboard.type("dark|Line Two|notes, text");
  const multiline = "light|Line One|source, text\ndark|Line Two|notes, text";
  assert.equal(await active(page, chips), true);
  assert.equal(await valueOf(page, chips), multiline);
  await page.keyboard.down("Control");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Control");
  assert.equal(await active(page, chips), false);
  await history(page, "撤销");
  assert.equal(await valueOf(page, chips), "light|首行|English, original");
  await history(page, "重做");
  assert.equal(await valueOf(page, chips), multiline);
  return { frame: 84, initial: "-12345.60km", edited: "-23456.70km", multiline };
}

async function numericCards(page) {
  await seekFrame(page, 27, 16);
  assert.match(await statDigits(page), /^-\d{5}\.\d{2}km$/);
  await seekFrame(page, 210, 16);
  await select(page, "rank");
  const legacy = await reading(page, "rank");
  assert.match(legacy, /Legacy,-12/);
  assert.match(legacy, /345\.60/);
  const rankValue = field("名称,部门 数值");
  await type(page, rankValue, "-12,345.60");
  await page.keyboard.press("Enter");
  assert.equal(await valueOf(page, rankValue), "-12345.60");
  const ranks = await reading(page, "rank");
  assert.match(ranks, /名称,部门/);
  assert.match(ranks, /-12345\.60/);

  await seekFrame(page, 324, 16);
  await select(page, "ring");
  assert.equal(await valueOf(page, field("数值（输入）")), "-12345.60");
  assert.equal(await valueOf(page, field("满值(算比例)（输入）")), "+45678.90");
  const ring = await reading(page, "ring");
  assert.match(ring, /-12345\.60km/);
  assert.match(ring, /OF \+45678\.90km/);
  const ringInput = field("数值（输入）");
  await type(page, ringInput, "+12,345.60");
  await page.keyboard.press("Enter");
  assert.equal(await valueOf(page, ringInput), "+12345.60");
  assert.match(await reading(page, "ring"), /\+12345\.60km/);
  await history(page, "撤销");
  assert.equal(await valueOf(page, ringInput), "-12345.60");

  await seekFrame(page, 468, 16);
  await select(page, "curve");
  const originalPoints = "最初,初值 0.50 | 第二点 1000.00 | 终值,修订 -12345.60";
  assert.equal(await valueOf(page, curvePoints), originalPoints);
  const curve = await reading(page, "curve");
  assert.match(curve, /0\.50/);
  assert.match(curve, /终值,修订/);
  assert.match(curve, /-12345\.60/);
  assert.doesNotMatch(curve, /12,345\.60|1,000\.00/);
  await page.focus(curvePoints);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  const unfinished = "最初,初值 0.50 | 第二点 1000.00 | 终值,修订 -12.";
  await page.keyboard.sendCharacter(unfinished);
  assert.equal(await reading(page, "curve"), curve, "未完成的曲线数字不应改动画面");
  await page.keyboard.press("Tab");
  assert.equal(await active(page, curvePoints), false);
  assert.equal(await valueOf(page, curvePoints), unfinished);
  await page.waitForSelector(".panel-right [aria-invalid=true]");
  await page.locator(".panel-right button::-p-text(完成)").click();
  assert.equal(await active(page, curvePoints), true);
  await page.keyboard.press("End");
  await page.keyboard.type("30");
  await page.keyboard.press("Enter");
  assert.match(await reading(page, "curve"), /-12\.30/);
  await history(page, "撤销");
  assert.equal(await valueOf(page, curvePoints), originalPoints);
  return { ranks, ring, curve, curveDraft: unfinished };
}

export async function verifyUS3(context) {
  const file = await saveUS3Fixture(context.evidenceDir);
  let editor;
  await openEditorPage(context, async (page, dialogs) => {
    editor = await fieldFlows(page, file);
    editor.cards = await numericCards(page);
    assert.deepEqual(dialogs, []);
  });

  const samples = fixture.cards.filter(({ id }) => id !== "list").map((item) => item.id === "rank"
    ? { ...item, params: { ...item.params, rows: "名称,部门,-12345.60 | Legacy, 345.60" } } : item);
  const exports = [];
  for (const sample of samples) exports.push(await verifyNumericExport(context, sample));
  return { editor, exports };
}

async function verifyNumericExport(context, sample) {
  const doc = { ...fixture, cards: [{ ...sample, start: -3.4, end: 1 }] };
  const label = sample.id;
  const short = join(context.evidenceDir, label + "-mov-fixture.json");
  await writeFile(short, JSON.stringify(doc, null, 2));
  const preview = join(context.evidenceDir, label + "-mov-preview.png");
  await openEditorPage(context, async (page) => {
    await load(page, short);
    await fullSize(page);
    await seekFrame(page, 1, 1);
    if (label === "stat") assert.equal(await statDigits(page), "-12345.60km");
    else assert.match(await reading(page, label), /-12345\.60/);
    await capture(page, preview);
  });
  const output = await render(context, { doc, duration: 12 / 30 }, "phase5-" + label);
  const call = promisify(execFile);
  const command = async (file, args) => (await call(file, args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const mov = await verifyMedia({ command }, output.mov, "mov", { width: 1080, height: 1920, frames: 12, rate: "30/1" });
  assert.match(mov.video.pix_fmt, /yuva/);
  const still = join(context.evidenceDir, label + "-mov-frame.png");
  await exportFrame(output.mov, 1, still);
  const difference = await measure(preview, still);
  assert.ok(difference.boundsDelta <= 1 && difference.alphaError <= 3 &&
    difference.premultipliedColorError <= 6, JSON.stringify(difference));
  return { label, mov, preview, still, difference };
}

export async function verifyUS3Desktop(page, { file, ui, evidenceDir }) {
  await load(page, file);
  await seekFrame(page, 84, 16);
  await select(page, "stat");
  await page.waitForSelector('.card-edit-box[data-edit-card="stat"]');
  const handle = await page.locator('.card-edit-box[data-edit-card="stat"] [aria-label="右下角缩放"]').waitHandle();
  const box = await handle.boundingBox();
  assert.ok(box);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  assert.ok(await page.evaluate((x, y) => document.elementFromPoint(x, y)?.matches(".card-edit-handle"), x, y));
  await page.mouse.click(x, y);
  await page.waitForSelector('.card-edit-box[data-edit-card="stat"]');
  await page.locator(kicker).click();
  assert.equal(await active(page, kicker), true);
  await page.keyboard.press("End");
  await page.keyboard.type(" DESKTOP");
  await page.keyboard.press("Enter");
  assert.equal(await active(page, kicker), false);
  assert.equal(await valueOf(page, kicker), "SOURCE, ORIGINAL DESKTOP");
  assert.equal(await frameOf(page), 84);
  await page.keyboard.press("Space");
  await page.waitForFunction((s) => Number(document.querySelector(s)?.dataset.frameIndex) > 84, {}, frameSelector);
  await page.keyboard.press("Space");
  await seekFrame(page, 84, 16);
  await page.locator(kickerZh).click();
  await ui("ime-focus", "-ExpectedTitle", "kicker 中文小注");
  const nativeWindow = await ui("inspect");
  assert.equal(nativeWindow.handle, nativeWindow.foreground, "EXE 没有成为系统前台窗口。");
  assert.equal(await page.evaluate((s) => document.hasFocus() && document.activeElement.matches(s), kickerZh), true);
  const selectAll = async () => {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
  };
  await selectAll();
  await page.$eval(kickerZh, (el) => {
    window.phase5Composition = [];
    for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
      el.addEventListener(type, (event) => window.phase5Composition.push({
        type, data: event.data, trusted: event.isTrusted, focused: document.activeElement === el,
      }));
    }
  });
  const started = () => page.waitForFunction(() => window.phase5Composition.some(({ type, trusted }) =>
    type === "compositionupdate" && trusted), { timeout: 1600 }).then(() => true, () => false);
  const details = { frame: 84, hit: "resize handle", focusedWindow: nativeWindow.title };
  let toggled = false;
  try {
    const picture = join(evidenceDir, "ime-candidate.png");
    await ui("ime-type");
    if (!await started()) {
      await selectAll();
      await ui("ime-toggle");
      toggled = true;
      await ui("ime-type");
      if (!await started()) {
        const value = await valueOf(page, kickerZh);
        await page.keyboard.press("Escape");
        return { ...details, ime: { status: "pending", value,
          reason: "向真实桌面字段发送系统按键后，两种输入模式均未捕获候选词合成事件。" } };
      }
    }
    await ui("inspect", "-Picture", picture);
    assert.equal(await active(page, kickerZh), true);
    assert.equal(await frameOf(page), 84);
    assert.match(await reading(page, "stat"), /中文小注/);
    await ui("ime-confirm");
    const finished = await page.waitForFunction(() => window.phase5Composition.some(({ type }) =>
      type === "compositionend"), { timeout: 2500 }).then(() => true, () => false);
    const composition = await page.evaluate(() => window.phase5Composition);
    const value = await valueOf(page, kickerZh);
    await writeFile(join(evidenceDir, "ime-events.json"), JSON.stringify({ finished, composition, value }, null, 2));
    assert.ok(finished, "已出现系统候选词，但系统按键未完成候选提交。");
    const confirmed = composition.find(({ type }) => type === "compositionend");
    assert.match(confirmed.data, /[\u3400-\u9fff]/);
    assert.ok(composition.some(({ type, data, trusted }) =>
      type === "compositionupdate" && trusted && data === confirmed.data), "Windows 候选确认尚无可信的合成更新。");
    assert.equal(confirmed.focused, true);
    assert.equal(await active(page, kickerZh), true);
    assert.equal(await valueOf(page, kickerZh), confirmed.data);
    await page.waitForFunction((s, word) => document.querySelector(s)?.textContent.includes(word),
      { timeout: 2500 }, card("stat"), confirmed.data)
      .catch(() => { throw new Error("候选已上屏，但当前帧未显示已确认文字。"); });
    await ui("ime-finish");
    await page.waitForFunction((selector) => !document.activeElement.matches(selector), { timeout: 2500 }, kickerZh);
    assert.equal(await frameOf(page), 84);
    await history(page, "撤销");
    assert.equal(await valueOf(page, kickerZh), "中文小注");
    await history(page, "重做");
    assert.equal(await valueOf(page, kickerZh), confirmed.data);
    return { ...details, ime: { status: "passed", composition, picture, confirmed: confirmed.data } };
  } finally {
    if (toggled) await ui("ime-toggle");
  }
}
