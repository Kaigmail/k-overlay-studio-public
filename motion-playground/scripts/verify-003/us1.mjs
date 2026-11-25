import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureStage, importSources, openEditorPage, upload, videoReady } from "../verify-002/preview.mjs";
import { verifyMedia } from "../verify-002/media.mjs";
import { locateInputs } from "./baseline.mjs";

const run = promisify(execFile);
const jsonInput = '.production-heading input[accept=".json,application/json"]';
const timing = ".pp-card-timing";
const frameSelector = "[data-frame-index]";
const width = 1080;
const height = 1920;
const fps = 30;
const lastFrame = 135;
const statStart = 0.2;
const statEnd = 4.7;

async function command(file, args, options = {}) {
  const { stdout } = await run(file, args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024, ...options });
  return stdout;
}

function frame(page) {
  return page.$eval(frameSelector, (element) => Number(element.dataset.frameIndex));
}

async function waitFrame(page, expected) {
  await page.waitForFunction((selector, expected) =>
    Number(document.querySelector(selector)?.dataset.frameIndex) === expected, {}, frameSelector, expected);
}

async function step(page, delta) {
  const next = (await frame(page)) + delta;
  const label = delta > 0 ? "下一帧" : "上一帧";
  await page.$eval(`[aria-label="${label}"]`, (button) => button.click());
  await waitFrame(page, next);
}

export async function seekFrame(page, target, duration) {
  const time = Math.min(duration, (target + 0.2) / fps);
  await page.$eval(".tlb-ruler", (ruler, ratio) => {
    const box = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, button: 0, clientX: box.left + box.width * ratio, clientY: box.top + box.height / 2,
    }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  }, time / duration);
  let actual = await frame(page);
  assert.ok(Math.abs(actual - target) <= 2, `擦洗目标 ${target}，得到 ${actual}`);
  while (actual !== target) {
    await step(page, actual < target ? 1 : -1);
    actual = await frame(page);
  }
}

async function verifySelection(context, video, overlay, stat, across) {
  let result;
  await openEditorPage(context, async (page, dialogs) => {
    await importSources(page, video, overlay, "json-first");
    await videoReady(page, dialogs);
    const closeReport = await page.$(".lint-head-btns button:last-child");
    if (closeReport) await closeReport.click();
    await page.keyboard.down("Shift");
    for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift");
    for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight");
    await waitFrame(page, 660);
    await page.waitForFunction(() => {
      const source = document.querySelector(".stage-video");
      return source.paused && !source.seeking && Math.abs(source.currentTime - 22) < 0.001;
    });
    const target = `[data-card-id="${stat.id}"]`;
    const timeline = `.tlb-card${target}`;
    const list = `.fx-item${target}`;
    const canvas = `.stage ${target} .hud`;
    const checks = [];
    const record = async (entry, selected = stat.id) => {
      await page.waitForSelector(`.tlb-card.is-sel[data-card-id="${selected}"]`, { timeout: 2000 })
        .catch((error) => { throw new Error(`${entry} 未选中 ${selected}`, { cause: error }); });
      const index = await frame(page);
      assert.equal(index, 660, entry);
      const time = await page.$eval(".stage-video", (source) => source.currentTime);
      assert.ok(Math.abs(time - 22) < 0.001, entry);
      checks.push({ entry, selected, index, delta: index - 660, videoTime: time });
    };
    const chooseAnother = async () => {
      await page.locator('.fx-item[data-card-id="card-4"]').click();
    };
    await chooseAnother();
    await page.locator(list).click();
    await record("左栏");

    await chooseAnother();
    const block = await page.waitForSelector(timeline);
    await block.scrollIntoView();
    const box = await block.boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await page.evaluate(({ x, y }) => document.elementsFromPoint(x, y).slice(0, 8)
      .map((element) => [element.tagName, element.className, element.closest(".tlb-card")?.dataset.cardId]), center);
    assert.equal(hit[0]?.[2], stat.id, `时间轴点击点 ${JSON.stringify({ center, hit })}`);
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    try {
      await record("时间轴按下");
    } finally {
      await page.mouse.up();
    }
    await record("时间轴松开");

    await chooseAnother();
    const cardPoint = await page.$eval(canvas, (element) => {
      const box = element.getBoundingClientRect();
      for (const ry of [0.45, 0.6, 0.25, 0.75]) {
        for (const rx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
          const x = box.x + box.width * rx, y = box.y + box.height * ry;
          if (element.contains(document.elementFromPoint(x, y))) return { x, y };
        }
      }
      throw new Error("没有命中数字卡卡面");
    });
    await page.mouse.click(cardPoint.x, cardPoint.y);
    await record("画布卡面");

    await chooseAnother();
    await page.keyboard.press("ArrowDown");
    await record("列表向下键");

    await page.locator(`.fx-item[data-card-id="${across.id}"]`).click();
    await record("未出场卡", across.id);
    assert.match(await page.$eval(timing, (element) => element.textContent), /当前帧未出场.*50\.333/);
    assert.equal(await page.$(`.stage [data-card-id="${across.id}"]`), null);
    await captureStage(page, join(context.evidenceDir, "perez-22s-selection.png"));
    await page.locator(`${timing} button`).click();
    const first = Math.ceil(across.start * fps);
    await waitFrame(page, first);
    const playback = await verifyPlaybackTransitions(page, first, list);
    result = { checks, explicitLocation: { index: first, time: first / fps }, playback };
  });
  return result;
}

