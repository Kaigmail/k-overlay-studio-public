import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { verifyMedia } from "./media.mjs";

const duration = 2;
const resolutions = ["720p", "1080p"];
const groups = [
  { id: "landscape-24", aspect: "16:9", fps: 24, width: 1920, height: 1080, title: "横屏 24 fps" },
  { id: "landscape-30", aspect: "16:9", fps: 30, width: 1920, height: 1080, title: "横屏 30 fps" },
  { id: "portrait-24", aspect: "9:16", fps: 24, width: 1080, height: 1920, title: "竖屏 24 fps" },
  { id: "portrait-30", aspect: "9:16", fps: 30, width: 1080, height: 1920, title: "竖屏 30 fps" },
];

async function fingerprint(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  assert.ok(bytes > 0, `文件为空：${path}`);
  return { bytes, sha256: hash.digest("hex") };
}

function timecode(frame, fps) {
  const pad = (value) => String(value).padStart(2, "0");
  return `00:00:${pad(Math.floor(frame / fps))}:${pad(frame % fps)}`;
}

async function makeBackground(context, group, source, path) {
  const { width, height, fps } = group;
  const start = group.aspect === "9:16" ? "12.25" : "0";
  await context.command("ffmpeg", [
    "-v", "error", "-n", "-ss", start, "-i", source, "-map", "0:v:0", "-an",
    "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    "-frames:v", String(duration * fps * resolutions.length), "-c:v", "libx264", "-threads", "2",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
  ]);
  const { streams: [video] } = JSON.parse(await context.command("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,avg_frame_rate,nb_read_frames", "-of", "json", path,
  ]));
  assert.deepEqual(video, {
    width, height, avg_frame_rate: `${fps}/1`, nb_read_frames: String(duration * fps * resolutions.length),
  });
}

async function makeSample(context, root, group, resolution, preset, exportDir) {
  const { id, fps, width, height } = group;
  const offset = resolution === "720p" ? 0 : duration * fps;
  const mov = `${id}/${resolution}.mov`;
  const source = await realpath(preset.result.mov);
  const fromExport = relative(await realpath(exportDir), source);
  assert.ok(!isAbsolute(fromExport) && !/^\.\.(?:[/\\]|$)/.test(fromExport) && /\.mov$/i.test(source),
    "MOV 必须来自本次验收的 export 目录");
  const original = await fingerprint(source);
  const target = join(root, mov);
  await copyFile(source, target);
  assert.deepEqual(await fingerprint(target), original);
  const scale = resolution === "720p" ? 2 / 3 : 1;
  const media = await verifyMedia(context, target, "mov", {
    width: width * scale, height: height * scale, fps, rate: `${fps}/1`, frames: duration * fps, alpha: true,
  });
  assert.deepEqual(media.active, preset.mov.active, "MOV 可见区间与导出报告不符");
  const [first, last] = media.active;
  const points = [
    [first - 1, "before", "入场前"],
    [first, "first", "首个可见帧"],
    [fps, "middle", "动效中段"],
    [last, "last", "最后可见帧"],
    [last + 1, "after", "首个退场后帧"],
  ];
  const refs = [];
  for (const [frame, name, title] of points) {
    const timelineFrame = offset + frame;
    const tc = timecode(timelineFrame, fps);
    const file = `${id}/${resolution}-F${String(timelineFrame).padStart(3, "0")}-${name}.png`;
    const label = `${resolution} / ${fps} fps / TL frame ${timelineFrame} / ${tc.replaceAll(":", ".")}`;
    const filter = [
      `[0:v]trim=start_frame=${timelineFrame}:end_frame=${timelineFrame + 1},setpts=PTS-STARTPTS[base]`,
      `[1:v]trim=start_frame=${frame}:end_frame=${frame + 1},setpts=PTS-STARTPTS,scale=${width}:${height},setsar=1[card]`,
      `[base][card]overlay=alpha=premultiplied:format=yuv444,pad=iw:ih+48:0:0:color=black,drawtext=text='${label}':x=20:y=h-38:fontsize=25:fontcolor=white`,
    ].join(";");
    await context.command("ffmpeg", [
      "-v", "error", "-n", "-filter_complex_threads", "2",
      "-i", join(root, id, "background.mp4"), "-i", target,
      "-filter_complex", filter, "-frames:v", "1", "-update", "1", join(root, file),
    ]);
    refs.push({ frame, timelineFrame, tc, title, file });
  }
  return { group: id, resolution, mov, ...original, offset, frames: duration * fps,
    first, last, refs, jobId: preset.result.jobId, width: media.video.width, height: media.video.height };
}

