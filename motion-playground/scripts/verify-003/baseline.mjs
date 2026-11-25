import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { captureStage, importSources, openEditorPage, upload, videoReady } from "../verify-002/preview.mjs";

const exec = promisify(execFile);

async function fingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const { size } = await stat(file);
  return { name: basename(file), bytes: size, sha256: hash.digest("hex") };
}

export async function locateInputs(caseDir) {
  assert.ok(caseDir, "此验收需要 --case-dir 佩雷斯案例目录。");
  const files = await readdir(caseDir, { withFileTypes: true });
  return [".mp4", ".srt", ".json"].map((extension) => {
    const choices = files.filter((file) => file.isFile() && extname(file.name).toLowerCase() === extension);
    assert.equal(choices.length, 1, `案例目录需有且仅有一个 ${extension} 文件。`);
    return join(caseDir, choices[0].name);
  });
}

async function moveFromStart(page, seconds) {
  await page.keyboard.down("Shift");
  try {
    for (let step = 0; step < Math.floor(seconds / 3); step++) await page.keyboard.press("ArrowRight");
  } finally {
    await page.keyboard.up("Shift");
  }
  for (let step = 0; step < (seconds % 3) * 2; step++) await page.keyboard.press("ArrowRight");
  const clock = `当前 0:${String(seconds).padStart(2, "0")}.0`;
  await page.waitForFunction((expected) =>
    document.querySelector(".tlb-info")?.textContent.includes(expected), {}, clock);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // 旧版卡片入场由挂载驱动。取样时等待本轮入场结束，固定记录这一取样条件。
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });
}

async function stageMetrics(page) {
  return page.$eval(".stage", (stage) => {
    const rect = stage.getBoundingClientRect();
    const scale = rect.width / stage.offsetWidth;
    const x0 = rect.x + stage.clientLeft * scale;
    const y0 = rect.y + stage.clientTop * scale;
    const measure = (element) => {
      const box = element.getBoundingClientRect();
      return {
        x: (box.x - x0) / scale, y: (box.y - y0) / scale,
        width: box.width / scale, height: box.height / scale,
      };
    };
    const pin = stage.querySelector(".seg-stack .pbx");
    const stat = stage.querySelector(".seg-stack .spfx");
    const group = pin?.closest(".seg-stack");
    return {
      width: stage.offsetWidth, height: stage.offsetHeight, content: [stage.clientWidth, stage.clientHeight], scale, viewport: [innerWidth, innerHeight],
      fontStack: getComputedStyle(stage.querySelector(".hud") ?? stage).fontFamily,
      sameGroup: !!group && group === stat?.closest(".seg-stack"),
      groupRect: group && measure(group),
      cards: [pin, stat].map((element) => element && measure(element)),
    };
  });
}

async function prepareFixtures(context, original, members, video) {
  const dir = join(context.evidenceDir, "fixtures");
  await mkdir(dir);
  const fixture = async (name, cards) => {
    const file = join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify({ ...original, cards }, null, 2) + "\n", { flag: "wx" });
    return file;
  };
  const [first, second] = members;
  const mediaName = "003-card-media.mp4";
  const media = join(dir, mediaName);
  await exec("ffmpeg", [
    "-v", "error", "-n", "-ss", "22", "-i", video, "-t", "2", "-map", "0:v:0", "-an",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", media,
  ], { timeout: 30_000 });
  const mediaDir = join(context.root, "public", "_media");
  await mkdir(mediaDir, { recursive: true });
  await copyFile(media, join(mediaDir, mediaName));
  return {
    firstMemberExits: await fixture("first-member-exits", [{ ...first, end: 22 }, second]),
    cardMedia: await fixture("card-media", [{
      id: "verify-media", kind: "focus-card", start: second.start, end: second.end,
      params: { camSrc: `/_media/${mediaName}` },
    }]),
    cardMediaSource: media,
    numberBoundary: await fixture("number-boundary", [{
      ...second, params: { ...second.params, value: "-12,345.60" },
    }]),
  };
}