async function verifyPlaybackTransitions(page, first, cardSelector) {
  // 同一个浏览器任务内读帧号并触发选择或切换。
  const buttonSelector = ".topbar button";
  const playLabel = "▶ 播放";
  const advance = async (from) => {
    await page.locator(`${buttonSelector}::-p-text(${playLabel})`).click();
    await page.waitForFunction((selector, from) => !document.querySelector(".stage-video").paused &&
      Number(document.querySelector(selector)?.dataset.frameIndex) > from + 2, {}, frameSelector, from)
      .catch(async (error) => {
        const state = await page.$eval(".stage-video", (video) => ({
          paused: video.paused, seeking: video.seeking, ended: video.ended,
          currentTime: video.currentTime, readyState: video.readyState,
          frame: document.querySelector("[data-frame-index]")?.dataset.frameIndex,
        }));
        throw new Error(`从帧 ${from} 续播失败：${JSON.stringify(state)}`, { cause: error });
      });
  };
  const atClick = (selector) => page.evaluate((frameSelector, selector) => {
    const index = Number(document.querySelector(frameSelector).dataset.frameIndex);
    document.querySelector(selector).click();
    return index;
  }, frameSelector, selector);
  const assertPaused = async (index) => {
    await page.waitForFunction((time, selector, label) => {
      const source = document.querySelector(".stage-video");
      return source.paused && !source.seeking && Math.abs(source.currentTime - time) < 0.001 &&
        Array.from(document.querySelectorAll(selector)).some((button) => button.textContent.includes(label));
    }, {}, index / fps, buttonSelector, playLabel);
    await waitFrame(page, index);
  };
  await advance(first);
  const selectedAt = await atClick(cardSelector);
  await assertPaused(selectedAt);
  await advance(selectedAt);
  const switchedAt = await atClick(".tb-tab:nth-of-type(2)");
  await page.waitForFunction(() => {
    const source = document.querySelector(".stage-video");
    return source.loop && !source.paused;
  });
  await page.locator(".tb-tab:nth-of-type(1)").click();
  await assertPaused(switchedAt);
  await advance(switchedAt);
  return { selectedAt, switchedAt, resumedAt: await frame(page) };
}

async function overlayPage(context, file, visit) {
  let result;
  await openEditorPage(context, async (page, dialogs) => {
    await upload(page, jsonInput, file);
    await page.waitForSelector(".tlb-card");
    result = await visit(page);
    assert.deepEqual(dialogs, []);
  });
  return result;
}

export async function fullSize(page, w = width, h = height) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.addStyleTag({ content: `
    html, body, #root { background: transparent !important; }
    #root { visibility: hidden; }
    .stage.is-hud { visibility: visible; position: fixed !important; left: 0 !important; top: 0 !important;
      transform: none !important; border: none !important; background: transparent !important; }
    .stage::before, .stage .person, .stage .stage-video, .stage .canvas-safety-mask, .stage .card-edit-box { display: none !important; }
  ` });
}

export async function capture(page, file) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const pixels = await page.screenshot({ path: file, omitBackground: true });
  return createHash("sha256").update(pixels).digest("hex");
}

