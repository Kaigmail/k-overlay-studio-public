import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { parseSrt } from "../src/overlay/srt.ts";
import type { Production, Subtitle } from "../src/overlay/production.ts";

const WORD = "Word";
const AGENT = "Projects/overlay-studio/agent/overlay.json";
const EDITED = "Projects/overlay-studio/edited";
const BROLL = "Video/B-roll";
const IMPORT_PREFIX = "overlay-srt-";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

async function productionRoot(input: unknown) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error("请输入本期制作目录的完整路径。");
  }
  const root = await fs.realpath(input);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("所选路径不是目录。");
  return root;
}

// 逐级检查子目录，避免链接或 Windows 目录联接将读写重定向到本期目录外。
async function childDirectory(root: string, relative: string, create = false) {
  let current = root;
  for (const name of relative.split("/")) {
    current = path.join(current, name);
    if (create) {
      await fs.mkdir(current).catch((error) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`请检查本期目录中的 ${relative}，这里需要一个普通文件夹。`);
    }
  }
  return current;
}

async function readFile(root: string, relative: string) {
  const parts = relative.split("/");
  const name = parts.pop()!;
  const file = path.join(await childDirectory(root, parts.join("/")), name);
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`无法读取 ${relative}`);
  if (entry.size > 16 * 1024 * 1024) throw new Error(`文件太大：${relative}`);
  return fs.readFile(file);
}

function subtitlePath(relative: unknown): string {
  if (typeof relative !== "string" || !/^Word\/[^/\\:\0]+\.srt$/i.test(relative)) {
    throw new Error("请选择 Word 文件夹中的 SRT 字幕。");
  }
  return relative;
}

function subtitleLines(bytes: Buffer) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return parseSrt(new TextDecoder(encoding).decode(bytes)).filter(({ start, end }) => end > start);
}

async function readSubtitle(root: string, relative: string) {
  return describeSubtitle(await readFile(root, relative), path.join(root, relative), relative);
}

export function describeSubtitle(bytes: Buffer, file: string, relative: string) {
  const lines = subtitleLines(bytes);
  if (!lines.length) return null;
  const subtitle: Subtitle = {
    name: path.basename(relative),
    path: file,
    relative,
    sha256: sha256(bytes),
    count: lines.length,
    start: lines[0].start,
    end: lines.reduce((end, line) => Math.max(end, line.end), 0),
  };
  return { subtitle, lines };
}

async function inspect(root: string, repo: string): Promise<Production> {
  const subtitles: Subtitle[] = [];
  try {
    const word = await childDirectory(root, WORD);
    const files = await fs.readdir(word, { withFileTypes: true });
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !/\.srt$/i.test(file.name) || file.name.includes(":")) continue;
      const result = await readSubtitle(root, `Word/${file.name}`);
      if (result) subtitles.push(result.subtitle);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const skill = path.join(repo, ".claude/skills/overlay-fx-generator");
  const rules = await Promise.all(
    ["SKILL.md", "我的偏好.default.md", "我的偏好.md", "经验规则.md"].map(async (name) => {
      const file = path.join(skill, name);
      return await fs.stat(file).then(() => file, () => null);
    }),
  );
  return {
    root, name: path.basename(root) || root, subtitles,
    agent: path.join(root, AGENT), edited: path.join(root, EDITED), broll: path.join(root, BROLL),
    rules: rules.filter((file) => file !== null),
  };
}

export async function importSubtitleBytes(name: unknown, bytes: Buffer, repo: string) {
  if (typeof name !== "string" || !/^[^<>:"/\\|?*\u0000-\u001f]+\.srt$/i.test(name)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\./i.test(name)) {
    throw new Error("请选择有效的 SRT 文件名。");
  }
  if (bytes.length > 10 * 1024 * 1024) throw new Error("SRT 文件不能超过 10 MB。");
  if (!subtitleLines(bytes).length) throw new Error("选中的 SRT 没有有效的字幕条目。");
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), IMPORT_PREFIX));
  const word = await childDirectory(root, WORD, true);
  await fs.writeFile(path.join(word, name), bytes, { flag: "wx" });
  return inspect(root, repo);
}

