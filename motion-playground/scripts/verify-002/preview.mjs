import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const large = { width: 1440, height: 1000, deviceScaleFactor: 1 };
const small = { width: 1120, height: 800, deviceScaleFactor: 1 };
const editorJson = '.topbar input[type=file][accept=".json,application/json"]';
const preparationJson = '.production-heading input[type=file][accept=".json,application/json"]';
const editorVideo = '.topbar input[type=file][accept="video/*"]';

export async function openEditorPage({ browser, url }, visit) {
  const session = await browser.createBrowserContext();
  try {
    const page = await session.newPage();
    page.setDefaultTimeout(12_000);
    await page.setViewport(large);
    const dialogs = [];
    page.on("dialog", async (dialog) => {
      if (dialog.type() === "confirm") await dialog.accept();
      else {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      }
    });
    const response = await page.goto(url);
    assert.ok(response?.ok(), "打开编辑台失败");
    await page.waitForSelector(preparationJson);
    await visit(page, dialogs);
  } finally {
    await session.close();
  }
}

export async function upload(page, selector, file) {
  const input = await page.waitForSelector(selector);
  await input.uploadFile(file);
}

export async function importSources(page, video, overlay, order) {
  if (order === "json-first") {
    await upload(page, preparationJson, overlay);
    await page.waitForSelector(".tlb-card");
    await upload(page, editorVideo, video);
  } else {
    await page.locator('::-p-text(手动编排)').click();
    await upload(page, editorVideo, video);
    await page.waitForSelector(".stage-video");
    await upload(page, editorJson, overlay);
    await page.waitForSelector(".tlb-card");
  }
}

export async function videoReady(page, dialogs) {
  await page.waitForFunction(() => {
    const video = document.querySelector(".stage-video");
    return video && (video.error || (video.readyState >= 2 && video.videoWidth));
  }).catch((error) => {
    throw new Error(`未取到可解码视频帧：${dialogs.join("；") || error.message}`);
  });
  const info = await page.$eval(".stage-video", (video) => ({
    width: video.videoWidth, height: video.videoHeight, duration: video.duration,
    error: video.error && { code: video.error.code, message: video.error.message },
  }));
  assert.ok(!info.error, `视频解码失败：${JSON.stringify(info.error)} ${dialogs.join("；")}`);
  assert.equal(dialogs.length, 0, dialogs.join("；"));
  return info;
}

export async function seekVideo(page, time, duration) {
  const target = await page.$eval(".tlb-ruler", (ruler, ratio) => {
    const rect = ruler.getBoundingClientRect();
    return { x: rect.left + rect.width * ratio, y: rect.top + rect.height / 2, secondsPerPixel: 1 / rect.width };
  }, time / duration);
  const tolerance = Math.max(0.04, duration * target.secondsPerPixel);
  await page.evaluate(() => {
    const video = document.querySelector(".stage-video");
    window.__verify002Frame = null;
    video.requestVideoFrameCallback((_, metadata) => {
      window.__verify002Frame = metadata.mediaTime;
    });
  });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction((time, tolerance) => {
    const video = document.querySelector(".stage-video");
    return video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - time) <= tolerance;
  }, {}, time, tolerance);
  return page.$eval(".stage-video", (video) => ({
    currentTime: video.currentTime,
    presentedTime: window.__verify002Frame,
  }));
}

export async function captureStage(page, path) {
  const box = await page.$eval(".stage", (stage) => {
    const box = stage.getBoundingClientRect();
    const xScale = box.width / stage.offsetWidth;
    const yScale = box.height / stage.offsetHeight;
    return {
      ...box.toJSON(),
      content: {
        x: box.left + stage.clientLeft * xScale,
        y: box.top + stage.clientTop * yScale,
        width: stage.clientWidth * xScale,
        height: stage.clientHeight * yScale,
      },
    };
  });
  const x = Math.ceil(box.left) + 1;
  const y = Math.ceil(box.top) + 1;
  const clip = { x, y, width: Math.floor(box.right) - x - 1, height: Math.floor(box.bottom) - y - 1 };
  await page.screenshot({ path, clip });
  return { clip, content: box.content };
}