async function playTo(page, expected) {
  // 观察正常播放的帧显示，目标出现时调用默认播放键处理程序暂停。
  await page.evaluate((selector, expected) => new Promise((resolve, reject) => {
    const read = () => Number(document.querySelector(selector)?.dataset.frameIndex);
    const button = () => Array.from(document.querySelectorAll(".topbar button"))
      .find((candidate) => /播放|暂停/.test(candidate.textContent));
    const stop = () => {
      observer.disconnect();
      clearTimeout(timeout);
      button().click();
    };
    const observer = new MutationObserver(() => {
      const index = read();
      if (index < expected) return;
      stop();
      if (index === expected) resolve();
      else reject(new Error(`顺播跳过 ${expected}，得到 ${index}`));
    });
    const timeout = setTimeout(() => { stop(); reject(new Error("未到达目标帧")); }, 5000);
    observer.observe(document.querySelector(selector), { attributes: true });
    button().click();
  }), frameSelector, expected);
  await waitFrame(page, expected);
}

async function verifySamplePaths(context, file) {
  return overlayPage(context, file, async (page) => {
    await fullSize(page);
    const samples = [];
    await seekFrame(page, 5, 5);
    assert.equal(await page.$('.stage [data-card-id="sample-stat"]'), null, "起点前不能显示或命中卡片");
    for (const [label, index] of [["enter", 11], ["rolling", 39], ["exit", lastFrame]]) {
      const image = (route) => join(context.evidenceDir, `${label}-${route}.png`);
      for (let attempt = 0; ; attempt++) {
        await seekFrame(page, index - 7, 5);
        try {
          await playTo(page, index);
          break;
        } catch (error) {
          if (attempt === 2 || !error.message.includes("顺播跳过")) throw error;
        }
      }
      const sequential = await capture(page, image("playing"));
      await seekFrame(page, index + 4, 5);
      await seekFrame(page, index, 5);
      const located = await capture(page, image("direct"));
      await step(page, 1);
      await step(page, -1);
      const backward = await capture(page, image("backward"));
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await waitFrame(page, index);
      const frozen = await capture(page, image("paused-2s"));
      const routes = {};
      for (const [route, hash] of [["playing", sequential], ["backward", backward], ["paused-2s", frozen]]) {
        const difference = await measure(image("direct"), image(route));
        assert.ok(difference.boundsDelta === 0 && difference.alphaError <= 0.25 &&
          difference.premultipliedColorError <= 0.5, `${label} ${route} ${JSON.stringify(difference)}`);
        routes[route] = { hash, ...difference };
      }
      samples.push({ label, index, seconds: index / fps, preview: image("direct"), sha256: located, routes });
    }
    await seekFrame(page, 141, 5);
    assert.equal(await page.$('.stage [data-card-id="sample-stat"]'), null, "退场帧不能显示或命中卡片");
    return samples;
  });
}

async function verifyCardMedia(context, file) {
  return overlayPage(context, file, async (page) => {
    await fullSize(page);
    await seekFrame(page, 22, 2);
    const video = "[data-fx-video]";
    await page.waitForSelector(video);
    await page.waitForFunction((selector) => document.querySelector(selector)?.dataset.frameReady === "true", {}, video);
    await page.evaluate((selector) => {
      window.__us1Media = [];
      const video = document.querySelector(selector);
      const record = (_, metadata) => {
        window.__us1Media.push(metadata.mediaTime);
        video.requestVideoFrameCallback(record);
      };
      video.requestVideoFrameCallback(record);
    }, video);
    // 连续发出定位，给较早的请求机会进入解码器，再核对最后一次请求。
    const scrub = async (times) => page.$eval(".tlb-ruler", async (ruler, times) => {
      const box = ruler.getBoundingClientRect();
      for (const time of times) {
        ruler.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, button: 0, clientX: box.left + box.width * (time + 0.005) / 2, clientY: box.y + box.height / 2,
        }));
        window.dispatchEvent(new PointerEvent("pointerup"));
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }, times);
    const checkMedia = async (seconds, channel, label) => {
      const target = seconds - 0.11;
      const expected = Math.floor(target * 24 + 1e-9) / 24;
      await page.waitForFunction((selector, target, expected) => {
        const video = document.querySelector(selector);
        return video?.dataset.frameReady === "true" && video.paused && !video.seeking &&
          Math.abs(video.currentTime - target) < 0.001 && Math.abs(window.__us1Media.at(-1) - expected) < 0.001;
      }, {}, video, target, expected);
      const result = await page.$eval(video, (source) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d");
        paint.drawImage(source, 0, 0, 1, 1);
        return { currentTime: source.currentTime, presentedTime: window.__us1Media.at(-1), rgba: Array.from(paint.getImageData(0, 0, 1, 1).data) };
      });
      assert.ok(result.rgba[channel] > 180 && result.rgba.filter((_, i) => i < 3 && i !== channel).every((value) => value < 75));
      await capture(page, join(context.evidenceDir, `media-${label}.png`));
      return result;
    };
    await scrub([1.35, 0.3, 1.6, 0.4]);
    const red = await checkMedia(0.4, 0, "red");
    await scrub([0.4, 1.6, 0.7, 1.4]);
    const blue = await checkMedia(1.4, 2, "blue");
    return { red, blue };
  });
}

