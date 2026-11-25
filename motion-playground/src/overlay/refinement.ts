import { EFFECTS } from "../effects/registry";
import { STAGES, type Aspect } from "../stage";
import type { OverlayCard } from "./types";

type ByAspect<T> = Partial<Record<Aspect, T>>;
type Point = { x: number; y: number };
type Transform = Point & { scale: number };
type GroupFrame = Point & { fit: number };
type PlacementParams = Partial<Record<"position" | "side" | "corner" | "offsetX" | "offsetY" | "manualX" | "manualY" | "scale", string | number>>;

export type CardPlacement =
  | { mode: "auto"; placement?: PlacementParams; group?: string; order?: number }
  | ({ mode: "group"; group: string } & Transform)
  | ({ mode: "free" } & Transform);

type CardFrame = { base?: CardPlacement; current?: CardPlacement };
type CardRefinement = { frames: ByAspect<CardFrame> };
type GroupRefinement = { frames: ByAspect<GroupFrame>; order: string[] };

export interface OverlayRefinement {
  schema: 1;
  groups?: Record<string, GroupRefinement>;
  byCard?: Record<string, CardRefinement>;
  paintOrder?: string[];
}

const axes = ["offsetX", "offsetY", "manualX", "manualY"] as const;
const anchors = ["position", "side", "corner"] as const;
const placements = [...anchors, ...axes, "scale"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function groupName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function knownAspect(value: string): value is Aspect {
  return Object.hasOwn(STAGES, value);
}

function readFrames<T>(
  raw: unknown, label: string, warnings: string[], read: (value: unknown, label: string) => T | undefined,
): ByAspect<T> {
  const frames: ByAspect<T> = {};
  if (!record(raw)) {
    warnings.push(`${label}缺少有效的画幅记录，相关摆放沿用原参数。`);
    return frames;
  }
  for (const [aspect, value] of Object.entries(raw)) {
    if (!knownAspect(aspect)) {
      warnings.push(`${label}有未知画幅「${aspect}」，已跳过。`);
      continue;
    }
    const frame = read(value, `${label}（${aspect}）`);
    if (frame) frames[aspect] = frame;
  }
  return frames;
}

function readPlacement(raw: unknown, card: OverlayCard, groupExists: (group: string) => boolean): CardPlacement | undefined {
  if (!record(raw)) return undefined;
  const { mode, group, order, x, y, scale } = raw;
  const validGroup = groupName(group) && groupExists(group);
  if (mode === "auto") {
    if (group !== undefined && !validGroup) return undefined;
    if (order !== undefined && (!validGroup || !finite(order) || !Number.isSafeInteger(order) || order < 0)) return undefined;
    const placement: PlacementParams = {};
    if (raw.placement !== undefined) {
      if (!record(raw.placement)) return undefined;
      const effect = EFFECTS.find(({ id }) => id === card.kind);
      for (const key of placements) {
        if (!Object.hasOwn(raw.placement, key)) continue;
        const wrapped = key === "manualX" || key === "manualY" || key === "scale";
        if (!wrapped && !Object.hasOwn(effect?.defaults ?? {}, key) && !effect?.controls.some((control) => control.key === key)) continue;
        const value = raw.placement[key];
        const valid = key === "scale" ? positive(value)
          : key === "position" || key === "side" || key === "corner" ? groupName(value)
          : finite(value);
        if (!valid) return undefined;
        if (typeof value === "string" || typeof value === "number") placement[key] = value;
      }
    }
    return {
      mode,
      ...(validGroup && { group }),
      ...(typeof order === "number" && { order }),
      ...(Object.keys(placement).length > 0 && { placement }),
    };
  }
  if (!finite(x) || !finite(y) || !positive(scale)) return undefined;
  if (mode === "free") return { mode, x, y, scale };
  if (mode === "group" && validGroup) return { mode, group, x, y, scale };
  return undefined;
}

function completeOrder(raw: unknown, ids: string[]) {
  const allowed = new Set(ids);
  const order = new Set<string>();
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (typeof id === "string" && allowed.has(id)) order.add(id);
    }
  }
  for (const id of ids) order.add(id);
  return [...order];
}