export async function videoGeometry(page) {
  return page.$eval(".stage-video", (video) => {
    const stage = video.closest(".stage");
    const style = getComputedStyle(video);
    const number = (name) => parseFloat(style[name]);
    const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
    return {
      stage: { width: stage.clientWidth, height: stage.clientHeight },
      video: { x: number("left"), y: number("top"), width: number("width"), height: number("height") },
      scale: matrix.a, fit: style.objectFit, position: style.objectPosition, focused: video.classList.contains("is-pip"),
    };
  });
}

export function fullView(measured) {
  const { fit, scale, video, stage, focused } = measured;
  return !focused && fit === "contain" && Math.abs(scale - 1) < 0.001 &&
    Math.abs(video.width - stage.width) < 2 && Math.abs(video.height - stage.height) < 2 &&
    Math.abs(video.x) < 1 && Math.abs(video.y) < 1;
}

async function readRgb(context, file, { width, height }) {
  return context.command("ffmpeg", [
    "-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo",
    "-pix_fmt", "rgb24", "pipe:1",
  ], { encoding: "buffer", maxBuffer: width * height * 3 + 4096 });
}

async function compareFrame(context, page, input, info, timing, label, samples) {
  // 隐藏参考线和动效层，仅比较底部视频的实际像素；保留另外的实际界面截图。
  const ui = join(context.evidenceDir, `${label}-editor.png`);
  const actual = join(context.evidenceDir, `${label}-preview.png`);
  const reference = join(context.evidenceDir, `${label}-source.png`);
  const difference = join(context.evidenceDir, `${label}-difference.png`);
  await page.screenshot({ path: ui });
  const masked = await page.addStyleTag({ content: ".stage > :not(.stage-video) { visibility: hidden !important; }" });
  const { clip, content } = await captureStage(page, actual);
  await masked.evaluate((style) => style.remove());
  const fit = Math.min(content.width / info.width, content.height / info.height);
  const width = Math.round(info.width * fit);
  const height = Math.round(info.height * fit);
  const left = Math.round(content.x + (content.width - width) / 2 - clip.x);
  const top = Math.round(content.y + (content.height - height) / 2 - clip.y);
  const padX = Math.max(left, 0);
  const padY = Math.max(top, 0);
  const cropX = Math.max(-left, 0);
  const cropY = Math.max(-top, 0);
  const paddedWidth = Math.max(width + padX, clip.width + cropX);
  const paddedHeight = Math.max(height + padY, clip.height + cropY);
  const filters = [
    `scale=${width}:${height}:flags=bicubic`,
    "format=rgb24",
    `pad=${paddedWidth}:${paddedHeight}:${padX}:${padY}`,
    `crop=${clip.width}:${clip.height}:${cropX}:${cropY}`,
  ];
  const frameTime = timing.presentedTime ?? timing.currentTime;
  await context.command("ffmpeg", [
    "-v", "error", "-ss", String(Math.max(0, frameTime - 0.0001)), "-i", input, "-frames:v", "1",
    "-vf", filters.join(","),
    "-threads", "1", reference,
  ]);
  await context.command("ffmpeg", [
    "-v", "error", "-i", actual, "-i", reference, "-filter_complex", "blend=all_mode=difference",
    "-frames:v", "1", "-threads", "1", difference,
  ]);
  const [actualRgb, expectedRgb] = await Promise.all([readRgb(context, actual, clip), readRgb(context, reference, clip)]);
  const marks = samples?.map((sample) => {
    const x = left + Math.round(sample.x * width / info.width);
    const y = top + Math.round(sample.y * height / info.height);
    const offset = (y * clip.width + x) * 3;
    const rgb = [...actualRgb.subarray(offset, offset + 3)];
    const delta = Math.max(...rgb.map((value, i) => Math.abs(value - sample.decodedRgb[i])));
    return { feature: sample.feature, x, y, rgb, delta };
  });
  const counts = [0, 0, 0, 0];
  const totals = [0, 0, 0, 0];
  for (let y = Math.max(top, 0) + 3; y < Math.min(top + height, clip.height) - 3; y++) {
    for (let x = Math.max(left, 0) + 3; x < Math.min(left + width, clip.width) - 3; x++) {
      const quadrant = Number(x >= left + width / 2) + 2 * Number(y >= top + height / 2);
      const offset = (y * clip.width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        totals[quadrant] += Math.abs(actualRgb[offset + channel] - expectedRgb[offset + channel]);
        counts[quadrant]++;
      }
    }
  }
  return {
    frameTime, clip, fitRect: { left, top, width, height }, marks,
    errorByQuadrant: totals.map((total, i) => Math.round(100 * total / counts[i]) / 100),
    images: { ui, actual, reference, difference },
  };
}