async function verifyLibraryReplay(context, file) {
  return overlayPage(context, file, async (page) => {
    await page.locator(".tb-tab:nth-of-type(2)").click();
    await page.locator('.fx-search input[type="search"]').fill("StatProof");
    await page.locator(".fx-item").filter((button) => button.querySelector(".fx-name")?.textContent.trim() === "StatProof").click();
    const motion = ".stage .spfx [data-fx-role='group'] > div:first-child";
    await page.waitForSelector(motion);
    await page.waitForFunction((motion) => {
      const transform = document.querySelector(motion)?.style.transform;
      return transform && Math.abs(new DOMMatrix(transform).m41) < 0.02;
    }, {}, motion);
    await page.$eval(".sidebar-foot .play-btn", (button) => button.click());
    await page.waitForFunction((motion) => {
      const transform = document.querySelector(motion)?.style.transform;
      return transform && new DOMMatrix(transform).m41 < -20;
    }, {}, motion);
    return { kind: "stat-proof", autoplay: true, replay: true };
  });
}

async function verifyTimedRegistry(context) {
  const page = await context.browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(context.url);
    const cards = await page.evaluate(async () => {
      const { EFFECTS } = await import("/src/effects/registry.ts");
      return EFFECTS.map(({ id }, i) => ({
        id, kind: id, start: i * 5 + 0.25, end: i * 5 + 4,
        seg: id === "stat-proof" ? "dim-check" : undefined,
        params: { speed: 1.25, dimAt: i * 5 + 2 },
      }));
    });
    assert.equal(cards.length, 20);
    const doc = { aspect: "9:16", breath: true, cards };
    await page.evaluateOnNewDocument((json) => { window.__EXPORT_DOC = json; }, JSON.stringify(doc));
    await page.goto(`${context.url}/?export=1&spd=1.6`);
    await page.waitForFunction(() => typeof window.__setExportT === "function");
    await page.addStyleTag({ content: `
      @keyframes us1-focus-check { from { opacity: .2; } to { opacity: 1; } }
      .stage [data-card-id="stat-proof"] .spfx { animation: us1-focus-check 2s linear 1s infinite alternate; }
    ` });
    const audit = await page.evaluate(async (cards) => {
      const sample = async (time, id) => {
        window.__setExportT(time);
        const shell = document.querySelector(`.stage [data-card-id="${id}"]`);
        if (!shell) return null;
        // SVG 初次出场时，先取字形外框触发字体加载，再等待字体就绪。
        shell.querySelectorAll("text").forEach((node) => node.getBoundingClientRect());
        await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return Array.from(shell.querySelectorAll("*"), (element) => {
          const style = getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return [element.localName, style.opacity, style.filter, style.transform, style.zoom,
            box.x, box.y, box.width, box.height,
            element.childElementCount ? "" : element.textContent];
        });
      };
      const results = [];
      for (const card of cards) {
        const before = await sample(card.start - 0.01, card.id);
        const direct = await sample(card.start + 1.3, card.id);
        await sample(card.start + 2.5, card.id);
        const backward = await sample(card.start + 1.3, card.id);
        const after = await sample(card.end, card.id);
        results.push({ kind: card.kind, before: before === null, after: after === null,
          elements: direct?.length, identical: JSON.stringify(direct) === JSON.stringify(backward) });
      }
      const card = cards.find(({ kind }) => kind === "stat-proof");
      await sample(card.start + 1.3, card.id);
      const root = document.querySelector('[data-card-id="stat-proof"] .spfx');
      const animation = root.getAnimations().find((item) => item.animationName === "us1-focus-check");
      const css = { playState: animation.playState, currentTime: animation.currentTime,
        delay: animation.effect.getTiming().delay };
      await sample(card.params.dimAt + 0.45, card.id);
      const dim = getComputedStyle(root).filter;
      const zoom = getComputedStyle(root.closest(".hud-anchor")).zoom;
      return { results, css, dim, zoom };
    }, cards);
    for (const item of audit.results) {
      assert.ok(item.before && item.after && item.elements > 0 && item.identical, JSON.stringify(item));
    }
    assert.equal(audit.css.playState, "paused");
    assert.ok(Math.abs(audit.css.currentTime - 2600) < 0.001 && audit.css.delay === 1000, JSON.stringify(audit.css));
    assert.match(audit.dim, /opacity\(0\.5/);
    assert.ok(Number(audit.zoom) > 0.6 && Number(audit.zoom) < 1);
    return audit;
  } finally {
    await page.close();
  }
}