function instructions(runId, samples) {
  const sections = groups.map(({ id, title, aspect, fps }) => {
    const rows = samples.filter((sample) => sample.group === id).map((sample) => {
      const checkFrames = sample.refs.map(({ tc, title, file }) => `[${tc} ${title}](${file})`).join("、");
      const start = timecode(sample.offset, fps);
      const end = timecode(sample.offset + sample.frames, fps);
      return `| [${sample.resolution}](${sample.mov}) | ${start} 至 ${end} | ${checkFrames} |`;
    });
    return [
      `## ${title}`, "",
      `画幅 ${aspect}，${fps} fps。主轨使用 [background.mp4](${id}/background.mp4)，从零开始铺满 4 秒。`, "",
      "| 上层 MOV | 放置时间（右端点为下一帧） | 时间线检查点与参考图 |",
      "| --- | --- | --- |", ...rows, "",
    ].join("\n");
  });
  return [
    "# G5 剪映验收操作单", "",
    `样片来自本机验收批次 ${runId}。竖屏底片为佩雷斯原片 12.25 秒起的 4 秒片段，横屏底片是四色边测试图。参考图底部的黑条标注时间线帧号，画面对照时看黑条上方。`, "",
    "1. 解包后打开剪映专业版，记下版本号。按下方四组各新建一个草稿。先做横屏 24 fps，完成后用同样方法做其他三组。",
    "2. 每组导入该文件夹的 background.mp4、720p.mov、1080p.mov。把底片放主轨 00:00:00:00；把 720p 放上层轨道 00:00:00:00，把 1080p 接到同一上层轨道的 00:00:02:00。保留两档各 2 秒，使用原始速度、正常混合、100% 不透明度和默认居中适配。",
    "3. 设置对应的画幅与帧率。若当前版本只在导出窗口提供帧率选择，导出选对应 24 或 30 fps，并回传短成片供逐帧核对。",
    "4. 按表查看每档参考图。看中段底片能否透出、卡片位置和半透明边缘是否与参考一致。前后逐帧找出首个可见帧与首个退场后帧，实测与参考相差 1 帧以内。记录黑底、黑边、比例变化或错帧及对应时间码。",
    "5. 每组导出一份覆盖 0–4 秒的短成片，使用该组画幅和帧率，建议 1080p。也可回传覆盖两档位置、透明和入退场检查点的带时间码截图。文件名用组名，附上剪映版本号。回传短成片时可以由验收方填写 [结果表](结果表.md)。", "",
    ...sections,
  ].join("\n");
}

function resultsTable(samples) {
  return [
    "# G5 剪映验收结果", "", "剪映版本：", "",
    "| 时间线 | 档位 | 透明 | 构图 | 实测首个可见帧 | 实测首个退场后帧 | 证据文件与备注 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...samples.map(({ group, resolution, width, height }) =>
      `| ${group} | ${resolution}（${width}×${height}） | 待验 | 待验 | | | |`), "",
  ].join("\n");
}

async function packageFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => !entry.isDirectory()).map((entry) => {
    assert.ok(entry.isFile(), `包内须为普通文件：${entry.name}`);
    return relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
  }).sort();
  return Promise.all(files.map(async (file) => ({ file, ...await fingerprint(join(root, file)) })));
}