async function importedSubtitleRoot(input: unknown) {
  const root = await productionRoot(input);
  if (path.dirname(root) !== await fs.realpath(os.tmpdir()) || !path.basename(root).startsWith(IMPORT_PREFIX)) {
    throw new Error("找不到临时字幕，请重新选择 SRT。");
  }
  return root;
}

export function localRequest(req: IncomingMessage, requireJson = true) {
  const host = req.headers.host || "";
  const origin = req.headers.origin;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
    && (!origin || origin === `http://${host}`)
    && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || "")
    && (!requireJson || req.headers["content-type"]?.split(";")[0] === "application/json");
}

function outputStem(root: string, subtitle: unknown) {
  const name = subtitle == null ? path.basename(root) : path.basename(subtitlePath(subtitle)).slice(0, -4);
  return (name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120).trim() || "本期") + "-动效";
}

// 先写完整临时文件，再独占发布。对不支持硬链接的文件系统保留独占复制。
export async function saveOverlayJson(directory: string, stem: string, doc: { version?: unknown; cards?: unknown } | null) {
  if (doc?.version !== 1 || !Array.isArray(doc.cards)) throw new Error("当前编排格式无效。");
  return publish(directory, stem + "编排", ".json", (file) =>
    fs.writeFile(file, JSON.stringify(doc, null, 2), { flag: "wx" }));
}