export async function exportFrame(mov, index, target) {
  await command("ffmpeg", ["-v", "error", "-i", mov, "-vf", `select=eq(n\\,${index})`,
    "-frames:v", "1", "-threads", "1", target]);
}

export async function render(context, job, name) {
  const file = join(context.evidenceDir, `${name}-job.json`);
  await writeFile(file, JSON.stringify({ ...job, fps, base: context.url, keepFrames: true }));
  const output = await command(process.execPath, ["scripts/export-frames.mjs", file], {
    cwd: context.root, timeout: 240_000,
  }).catch(async (error) => {
    await writeFile(join(context.evidenceDir, `${name}-render.log`), [error.stdout, error.stderr].join("\n"));
    throw error;
  });
  await writeFile(join(context.evidenceDir, `${name}-render.log`), output);
  const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.ok(result.ok && result.mov && result.dir, "没有得到真实 MOV 及渲染帧");
  return result;
}

export async function measure(preview, target) {
  const rgba = (file) => command("ffmpeg", [
    "-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=540:960:flags=area,format=rgba",
    "-threads", "1", "-f", "rawvideo", "pipe:1",
  ], { encoding: "buffer" });
  const [a, b] = await Promise.all([rgba(preview), rgba(target)]);
  const dimensions = [540, 960];
  const bounds = (bytes) => {
    const box = [dimensions[0], dimensions[1], -1, -1];
    for (let i = 0; i < bytes.length / 4; i++) {
      if (bytes[i * 4 + 3] <= 24) continue;
      const x = i % dimensions[0], y = Math.floor(i / dimensions[0]);
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
    }
    assert.ok(box[2] >= box[0] && box[3] >= box[1], "动效消失");
    return box;
  };
  const boxes = [bounds(a), bounds(b)];
  const boundsDelta = Math.max(...boxes[0].map((value, i) => Math.abs(value - boxes[1][i])));
  let color = 0, alpha = 0, total = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] > 8 || b[i + 3] > 8) {
      total++;
      alpha += Math.abs(a[i + 3] - b[i + 3]);
      for (let channel = 0; channel < 3; channel++) {
        color += Math.abs(a[i + channel] * a[i + 3] - b[i + channel] * b[i + 3]) / 255;
      }
    }
  }
  return { boxes, boundsDelta, alphaError: alpha / total, premultipliedColorError: color / (3 * total) };
}