export async function verifyG5Handoff(context) {
  const { evidenceDir, exportDir, caseDir } = context;
  const runId = basename(dirname(exportDir));
  const root = join(evidenceDir, "G5");
  const samples = [];
  const prepared = await context.check("prepare-eight-mov-and-references", async () => {
    assert.ok(caseDir, "请通过 --case-dir 提供包含佩雷斯原片的案例目录");
    const [report, manifest] = await Promise.all(["result.json", "manifest.json"].map(async (file) =>
      JSON.parse(await readFile(join(exportDir, file), "utf8"))));
    assert.equal(report.runId, runId);
    assert.equal(report.suite, "export");
    assert.equal(report.status, "passed", "只允许打包已通过的 export 批次");
    assert.ok(report.checks.some(({ name, status }) => name === "export-matrix" && status === "passed"));
    assert.equal(manifest.presets.length, groups.length * resolutions.length);
    const checkedPresets = new Map();
    for (const group of groups) {
      for (const resolution of resolutions) {
        const matching = manifest.presets.filter((preset) =>
          preset.aspect === group.aspect && preset.fps === group.fps && preset.resolution === resolution);
        const label = `${group.aspect.replace(":", "x")}-${resolution}-${group.fps}`;
        assert.equal(matching.length, 1, `缺少或重复档位：${label}`);
        const [preset] = matching;
        const check = report.checks.find(({ name, status }) => name === `panel-${label}` && status === "passed");
        assert.ok(check, `找不到该档位的通过记录：${label}`);
        assert.equal(preset.result.jobId, check.details.jobId, `MOV 作业与通过记录不一致：${label}`);
        assert.equal(preset.result.mov, check.details.files.mov.path, `MOV 路径与通过记录不一致：${label}`);
        checkedPresets.set(label, preset);
      }
    }
    const originals = (await readdir(caseDir)).filter((name) => /\.mp4$/i.test(name));
    assert.equal(originals.length, 1, "案例目录须包含唯一一份 MP4 原片");
    const portrait = join(caseDir, originals[0]);
    const portraitBefore = await fingerprint(portrait);
    assert.equal(manifest.fixtureRunId, report.fixtureRunId, "导出报告与清单的夹具批次不一致");
    const landscape = join(dirname(exportDir), "..", report.fixtureRunId, "fixtures", "landscape-framing.mp4");
    const fixtureReport = JSON.parse(await readFile(join(dirname(landscape), "result.json"), "utf8"));
    assert.equal(fixtureReport.status, "passed");
    assert.equal(fixtureReport.runId, report.fixtureRunId);
    const fixtureManifest = JSON.parse(await readFile(join(dirname(landscape), "manifest.json"), "utf8"));
    const landscapeEntry = fixtureManifest.files.find(({ file }) => file === basename(landscape));
    assert.ok(landscapeEntry, "夹具清单缺少横屏测试底片");
    const { file, ...expectedLandscape } = landscapeEntry;
    assert.deepEqual(await fingerprint(landscape), expectedLandscape, `底片校验失败：${file}`);

    await mkdir(root);
    for (const group of groups) {
      await mkdir(join(root, group.id));
      await makeBackground(context, group, group.aspect === "16:9" ? landscape : portrait,
        join(root, group.id, "background.mp4"));
      for (const resolution of resolutions) {
        const label = `${group.aspect.replace(":", "x")}-${resolution}-${group.fps}`;
        samples.push(await makeSample(context, root, group, resolution, checkedPresets.get(label), exportDir));
      }
    }
    assert.equal(new Set(samples.map(({ jobId }) => jobId)).size, samples.length);
    assert.deepEqual(await fingerprint(portrait), portraitBefore, "佩雷斯原片校验值改变");
    await writeFile(join(root, "操作单.md"), instructions(runId, samples));
    await writeFile(join(root, "结果表.md"), resultsTable(samples));
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      exportRunId: runId, fixtureRunId: manifest.fixtureRunId, g5: "pending",
      backgrounds: { portrait: { source: originals[0], startSeconds: 12.25, ...portraitBefore }, landscape: expectedLandscape },
      groups, samples, files: await packageFiles(root),
    }, null, 2) + "\n");
    return { exportRunId: runId, samples: samples.length, referenceImages: samples.flatMap(({ refs }) => refs).length };
  });
  if (!prepared) return;

  await context.check("archive-and-extract-verify", async () => {
    const zip = join(evidenceDir, `K-Overlay-Studio-G5-${runId}.zip`);
    const candidate = join(evidenceDir, "candidate.zip");
    const extracted = join(evidenceDir, "extracted");
    const files = await packageFiles(root);
    // Explicit UTF-8 keeps Chinese filenames readable in standard Windows ZIP tools.
    await context.command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "[IO.Compression.ZipFile]::CreateFromDirectory('G5', 'candidate.zip', [IO.Compression.CompressionLevel]::Optimal, $true, [Text.Encoding]::UTF8)",
      "[IO.Compression.ZipFile]::ExtractToDirectory('candidate.zip', 'extracted')",
    ].join("; ")], { cwd: evidenceDir });
    assert.deepEqual(await packageFiles(join(extracted, "G5")), files);
    const extractedGuide = await readFile(join(extracted, "G5", "操作单.md"), "utf8");
    const filePaths = new Set(files.map(({ file }) => file));
    for (const [, target] of extractedGuide.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(filePaths.has(target), `操作单链接在解包后找不到：${target}`);
    }
    await rename(candidate, zip);
    assert.ok((await stat(zip)).isFile());
    return { zip, ...await fingerprint(zip), files: files.length, g5: "pending" };
  });
}