async function publish(directory: string, stem: string, extension: string, stage: (file: string) => Promise<void>) {
  const draft = path.join(directory, `.${randomUUID()}.part`);
  try {
    await stage(draft);
    let useLink = true;
    for (let i = 1; ; i++) {
      const file = path.join(directory, `${stem}${i === 1 ? "" : `-${i}`}${extension}`);
      try {
        if (useLink) {
          try {
            await fs.link(draft, file);
            return file;
          } catch (error) {
            const code = errorCode(error);
            if (!code || !["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(code)) throw error;
            useLink = false;
          }
        }
        await fs.copyFile(draft, file, constants.COPYFILE_EXCL);
        return file;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  } finally {
    await fs.rm(draft, { force: true }).catch(() => {});
  }
}

const exportSuffix = {
  mov: ".mov", webm: ".webm", sfxSheet: "-音效清单.txt", camNote: "-合成说明.txt",
} as const;
type ExportFile = keyof typeof exportSuffix;
export type RenderedExport = Partial<Record<ExportFile, string | null>> & {
  ok: boolean;
  error?: string;
  stageDir?: string;
  dir: string | null;
};

export async function publishExport(
  files: RenderedExport,
  directory: string,
  verifyDirectory: () => Promise<void>,
) {
  const results: Partial<Record<ExportFile, { path?: string; error?: string }>> = {};
  const source = files.mov || files.webm;
  let stem = source ? path.parse(source).name : "";
  for (const key of Object.keys(exportSuffix) as ExportFile[]) {
    const file = files[key];
    if (!file) {
      if (key === "mov" || key === "webm") results[key] = { error: "编码未生成此格式。" };
      continue;
    }
    try {
      await verifyDirectory();
      const dest = await publish(directory, stem, exportSuffix[key], async (draft) => {
        await fs.copyFile(file, draft, constants.COPYFILE_EXCL);
        await verifyDirectory();
      });
      results[key] = { path: dest };
      if (key === "mov") stem = path.parse(dest).name;
    } catch (error) {
      results[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return results;
}

type Delivery = { root: string; stem: string; mov: string };
const pending = new Map<string, Delivery>();

export async function deliveryTarget(input: { root?: unknown; subtitle?: unknown }) {
  const root = await productionRoot(input.root);
  return { root, stem: outputStem(root, input.subtitle) };
}

async function deliver({ root, stem, mov }: Delivery) {
  if (await fs.realpath(root) !== root) throw new Error("制作目录已变更，请重新导出。");
  const directory = await childDirectory(root, BROLL, true);
  if (await fs.realpath(path.dirname(mov)) === await fs.realpath(directory)) return mov;
  return publish(directory, stem, ".mov", (file) => fs.copyFile(mov, file, constants.COPYFILE_EXCL));
}

export async function deliverMov(mov: string, target: Omit<Delivery, "mov">) {
  const delivery = { ...target, mov };
  try {
    return { delivered: await deliver(delivery) };
  } catch (error) {
    const retry = randomUUID();
    if (pending.size >= 32) pending.delete(pending.keys().next().value!);
    pending.set(retry, delivery);
    return { retry, deliveryError: String(error) };
  }
}

export function productionApi(): Plugin {
  return {
    name: "overlay-production",
    configureServer(server) {
      server.middlewares.use("/api/production", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        try {
          if (req.method !== "POST" || !localRequest(req)) {
            res.statusCode = 403;
            throw new Error("本期目录操作仅限本机工作台。");
          }
          let body = "";
          req.setEncoding("utf8");
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 16 * 1024 * 1024) {
              res.statusCode = 413;
              res.end(JSON.stringify({ error: "请求内容太大" }));
              return;
            }
          }
          const input = JSON.parse(body);
          const action = req.url;
          if (action === "/retry-mov") {
            const item = pending.get(input.retry);
            if (!item) throw new Error("找不到待交付成片，请查看原 MOV 路径。");
            pending.delete(input.retry);
            try {
              res.end(JSON.stringify({ path: await deliver(item) }));
            } catch (error) {
              pending.set(input.retry, item);
              throw error;
            }
            return;
          }
          const repo = path.dirname(server.config.root);
          if (action === "/import-srt") {
            if (typeof input.base64 !== "string") throw new Error("无法读取所选 SRT。");
            res.end(JSON.stringify(await importSubtitleBytes(input.name, Buffer.from(input.base64, "base64"), repo)));
            return;
          }
          const root = await productionRoot(input.root);
          if (action === "/inspect") {
            res.end(JSON.stringify(await inspect(root, repo)));
          } else if (action === "/read" || action === "/subtitle") {
            const srtRoot = action === "/read" && input.subtitleRoot
              ? await importedSubtitleRoot(input.subtitleRoot) : root;
            const selected = await readSubtitle(srtRoot, subtitlePath(input.subtitle)).catch((error) => {
              if (errorCode(error) === "ENOENT") throw new Error("选中的字幕已找不到，请重新选择字幕。");
              throw error;
            });
            if (!selected) throw new Error("选中的字幕已没有有效条目，请重新扫描字幕。");
            if (selected.subtitle.sha256 !== input.sha256) {
              throw new Error("字幕内容已变更，请重新扫描并复制指令。");
            }
            if (action === "/subtitle") {
              res.end(JSON.stringify({ lines: selected.lines }));
              return;
            }
            const bytes = await readFile(root, AGENT).catch((error) => {
              if (errorCode(error) === "ENOENT") throw new Error(`尚未找到交稿：${path.join(root, AGENT)}`);
              throw error;
            });
            const identity = createHash("sha256").update(root).update("\0").update(bytes).digest("hex");
            res.end(JSON.stringify({ ...selected, text: new TextDecoder().decode(bytes), identity }));
          } else if (action === "/save-json") {
            const directory = await childDirectory(root, EDITED, true);
            const dest = await saveOverlayJson(directory, outputStem(root, input.subtitle), input.doc);
            res.end(JSON.stringify({ path: dest }));
          } else {
            res.statusCode = 404;
            throw new Error("此目录操作不存在。");
          }
        } catch (error) {
          if (res.statusCode === 200) res.statusCode = 400;
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
    },
  };
}
