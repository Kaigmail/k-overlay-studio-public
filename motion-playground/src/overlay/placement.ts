import { EFFECTS } from "../effects/registry";
import { STAGES, type Aspect } from "../stage";
import type { CardPlacement, OverlayRefinement } from "./refinement";
import type { OverlayCard, OverlayDoc } from "./types";

export type Box = { x: number; y: number; w: number; h: number };
export type GroupFrame = { x: number; y: number; fit: number };
export type CardLayout = {
  box: Box;
  scale: number;
  group?: { name: string; frame: GroupFrame; order: string[]; visibleCount: number; box: Box };
};

export const SCALE_MIN = 0.4;
export const SCALE_MAX = 3;
export const SCALE_STEP = 0.05;

const placementKeys = ["position", "side", "corner", "offsetX", "offsetY", "manualX", "manualY", "scale"] as const;

export function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function placementParams(kind: string, params: OverlayCard["params"]) {
  const effect = EFFECTS.find(({ id }) => id === kind);
  const result: NonNullable<Extract<CardPlacement, { mode: "auto" }>["placement"]> = {};
  for (const key of placementKeys) {
    if (key !== "manualX" && key !== "manualY" && key !== "scale" &&
        !Object.hasOwn(effect?.defaults ?? {}, key) && !effect?.controls.some((control) => control.key === key)) continue;
    const value = params[key];
    if (key === "position" || key === "side" || key === "corner") {
      if (typeof value === "string" && value.trim()) result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value) && (key !== "scale" || value > 0)) {
      result[key] = value;
    }
  }
  return result;
}

export function frameOf(doc: OverlayDoc, card: OverlayCard, aspect: Aspect) {
  return own(doc.refinement?.byCard, card.id)?.frames[aspect];
}

export function paintCards(doc: OverlayDoc) {
  if (!doc.refinement?.paintOrder) return doc.cards;
  const rank = new Map(doc.refinement.paintOrder.map((id, index) => [id, index]));
  return [...doc.cards].sort((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size));
}

export function cardGroup(card: OverlayCard, current?: CardPlacement) {
  return current ? current.mode === "free" ? undefined : current.group ?? card.seg : card.seg;
}

export function preserveGroupOrder(doc: OverlayDoc, card: OverlayCard): OverlayDoc {
  const aspects = ["9:16", "16:9"] as const;
  const memberships = (member: OverlayCard) => new Set([
    member.seg,
    ...aspects.flatMap((aspect) => {
      const frame = frameOf(doc, member, aspect);
      return [cardGroup(member, frame?.current), cardGroup(member, frame?.base)];
    }),
  ]);
  const groups = Object.assign(Object.create(null) as NonNullable<OverlayRefinement["groups"]>, doc.refinement?.groups);
  let changed = false;
  for (const name of memberships(card)) {
    if (!name || own(groups, name)) continue;
    groups[name] = {
      order: doc.cards.filter((member) => memberships(member).has(name)).map(({ id }) => id),
      frames: {},
    };
    changed = true;
  }
  return changed ? { ...doc, refinement: { schema: 1, ...doc.refinement, groups } } : doc;
}

export function writePlacement(
  doc: OverlayDoc, origin: OverlayDoc | null, card: OverlayCard, aspect: Aspect,
  layout: CardLayout | undefined, current: CardPlacement,
): OverlayDoc {
  const refinement: OverlayRefinement = { schema: 1, ...doc.refinement };
  const previous = own(refinement.byCard, card.id)?.frames ?? {};
  const original = origin?.cards.find(({ id }) => id === card.id) ?? card;
  const base: CardPlacement = previous[aspect]?.base ?? {
    mode: "auto",
    placement: placementParams(card.kind, original.params),
    ...(original.seg && {
      group: original.seg,
      ...(layout?.group?.name === original.seg && { order: layout.group.order.indexOf(card.id) }),
    }),
  };
  refinement.byCard = {
    ...refinement.byCard,
    [card.id]: { frames: { ...previous, [aspect]: { base, current } } },
  };
  if (layout?.group) {
    const { name, frame, order } = layout.group;
    const saved = own(refinement.groups, name);
    refinement.groups = { ...refinement.groups, [name]: { order, frames: { ...saved?.frames, [aspect]: frame } } };
  }
  return { ...doc, refinement };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.max(min, max), value));
}

export function moveBox(box: Box, dx: number, dy: number, aspect: Aspect) {
  const stage = STAGES[aspect];
  return {
    x: box.w > stage.w ? box.x : clamp(box.x + dx, 0, stage.w - box.w),
    y: box.h > stage.h ? box.y : clamp(box.y + dy, 0, stage.h - box.h),
  };
}

export function resizeBox(layout: CardLayout, requested: number, ax: number, ay: number, aspect: Aspect) {
  const { box, scale } = layout;
  const stage = STAGES[aspect];
  const x = box.x + ax * box.w;
  const y = box.y + ay * box.h;
  const limitX = Math.min(ax ? x / (ax * box.w) : Infinity, ax < 1 ? (stage.w - x) / ((1 - ax) * box.w) : Infinity);
  const limitY = Math.min(ay ? y / (ay * box.h) : Infinity, ay < 1 ? (stage.h - y) / ((1 - ay) * box.h) : Infinity);
  const max = Math.min(SCALE_MAX, scale * limitX, scale * limitY);
  const next = clamp(requested, Math.min(SCALE_MIN, max), max);
  // Existing imported layouts can begin beyond the stage. Let a shrinking gesture move inward.
  const effective = max > 0 ? next : Math.min(scale, Math.max(SCALE_MIN, requested));
  const w = box.w * effective / scale;
  const h = box.h * effective / scale;
  return { x: x - ax * w, y: y - ay * h, w, h, scale: effective };
}

export function restorePlacementParams(card: OverlayCard, base: CardPlacement) {
  if (base.mode !== "auto") return card.params;
  const params = { ...card.params };
  for (const key of placementKeys) delete params[key];
  const defaults = EFFECTS.find(({ id }) => id === card.kind)?.defaults ?? {};
  return { ...params, ...placementParams(card.kind, defaults), ...placementParams(card.kind, base.placement ?? {}) };
}