export async function verifyBaseline(context) {
  const [video, subtitle, overlay] = await locateInputs(context.caseDir);
  const demo = join(context.appRoot, "public", "demo", "demo-overlay.json");
  const portraitDemo = join(context.appRoot, "public", "demo", "demo-916-overlay.json");
  const original = JSON.parse(await readFile(overlay, "utf8"));
  const active = original.cards.filter((card) => card.start <= 22 && 22 < card.end);
  const members = active.filter(({ seg, kind }) => seg && ["pin-board", "stat-proof"].includes(kind))
    .sort((left, right) => left.start - right.start);
  assert.deepEqual(members.map(({ kind }) => kind), ["pin-board", "stat-proof"]);
  assert.equal(members[0].seg, members[1].seg);
  const inputs = await Promise.all([video, subtitle, overlay, demo, portraitDemo].map(fingerprint));
  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: context.appRoot });
  const { stdout } = await exec("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,r_frame_rate", "-of", "json", video,
  ]);
  const [sourceStream] = JSON.parse(stdout).streams;
  let portrait;
  await openEditorPage(context, async (page, dialogs) => {
    await importSources(page, video, overlay, "json-first");
    const videoInfo = await videoReady(page, dialogs);
    await upload(page, '.panel-left input[accept=".srt"]', subtitle);
    await page.locator("::-p-text(字幕稿)").filter((button) => button.matches("button")).click();
    await page.waitForSelector(".srt-line");
    const subtitleLines = await page.$$eval(".srt-line", (lines) => lines.length);
    await page.locator(".side-tabs button:first-child").click();

    await moveFromStart(page, 22);
    await page.waitForFunction(() => {
      const video = document.querySelector(".stage-video");
      return video.paused && !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 22) < 0.001;
    });
    const geometry = await stageMetrics(page);
    assert.deepEqual([geometry.width, geometry.height], [1080, 1920]);
    assert.equal(geometry.sameGroup, true, "基线应渲染出同一组里的两张卡。");
    assert.ok(geometry.cards.every((box) => box.width > 0 && box.height > 0));
    const screenshot = join(context.evidenceDir, "perez-22s.png");
    await captureStage(page, screenshot);
    portrait = {
      aspect: original.aspect, seconds: 22, preset: { fps: 30, resolution: "1080p", frameIndex: 660 },
      video: { ...videoInfo, ...sourceStream }, subtitleLines, screenshot, geometry,
      cards: members.map(({ id, kind, seg, start, end }) => ({ id, kind, seg, start, end })),
    };
  });

  let landscape;
  await openEditorPage(context, async (page, dialogs) => {
    await page.locator("::-p-text(打开示例)").click();
    await page.waitForSelector(".tlb-card");
    await moveFromStart(page, 3);
    const geometry = await stageMetrics(page);
    assert.deepEqual([geometry.width, geometry.height], [1920, 1080]);
    assert.equal(dialogs.length, 0, dialogs.join("；"));
    const screenshot = join(context.evidenceDir, "demo-landscape.png");
    await captureStage(page, screenshot);
    landscape = { aspect: "16:9", seconds: 3, preset: { fps: 30, resolution: "1080p", frameIndex: 90 }, geometry, screenshot };
  });

  let verticalExample;
  await openEditorPage(context, async (page, dialogs) => {
    await upload(page, '.production-heading input[accept=".json,application/json"]', portraitDemo);
    await page.waitForSelector(".tlb-card");
    await moveFromStart(page, 3);
    const geometry = await stageMetrics(page);
    assert.deepEqual([geometry.width, geometry.height], [1080, 1920]);
    assert.equal(dialogs.length, 0, dialogs.join("；"));
    const screenshot = join(context.evidenceDir, "demo-portrait.png");
    await captureStage(page, screenshot);
    verticalExample = { aspect: "9:16", seconds: 3, preset: { fps: 30, resolution: "1080p", frameIndex: 90 }, geometry, screenshot };
  });

  const fixtures = await prepareFixtures(context, original, members, video);
  assert.deepEqual(await Promise.all([video, subtitle, overlay, demo, portraitDemo].map(fingerprint)), inputs);
  return {
    commit: commit.trim(), browser: await context.browser.version(), inputs, portrait, landscape, verticalExample, fixtures,
    sampleMethod: "普通编辑台，快捷键定位，字体就绪及入场等待两秒。帧号按 1080p/30 成品预设计算。",
  };
}