export async function verifyUS1(context) {
  const [video, , overlay] = await locateInputs(context.caseDir);
  const original = JSON.parse(await readFile(overlay, "utf8"));
  const stat = original.cards.find((card) => card.kind === "stat-proof" && card.start <= 22 && card.end > 22);
  const across = original.cards.find((card) => card.start > 50);
  assert.ok(stat && across);
  const selection = await verifySelection(context, video, overlay, stat, across);
  assert.ok(selection, "需要保存选卡证据");
  const registry = await verifyTimedRegistry(context);
  const missingSource = "/_media/us1-missing-focus.mp4";
  await assert.rejects(render(context, {
    doc: { aspect: "9:16", cards: [{ id: "missing-media", kind: "focus-card", start: 0, end: 1,
      params: { camSrc: missingSource } }] },
    duration: 1 / fps,
  }, "missing-media"), (error) => error.code === 1 &&
    error.stderr.includes(`卡内视频无法读取或抽帧，请检查素材路径并重新导出：${missingSource}`));

  const doc = { aspect: original.aspect, theme: original.theme, glow: original.glow, breath: original.breath,
    cards: [{ ...stat, id: "sample-stat", seg: undefined, start: statStart, end: statEnd,
      params: { ...stat.params, dimAt: stat.params.dimAt - stat.start + statStart } }],
  };
  // 用透明片尾留出时段外的 9 帧，保持原卡 4.5 秒演出。
  const sampleFile = join(context.evidenceDir, "perez-short.json");
  await writeFile(sampleFile, JSON.stringify({ ...doc, cards: [...doc.cards, {
    id: "length-marker", kind: "caption-track", start: 4.7, end: 5, params: { lines: "" },
  }] }));
  const library = await verifyLibraryReplay(context, sampleFile);
  const samples = await verifySamplePaths(context, sampleFile);
  const rendered = await render(context, { doc, duration: 5 }, "perez-us1");
  const mov = await verifyMedia({ command }, rendered.mov, "mov", { width, height, frames: 150, rate: "30/1" });
  assert.match(mov.video.pix_fmt, /yuva/);
  for (const sample of samples) {
    const png = join(rendered.dir, `frame_${String(sample.index).padStart(6, "0")}.png`);
    const extracted = join(context.evidenceDir, `${sample.label}-mov.png`);
    await exportFrame(rendered.mov, sample.index, extracted);
    sample.renderedPng = png;
    sample.movFrame = extracted;
    sample.rawDifference = await measure(sample.preview, png);
    sample.movDifference = await measure(sample.preview, extracted);
    assert.ok(sample.rawDifference.boundsDelta <= 1 && sample.rawDifference.alphaError <= 2 &&
      sample.rawDifference.premultipliedColorError <= 2, JSON.stringify(sample));
    assert.ok(sample.movDifference.boundsDelta <= 1 && sample.movDifference.alphaError <= 3 &&
      sample.movDifference.premultipliedColorError <= 6, JSON.stringify(sample));
  }

  const mediaFolder = join(context.root, "public", "_media");
  await mkdir(mediaFolder, { recursive: true });
  const media = "us1-marker.mp4";
  await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:s=270x480:r=24:d=1",
    "-f", "lavfi", "-i", "color=blue:s=270x480:r=24:d=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,scale=in_color_matrix=bt601:out_color_matrix=bt709",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709",
    "-color_trc", "bt709", join(mediaFolder, media)]);
  const mediaDoc = { aspect: "9:16", cards: [{ id: "media", kind: "focus-card", start: 0, end: 2,
    params: { camSrc: `/_media/${media}`, camDelay: 0.11 },
  }] };
  const mediaFile = join(context.evidenceDir, "media.json");
  await writeFile(mediaFile, JSON.stringify(mediaDoc));
  const mediaChecks = await verifyCardMedia(context, mediaFile);
  const mediaRender = await render(context, { doc: mediaDoc, duration: 1.5 }, "media-us1");
  for (const [label, index] of [["red", 12], ["blue", 42]]) {
    const png = join(mediaRender.dir, `frame_${String(index).padStart(6, "0")}.png`);
    const preview = join(context.evidenceDir, `media-${label}.png`);
    const difference = await measure(preview, png);
    // 浏览器视频走系统色彩管理，素材 JPEG 和 ProRes 使用各自的色彩转换。
    assert.ok(difference.boundsDelta <= 1 && difference.alphaError <= 3 &&
      difference.premultipliedColorError <= 15, JSON.stringify(difference));
    const movFrame = join(context.evidenceDir, `media-${label}-mov.png`);
    await exportFrame(mediaRender.mov, index, movFrame);
    const movDifference = await measure(preview, movFrame);
    assert.ok(movDifference.boundsDelta <= 1 && movDifference.alphaError <= 3 &&
      movDifference.premultipliedColorError <= 17, JSON.stringify(movDifference));
    mediaChecks[label] = { ...mediaChecks[label], index, preview, renderedPng: png, difference, movFrame, movDifference };
  }
  return { selection, registry, library, missingMediaRejected: true, samples, mov, media: { results: mediaChecks, mov: mediaRender.mov } };
}
