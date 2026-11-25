import type { Aspect } from "../stage";
import { EFFECTS } from "../effects/registry";
import type { ProductionContext } from "./production";
import { parseOverlay } from "./types";

export function handoffPrompt({ directory, subtitle }: ProductionContext, aspect: Aspect, brief: string, media: string, externalSubtitle = false) {
  if (!subtitle) return "";
  const originalSubtitle = subtitle.relative === subtitle.name;
  return [
    "请为这期视频编排 K-Overlay-Studio 动效。先读下列规则及所选 SRT，先分段，再使用现有卡选配，事实和数字须来自字幕或可核查素材。",
    `${originalSubtitle ? "本期输出目录" : "本期目录"}：${directory.root}`,
    `字幕绝对路径：${subtitle.path}`,
    `${originalSubtitle ? "字幕文件名（用于 handoff.srt）" : "字幕相对路径"}：${subtitle.relative}`,
    ...(externalSubtitle ? ["此字幕由工作台手动导入。请按绝对路径读取字幕，并保留模板里的 handoff.srt。"] : []),
    `字幕原始字节 SHA-256：${subtitle.sha256}`,
    `字幕摘要：${subtitle.count} 条，${subtitle.start}–${subtitle.end} 秒`,
    `画幅：${aspect}`,
    `已知素材：${media.trim() || "目前仅提供字幕"}`,
    `本期要求：${brief.trim() || "按规则及偏好编排"}`,
    "规则及偏好文件：",
    ...directory.rules,
    "",
    "写稿前重新计算 SRT 原始字节 SHA-256。如已变化，停下并请我重新复制指令。",
    `只交付这一份文件：${directory.agent}`,
    ...(originalSubtitle ? ["若交稿文件已存在，请停止并请用户在准备页点击「新一轮编排」。"] : []),
    "按需创建它的父目录。请使用 UTF-8 的 OverlayDoc v1，把选出的卡片填入 cards，并保留 version、aspect 和 handoff。请替换 missing 为实际待补项，简短说明需要补什么，无待补项时保留空数组。",
    JSON.stringify({ version: 1, aspect, cards: [], handoff: { srt: subtitle.relative, srtSha256: subtitle.sha256, missing: [] } }, null, 2),
    "只写这一份编排，勿改其他文件。完成后请提示我回工作台点击「读取编排结果」。",
  ].join("\n");
}

function parseJson(text: string) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("交稿 JSON 无法解析，请修正后重读。");
  }
  return raw;
}

function readCards(raw: ReturnType<typeof parseJson>) {
  if (Array.isArray(raw.cards)) {
    for (const [i, card] of raw.cards.entries()) {
      if (!card || typeof card.kind !== "string") throw new Error(`第 ${i + 1} 张卡片缺少类型。`);
      const effect = EFFECTS.find((item) => item.id === card.kind);
      if (!effect) throw new Error(`交稿包含未知卡片：${card.kind}`);
      if (!Number.isFinite(card.start) || !Number.isFinite(card.end) || card.start < 0) {
        throw new Error(`第 ${i + 1} 张卡片时间无效。`);
      }
      if (card.params === undefined) continue;
      if (!card.params || typeof card.params !== "object" || Array.isArray(card.params)) {
        throw new Error(`第 ${i + 1} 张卡片的 params 应为对象。`);
      }
      for (const { key, type } of effect.controls) {
        if (!Object.hasOwn(card.params, key)) continue;
        const value: unknown = card.params[key];
        const valid = type === "range" ? typeof value === "number" && Number.isFinite(value)
          : type === "toggle" ? typeof value === "boolean"
          : typeof value === "string" || (type === "text" && typeof effect.defaults[key] === "number" && Number.isFinite(value));
        if (!valid) throw new Error(`第 ${i + 1} 张「${card.kind}」卡片的参数 ${key} 类型不符。`);
      }
    }
  }
  const result = parseOverlay(raw);
  if (result.error || !result.doc) throw new Error(result.error || "无法读取编排");
  return { doc: result.doc, warnings: result.warnings };
}

function readMissing(missing: unknown): string[] {
  if (!Array.isArray(missing) || !missing.every((x) => typeof x === "string" && x.trim())) {
    throw new Error("交稿缺少有效的待补项列表。无待补项时请填写空数组。");
  }
  return missing;
}

function validateHandoff(raw: ReturnType<typeof parseJson>, subtitle: NonNullable<ProductionContext["subtitle"]>, aspect: Aspect) {
  if (raw?.version !== 1 || !raw.handoff || !["9:16", "16:9"].includes(raw.aspect)) {
    throw new Error("交稿缺少 OverlayDoc v1、交接信息或有效画幅。");
  }
  if (raw.aspect !== aspect) throw new Error("交稿画幅与本期选择不符。");
  if (typeof raw.handoff.srt !== "string" || raw.handoff.srt.replaceAll("\\", "/") !== subtitle.relative) {
    throw new Error("交稿使用的字幕与本期选择不符。");
  }
  if (typeof raw.handoff.srtSha256 !== "string" || raw.handoff.srtSha256.toLowerCase() !== subtitle.sha256) {
    throw new Error("交稿的字幕内容已过时，请重新生成。");
  }
  const { doc, warnings } = readCards(raw);
  return { doc: { ...doc, aspect }, warnings, missing: readMissing(raw.handoff.missing) };
}

export function parseHandoff(text: string, subtitle: NonNullable<ProductionContext["subtitle"]>, aspect: Aspect) {
  return validateHandoff(parseJson(text), subtitle, aspect);
}

export function parsePickedOverlay(text: string, subtitle: ProductionContext["subtitle"], aspect: Aspect, legacySubtitle?: NonNullable<ProductionContext["subtitle"]>) {
  const raw = parseJson(text);
  if (subtitle && raw && Object.hasOwn(raw, "handoff")) {
    const relative = raw.handoff?.srt;
    const selected = legacySubtitle && typeof relative === "string" && relative.replaceAll("\\", "/") === legacySubtitle.relative
      ? legacySubtitle : subtitle;
    return { ...validateHandoff(raw, selected, aspect), verified: true };
  }
  const { doc, warnings } = readCards(raw);
  return {
    doc: { ...doc, aspect: doc.aspect ?? "16:9" } as const,
    warnings,
    missing: raw?.handoff?.missing === undefined ? [] : readMissing(raw.handoff.missing),
    verified: false,
  };
}