export function parseRefinement(raw: unknown, cards: OverlayCard[], originalIds: string[]): {
  refinement?: OverlayRefinement; warnings?: string[]; error?: string;
} {
  if (raw === undefined) return {};
  const warnings: string[] = [];
  if (!record(raw)) return { warnings: ["精修扩展格式无效，已沿用原编排参数。"] };
  if (!Object.hasOwn(raw, "schema") || raw.schema !== 1) {
    return { error: "当前版本无法还原这份编排的精修数据，请保留原稿并使用支持该精修版本的编辑台打开。" };
  }

  const rawGroups = record(raw.groups) ? raw.groups : {};
  const rawCards = record(raw.byCard) ? raw.byCard : {};
  if (raw.groups !== undefined && !record(raw.groups)) warnings.push("精修分组格式无效，已沿用原编排分组。");
  if (raw.byCard !== undefined && !record(raw.byCard)) warnings.push("精修卡片记录格式无效，已沿用原编排参数。");

  const groupsByName = new Map<string, string[]>();
  const knownGroups = new Set(Object.keys(rawGroups).filter(groupName));
  for (const { seg } of cards) if (seg) knownGroups.add(seg);
  const byCard = new Map<string, CardRefinement>();
  for (const card of cards) {
    const memberships = new Set(card.seg ? [card.seg] : []);
    if (Object.hasOwn(rawCards, card.id)) {
      const rawCard = rawCards[card.id];
      const frames = readFrames<CardFrame>(record(rawCard) ? rawCard.frames : undefined, `卡片「${card.id}」`, warnings, (value, label) => {
        if (!record(value)) {
          warnings.push(`${label}摆放记录无效，已沿用原参数。`);
          return undefined;
        }
        const frame: CardFrame = {};
        for (const key of ["base", "current"] as const) {
          if (!Object.hasOwn(value, key)) continue;
          const placement = readPlacement(value[key], card, (group) => knownGroups.has(group));
          if (!placement) {
            warnings.push(`${label}的${key === "base" ? "编排基准" : "当前摆放"}无效，相关摆放已回退。`);
            continue;
          }
          frame[key] = placement;
          if ("group" in placement && placement.group) memberships.add(placement.group);
        }
        return frame.base || frame.current ? frame : undefined;
      });
      if (Object.keys(frames).length) byCard.set(card.id, { frames });
    }
    for (const group of memberships) {
      const members = groupsByName.get(group);
      if (members) members.push(card.id);
      else groupsByName.set(group, [card.id]);
    }
  }

  const groups = new Map<string, GroupRefinement>();
  for (const [name, ids] of groupsByName) {
    if (!Object.hasOwn(rawGroups, name)) continue;
    const group = rawGroups[name];
    const label = `分组「${name}」`;
    const frames = readFrames<GroupFrame>(record(group) ? group.frames : undefined, label, warnings, (value, frameLabel) => {
      if (record(value) && finite(value.x) && finite(value.y) && positive(value.fit)) {
        return { x: value.x, y: value.y, fit: value.fit };
      }
      warnings.push(`${frameLabel}原点或适配倍率无效，已沿用自动分组摆放。`);
      return undefined;
    });
    const order = record(group) ? group.order : undefined;
    if (!Array.isArray(order)) warnings.push(`${label}的成员顺序无效，已按时间轴补齐。`);
    groups.set(name, { order: completeOrder(order, ids), frames });
  }

  const refinement: OverlayRefinement = { schema: 1 };
  if (groups.size) refinement.groups = Object.fromEntries(groups);
  if (byCard.size) refinement.byCard = Object.fromEntries(byCard);
  if (Array.isArray(raw.paintOrder)) {
    refinement.paintOrder = completeOrder(raw.paintOrder, originalIds);
  } else if (raw.paintOrder !== undefined) {
    warnings.push("精修绘制顺序无效，已沿用原编排层级。");
  }
  return { refinement, warnings: warnings.length ? warnings : undefined };
}
