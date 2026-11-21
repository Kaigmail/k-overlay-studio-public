import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { captureStage, fullView, importSources, openEditorPage, seekVideo, videoGeometry, videoReady } from "./preview.mjs";

const verticalVisible = { left: 59, top: 268, right: 1017, bottom: 1483, notchX: 887, notchY: 769 };
const verticalBands = {
  chapter: { left: 79, top: 284, right: 997, bottom: 338 },
  upper: { left: 79, top: 352, right: 997, bottom: 690 },
  lower: { left: 79, top: 1010, right: 867, bottom: 1350 },
  caption: { left: 79, top: 1370, right: 867, bottom: 1460 },
};

async function inspectFocus(context, editor, fixtures, format, label) {
  await openEditorPage(editor, async (page, dialogs) => {
    const video = join(fixtures.dir, format.file);
    const focus = format.overlays.find(({ purpose }) => purpose === "focus");
    await importSources(page, video, join(fixtures.dir, focus.file), "json-first");
    const media = await videoReady(page, dialogs);
    for (const [phase, time] of Object.entries(format.focusTimes)) {
      await context.check(`focus-${label}-${phase}`, async () => {
        const timing = await seekVideo(page, time, media.duration);
        const focused = phase !== "before" && phase !== "after";
        await page.waitForFunction((active) =>
          document.querySelector(".stage-video")?.classList.contains("is-pip") === active, {}, focused);
        if (!focused) {
          await page.waitForFunction(() => {
            const video = document.querySelector(".stage-video");
            return video.getAnimations().every((animation) => animation.playState !== "running");
          });
        }
        const geometry = await videoGeometry(page);
        const image = join(context.evidenceDir, `focus-${label}-${phase}.png`);
        await captureStage(page, image);
        if (focused) {
          const expected = await page.evaluate(async (time, [start, end]) => {
            const { focusCamGeomAt } = await import("/src/effects/hud/camGeom.ts");
            const { x, y, w, h } = focusCamGeomAt({}, time - start, end - start);
            return { x, y, width: w, height: h };
          }, timing.currentTime, focus.activeRange);
          assert.equal(geometry.fit, "cover");
          assert.equal(geometry.scale, 1);
          for (const dimension of Object.keys(expected)) {
            assert.ok(Math.abs(geometry.video[dimension] - expected[dimension]) < 0.1,
              `${label} ${phase} 人物框 ${dimension} 偏离共享几何`);
          }
          if (phase === "inside" && format.aspect === "9:16") {
            const { x, y, width, height } = geometry.video;
            assert.ok(x >= verticalVisible.left && x + width <= verticalVisible.notchX &&
              y >= verticalVisible.top && y + height <= verticalVisible.bottom, "停稳的人物框超出竖屏可见区");
          }
        } else {
          assert.ok(fullView(geometry), `${label} ${phase} 应完整显示口播原画面`);
        }
        return { timing, geometry, image };
      });
    }
  });
}

async function inspectExport(context, { browser, url }, format, label) {
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(12_000);
    const { width, height } = format.media;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setCacheEnabled(false);
    const cards = [
      { kind: "chapter-bar", params: { chapters: "章节标记 0" } },
      { kind: "checklist", params: { title: "上方卡片", items: "测试条目一|测试条目二", position: "left" } },
      { kind: "punch-pill", params: { text: "下方卡片", position: "bottom" } },
      { kind: "caption-track", params: { lines: "0|3|字幕落位测试|Caption" } },
    ].map((card, i) => ({ id: `geometry-${i}`, start: 0, end: 3, ...card }));
    const doc = { version: 1, aspect: format.aspect, font: "Microsoft YaHei", theme: "dark", cards };
    await page.evaluateOnNewDocument((data) => { window.__EXPORT_DOC = JSON.stringify(data); }, doc);
    const response = await page.goto(`${url}/?export=1`);
    assert.ok(response?.ok(), `无法打开导出视图（HTTP ${response?.status()}）`);
    await page.waitForFunction(() => typeof window.__setExportT === "function");
    await page.evaluate(() => {
      window.__startExport();
      window.__setExportT(1.5);
    });
    await page.waitForSelector(".stage.is-export .ctrack-cue");
    await page.evaluate(async () => {
      await document.fonts.ready;
      const nextFrame = () => new Promise(requestAnimationFrame);
      await nextFrame();
      await nextFrame();
      await nextFrame();
      for (const animation of document.getAnimations()) {
        if (Number.isFinite(animation.effect.getComputedTiming().endTime)) animation.finish();
      }
      await nextFrame();
      await nextFrame();
    });
    const measured = await page.evaluate(async () => {
      const stage = document.querySelector(".stage.is-export");
      const { stageGeom, VERTICAL_VISIBLE, VERTICAL_LAYOUT } = await import("/src/stage.ts");
      const { width, height } = stage.getBoundingClientRect();
      const elements = Array.from(stage.querySelectorAll(".hud:not(.ctrack), .ctrack-cue"));
      const boxes = elements.map((element) => ({
        band: element.closest("[data-band]")?.dataset.band,
        ...element.getBoundingClientRect().toJSON(),
      }));
      return { width, height, geometry: stageGeom(), visible: VERTICAL_VISIBLE, layout: VERTICAL_LAYOUT, boxes };
    });
    const image = join(context.evidenceDir, `export-${label}.png`);
    await page.screenshot({ path: image, omitBackground: true });
    assert.equal(measured.width, width);
    assert.equal(measured.height, height);
    assert.ok(measured.boxes.length >= 4, "导出截图缺少验收卡片");
    if (format.aspect === "16:9") {
      const { edge, maxRightX, minLeftX, topEdge } = measured.geometry;
      assert.deepEqual([edge, maxRightX, minLeftX, topEdge], [120, 700, 1220, 96]);
    } else {
      assert.deepEqual(measured.visible, verticalVisible);
      assert.deepEqual(measured.layout, verticalBands);
      for (const band of Object.keys(verticalBands)) {
        assert.ok(measured.boxes.some((box) => box.band === band), `导出缺少 ${band} 区示例`);
      }
      for (const box of measured.boxes) {
        const { left, top, right, bottom } = verticalBands[box.band];
        assert.ok(box.left >= left - 1 && box.top >= top - 1 &&
          box.right <= right + 1 && box.bottom <= bottom + 1, `${box.band} 卡片超出安全位置`);
      }
    }
    return { ...measured, image, time: 1.5, font: doc.font };
  } finally {
    await page.close();
  }
}

export async function verifyGeometry(context) {
  const fixtures = await context.fixtures();
  await context.withEditor(async (editor) => {
    for (const { details: format } of fixtures.checks.filter(({ name }) => name.endsWith("-framing"))) {
      const label = format.aspect === "9:16" ? "portrait" : "landscape";
      await context.check(`focus-${label}`, () => inspectFocus(context, editor, fixtures, format, label));
      await context.check(`export-${label}`, () => inspectExport(context, editor, format, label));
    }
  });
  if (context.baselineDir) {
    const baseline = JSON.parse(await readFile(join(context.baselineDir, "result.json"), "utf8"));
    assert.equal(baseline.status, "passed", "几何基线未通过");
    for (const label of ["landscape", "portrait"]) {
      await context.check(`export-${label}-baseline`, async () => {
        const file = `export-${label}.png`;
        const [before, after] = await Promise.all([context.baselineDir, context.evidenceDir].map(async (dir) =>
          createHash("sha256").update(await readFile(join(dir, file))).digest("hex")));
        assert.equal(after, before, `${label} 导出画面与同环境基线有差异`);
        return { file, sha256: after };
      });
    }
  }
}