export async function saveFraming(context, page, input, info, timing, label, samples) {
  const geometry = await videoGeometry(page);
  const pixels = await compareFrame(context, page, input, info, timing, label, samples);
  const details = { input, info, timing, geometry, pixels };
  await writeFile(join(context.evidenceDir, `${label}.json`), JSON.stringify(details, null, 2) + "\n");
  assert.ok(fullView(geometry), `${label} 未以默认倍率完整适应画布：${JSON.stringify(geometry)}`);
  // 浏览器与 FFmpeg 的 YUV→RGB 矩阵可能不同，保留色差容限，位置仍须对上。
  assert.ok(pixels.marks?.every(({ delta }) => delta <= 36) ?? true, `${label} 有四边色标或中心圆采样不符`);
  assert.ok(pixels.errorByQuadrant.every((value) => value <= 22), `${label} 和原片构图像素差过大：${pixels.errorByQuadrant}`);
  return details;
}

async function checkControls(page) {
  const selector = ".panel-left .production-shelf-tabs button";
  const tabs = await page.$$(selector);
  assert.ok(tabs.length >= 2, "侧栏标签缺失");
  await tabs[1].click();
  await tabs[0].click();
  assert.ok(await page.$(".panel-left .fx-list"), "切换回侧栏编排后卡片列表不可用");
}

async function compareBaseline(context) {
  const files = await readdir(context.evidenceDir);
  const labels = files.filter((file) => /^(real-|landscape-|portrait-).+\.json$/.test(file));
  assert.ok(labels.length > 0, "缺少本次预览帧记录");
  return Promise.all(labels.map(async (file) => {
    const beforeFile = join(context.baselineDir, file);
    const afterFile = join(context.evidenceDir, file);
    const [before, after] = await Promise.all([beforeFile, afterFile].map(async (path) =>
      JSON.parse(await readFile(path, "utf8"))));
    assert.equal(after.input, before.input, `${file} 使用了不同素材`);
    assert.ok(Math.abs(after.pixels.frameTime - before.pixels.frameTime) <= 1 / 24, `${file} 对照帧时间不同`);
    return {
      file, sourceTime: after.pixels.frameTime, beforeFile, afterFile,
      before: { geometry: before.geometry, errorByQuadrant: before.pixels.errorByQuadrant },
      after: { geometry: after.geometry, errorByQuadrant: after.pixels.errorByQuadrant },
    };
  }));
}

export async function verifyPreview(context) {
  const fixtures = await context.fixtures();
  await context.withEditor(async (editor) => {
    if (context.caseDir) {
      const filenames = await readdir(context.caseDir);
      const media = filenames.filter((name) => name.toLowerCase().endsWith(".mp4"));
      const overlays = filenames.filter((name) => name.toLowerCase().endsWith(".json"));
      assert.equal(media.length, 1, "真实案例目录应只有一份 MP4");
      assert.equal(overlays.length, 1, "真实案例目录应只有一份编排 JSON");
      const video = join(context.caseDir, media[0]);
      const overlay = join(context.caseDir, overlays[0]);
      for (const order of ["json-first", "video-first"]) {
        let mediaInfo;
        await openEditorPage(editor, async (page, dialogs) => {
          const decoded = await context.check(`real-hevc-${order}`, async () => {
            await importSources(page, video, overlay, order);
            mediaInfo = await videoReady(page, dialogs);
            return mediaInfo;
          });
          if (!decoded) {
            await page.screenshot({ path: join(context.evidenceDir, `real-${order}-decode-failure.png`) });
            context.skip(`real-framing-${order}`, "真实原片未解码，当前无法判断裁切。");
            return;
          }
          await context.check(`real-framing-${order}`, async () => {
            const timing = await seekVideo(page, 12.25, mediaInfo.duration);
            return saveFraming(context, page, video, mediaInfo, timing, `real-${order}`);
          });
          await page.setViewport(small);
          await context.check(`real-framing-${order}-resized`, async () => {
            const timing = await seekVideo(page, 12.25, mediaInfo.duration);
            return saveFraming(context, page, video, mediaInfo, timing, `resized-real-${order}`);
          });
        });
      }
    } else {
      context.skip("real-case", "未提供 --case-dir。");
    }

    const sourceFormats = fixtures.checks.filter(({ name }) => name.endsWith("-framing")).map(({ details }) => details);
    for (const format of sourceFormats) {
      const video = join(fixtures.dir, format.file);
      const overlay = join(fixtures.dir, format.overlays.find(({ purpose }) => purpose === "focus").file);
      const opposite = sourceFormats.find((test) => format.aspect !== test.aspect);
      const oppositeDoc = join(fixtures.dir, opposite.overlays.find(({ purpose }) => purpose === "focus").file);
      const label = format.aspect === "9:16" ? "portrait" : "landscape";
      await openEditorPage(editor, async (page, dialogs) => {
        let info;
        const ready = await context.check(`fixture-${label}-decode`, async () => {
          await importSources(page, video, overlay, "json-first");
          info = await videoReady(page, dialogs);
          return info;
        });
        if (!ready) return;
        await context.check(`fixture-${label}-focus-lightness-default`, async () => {
          const value = await page.$$eval("label.ctrl", (rows) => rows
            .find((row) => row.textContent.includes("主题背景深浅"))?.querySelector(".ctrl-val")?.textContent);
          assert.equal(value, "0");
          return { value };
        });
        const timing = await seekVideo(page, format.focusTimes.after, info.duration);
        await context.check(`fixture-${label}-large`, () =>
          saveFraming(context, page, video, info, timing, `${label}-large`, format.samples));
        await page.setViewport(small);
        await context.check(`fixture-${label}-small`, () =>
          saveFraming(context, page, video, info, timing, `${label}-small`, format.samples));
        await context.check(`fixture-${label}-controls`, async () => {
          await checkControls(page);
          return seekVideo(page, format.focusTimes.before, info.duration);
        });
        await context.check(`fixture-${label}-different-aspect`, async () => {
          const wasVertical = format.aspect === "9:16";
          await upload(page, editorJson, oppositeDoc);
          await page.waitForFunction((previous) => document.querySelector(".stage").classList.contains("is-vertical") !== previous, {}, wasVertical);
          const shifted = await seekVideo(page, format.focusTimes.after, info.duration);
          return saveFraming(context, page, video, info, shifted, `${label}-different-aspect`, format.samples);
        });
        await context.check(`fixture-${label}-replace-resets-scale`, async () => {
          const zoom = await page.waitForSelector('.panel-left label.scale-row input[type=range]');
          const slider = await page.$$('label.scale-row');
          const videoZoom = (await Promise.all(slider.map((item) => item.evaluate((element) => element.textContent)))).findIndex((text) => text.includes("视频画面缩放"));
          assert.ok(zoom && videoZoom >= 0, "未找到视频缩放控件");
          const input = await slider[videoZoom].$("input");
          await input.focus();
          await page.keyboard.press("End");
          assert.equal((await videoGeometry(page)).scale, 2);
          const oldSrc = await page.$eval(".stage-video", (element) => element.currentSrc);
          const oldTime = await page.$eval(".stage-video", (element) => element.currentTime);
          assert.ok(oldTime > 1, "替换前必须先移动播放头");
          await upload(page, editorVideo, join(fixtures.dir, opposite.file));
          await page.waitForFunction((previous) => {
            const element = document.querySelector(".stage-video");
            return element?.currentSrc && element.currentSrc !== previous;
          }, {}, oldSrc);
          await videoReady(page, dialogs);
          await page.waitForFunction((time) => {
            const video = document.querySelector(".stage-video");
            return !video.seeking && Math.abs(video.currentTime - time) < 0.04;
          }, {}, oldTime);
          const geometry = await videoGeometry(page);
          assert.equal(geometry.scale, 1, "替换口播后应恢复默认倍率");
          return { ...geometry, oldTime, newTime: await page.$eval(".stage-video", (video) => video.currentTime) };
        });
      });
    }
  });
  if (context.baselineDir) {
    await context.check("baseline-comparison", () => compareBaseline(context));
  }
}
