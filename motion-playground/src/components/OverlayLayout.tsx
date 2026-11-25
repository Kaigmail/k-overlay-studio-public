import { useLayoutEffect, useRef, type ReactNode } from "react";
import { getAspect, stageGeom, VERTICAL_LAYOUT, verticalBand } from "../stage";
import { cardGroup, frameOf, own, paintCards, restorePlacementParams, type Box, type CardLayout, type GroupFrame } from "../overlay/placement";
import { isVisibleAt } from "../overlay/export-preset";
import type { OverlayCard, OverlayDoc } from "../overlay/types";
import type { CardPlacement } from "../overlay/refinement";
import { fitBox, VerticalCardFit } from "./VerticalCardFit";

const GAP = 28;
const roots = ".hud-anchor, .slot, .chapter-plate, .ctrack-cue, [data-focus-copy], [data-focus-frame]";
const number = (value: unknown) => Number(value) || 0;

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x, y,
    w: Math.max(...boxes.map((box) => box.x + box.w)) - x,
    h: Math.max(...boxes.map((box) => box.y + box.h)) - y,
  };
}

function metrics(element: HTMLElement, stage: HTMLElement, zoom: number): Box | undefined {
  const bounds = stage.getBoundingClientRect();
  let parts = [...element.querySelectorAll<HTMLElement>(roots)];
  if (!parts.length) parts = [...element.querySelectorAll<HTMLElement>(".hud:not(.ctrack)")];
  const boxes = parts.filter((part) => !parts.some((other) => other !== part && other.contains(part))).map((part) => {
    const b = part.getBoundingClientRect();
    return { x: (b.x - bounds.x) / zoom - stage.clientLeft, y: (b.y - bounds.y) / zoom - stage.clientTop, w: b.width / zoom, h: b.height / zoom };
  }).filter(({ w, h }) => w > 0 && h > 0);
  return boxes.length ? union(boxes) : undefined;
}

type Member = {
  card: OverlayCard;
  active: boolean;
  current?: CardPlacement;
  rank?: number;
};

type Group = {
  name: string;
  members: Member[];
  order: string[];
  saved?: GroupFrame;
};

export function OverlayLayout({ doc, time, render, onLayout }: {
  doc: OverlayDoc;
  time: number;
  render: (card: OverlayCard, sample: number, measurement: boolean) => ReactNode;
  onLayout?: (cards: Map<string, CardLayout>) => void;
}) {
  const aspect = getAspect();
  const geom = stageGeom();
  const ref = useRef<HTMLDivElement>(null);
  const measureRef = useRef<() => void>(() => {});
  const groups = new Map<string, Group>();
  const independent: Member[] = [];
  const order = doc.refinement?.paintOrder ? new Map(paintCards(doc).map(({ id }, index) => [id, index])) : undefined;

  for (const source of doc.cards) {
    const current = frameOf(doc, source, aspect)?.current;
    const card = current?.mode === "auto" ? { ...source, params: restorePlacementParams(source, current) } : source;
    const active = isVisibleAt(time, card);
    const name = cardGroup(card, current);
    const member = { card, active, current, rank: order?.get(card.id) };
    if (!name) {
      if (active) independent.push(member);
      continue;
    }
    const saved = own(doc.refinement?.groups, name);
    let group = groups.get(name);
    if (!group) {
      group = { name, members: [], order: saved?.order ?? [], saved: saved?.frames[aspect] };
      groups.set(name, group);
    }
    group.members.push(member);
  }
  for (const [name, group] of groups) {
    if (!group.members.some(({ active }) => active)) {
      groups.delete(name);
      continue;
    }
    const members = group.members;
    group.order = [...new Set([...group.order, ...members.map(({ card }) => card.id)])];
    const rank = new Map(group.order.map((id, index) => [id, index]));
    group.members.sort((a, b) => rank.get(a.card.id)! - rank.get(b.card.id)!);
  }

  measureRef.current = () => {
    const layer = ref.current;
    const stage = layer?.closest<HTMLElement>(".stage");
    if (!layer || !stage) return;
    const zoom = stage.getBoundingClientRect().width / stage.offsetWidth;
    if (!zoom) return;
    const layout = new Map<string, CardLayout>();
    const groupNodes = [...layer.querySelectorAll<HTMLElement>(":scope > .seg-stack")];
    const soloNodes = [...layer.querySelectorAll<HTMLElement>(":scope > .overlay-layout-card")];
    const cardNodes = [...groupNodes.flatMap((node) => [...node.children] as HTMLElement[]), ...soloNodes];
    for (const node of cardNodes) node.style.transform = "";

    groupNodes.forEach((node) => {
      const group = groups.get(node.dataset.group!)!;
      const head = group.members.find(({ card }) => card.id === group.order[0])?.card ??
        doc.cards.find(({ id }) => id === group.order[0]) ?? group.members[0].card;
      const originX = geom.edge + number(head.params.offsetX);
      const originY = geom.topEdge + number(head.params.offsetY);
      const nodes = [...node.children] as HTMLElement[];
      group.members.forEach(({ card, current }, index) => {
        const wrapper = nodes[index];
        const scale = number(card.params.scale) || 1;
        const flow = current?.mode === "group" ? current.scale / scale : 1;
        wrapper.style.marginBottom = flow === 1 ? "" : `${wrapper.offsetHeight * (flow - 1)}px`;
      });
      const members = group.members.map((member, index) => {
        const wrapper = nodes[index];
        const actual = metrics(wrapper, stage, zoom);
        const offset = {
          x: actual ? actual.x - originX : 0,
          y: actual ? actual.y - originY - (member.active ? wrapper.offsetTop : 0) : 0,
        };
        const shrinking = wrapper.querySelector<HTMLElement>('[data-past="1"]:not([data-dim-mode="fade"])');
        const dim = actual && shrinking && wrapper.querySelector(".hud-anchor")
          ? number(shrinking.style.getPropertyValue("--fx-dim-scale")) || 1 : 1;
        const settled = actual && { x: offset.x / dim, y: offset.y / dim, w: actual.w / dim, h: actual.h / dim };
        return { ...member, wrapper, actual, settled, offset };
      });
      let frame = group.saved;
      if (!frame) {
        let fit = 1;
        let bounds: Box = { x: originX, y: originY, w: 0, h: 0 };
        if (geom.vertical) {
          const combinations = new Set(members.map(({ card }) => card.start));
          const boxes: Box[] = [];
          for (const start of combinations) {
            let y = originY;
            const current: Box[] = [];
            for (const member of members) {
              if (!isVisibleAt(start, member.card) || !member.settled) continue;
              const box = member.settled;
              current.push({ x: originX + box.x, y: y + box.y, w: box.w, h: box.h });
              y += member.wrapper.offsetHeight / (member.actual ? member.actual.h / box.h : 1) + GAP;
            }
            if (current.length) boxes.push(union(current));
          }
          if (boxes.length) {
            bounds = union(boxes);
            fit = fitBox(bounds, VERTICAL_LAYOUT.upper).scale;
          }
        }
        const shift = geom.vertical ? fitBox(bounds, VERTICAL_LAYOUT.upper, fit) : { x: 0, y: 0 };
        frame = {
          x: originX * fit + shift.x + (geom.vertical ? number(head.params.manualX) : 0),
          y: originY * fit + shift.y + (geom.vertical ? number(head.params.manualY) : 0),
          fit,
        };
      }
      node.dataset.originX = String(frame.x);
      node.dataset.originY = String(frame.y);
      const groupCards: [string, CardLayout][] = [];
      for (const { card, wrapper, actual, active, current } of members) {
        if (!active || !actual) continue;
        const scale = number(card.params.scale) || 1;
        const effective = (current?.mode === "group" ? current.scale : scale) * frame.fit;
        const factor = effective / scale;
        const x = frame.x + (actual.x - originX) * frame.fit + (current?.mode === "group" ? current.x * frame.fit : 0);
        const y = frame.y + (actual.y - originY) * frame.fit + (current?.mode === "group" ? current.y * frame.fit : 0);
        // 变换施加在各成员，组容器本身不形成绘制层，允许组内外卡片交错。
        const itemX = originX;
        const itemY = originY + wrapper.offsetTop;
        wrapper.style.transform = `translate(${x - itemX - (actual.x - itemX) * factor}px, ${y - itemY - (actual.y - itemY) * factor}px) scale(${factor})`;
        groupCards.push([card.id, { box: { x, y, w: actual.w * factor, h: actual.h * factor }, scale: effective }]);
      }
      if (!groupCards.length) return;
      const groupLayout = { name: group.name, frame, order: group.order, visibleCount: groupCards.length, box: union(groupCards.map(([, card]) => card.box)) };
      for (const [id, card] of groupCards) layout.set(id, { ...card, group: groupLayout });
    });

    soloNodes.forEach((node, index) => {
      const { card, current } = independent[index];
      const actual = metrics(node, stage, zoom);
      if (!actual) return;
      const legacyScale = number(card.params.scale) || 1;
      const innerFit = number(node.querySelector<HTMLElement>(".vertical-card-fit")?.dataset.fit) || 1;
      const scale = legacyScale * innerFit;
      if (current?.mode !== "free") {
        layout.set(card.id, { box: actual, scale });
        return;
      }
      const ratio = current.scale / scale;
      node.style.transform = `translate(${current.x - actual.x * ratio}px, ${current.y - actual.y * ratio}px) scale(${ratio})`;
      layout.set(card.id, {
        box: { x: current.x, y: current.y, w: actual.w * ratio, h: actual.h * ratio },
        scale: current.scale,
      });
    });
    onLayout?.(layout);
  };

  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const resize = new ResizeObserver(() => measureRef.current());
    const observe = () => {
      resize.disconnect();
      resize.observe(layer.closest(".stage") ?? layer);
      layer.querySelectorAll(roots).forEach((node) => resize.observe(node));
    };
    const observer = new MutationObserver(() => { observe(); measureRef.current(); });
    observer.observe(layer, { childList: true, subtree: true });
    observe();
    const fontsLoaded = () => { observe(); measureRef.current(); };
    document.fonts.addEventListener("loadingdone", fontsLoaded);
    return () => {
      observer.disconnect();
      resize.disconnect();
      document.fonts.removeEventListener("loadingdone", fontsLoaded);
    };
  }, []);
  useLayoutEffect(() => { measureRef.current(); });

  function renderGroupCard({ card, active, rank, current }: Member, index: number) {
    const group = cardGroup(card, current)!;
    return (
      <div key={card.id} className="overlay-layout-member"
        data-seg-head={index === 0 && groups.get(group)?.order[0] === card.id ? "" : undefined}
        data-layout-probe={!active ? "" : undefined}
        style={{ zIndex: rank === undefined ? 2 : 10 + rank }}>
        {render(card, active ? time : card.start, !active)}
      </div>
    );
  }

  const soloLayers = independent.map(({ card, rank, current }) => {
        const band = geom.vertical && card.kind !== "focus-card" ? verticalBand(card.kind, card.params) : undefined;
        const defaultZ = band === "caption" ? 65 : band === "chapter" ? 60 : card.kind === "focus-card" ? 1 : 2;
        const keepGroupShape = current?.mode === "free" && !!card.seg;
        return (
          <div key={`card:${card.id}`} className="overlay-layout-card" style={{ zIndex: rank === undefined ? defaultZ : 10 + rank }}>
            {keepGroupShape ? (
              <div className="seg-stack detached-card-shape" data-seg-head="">{render(card, time, false)}</div>
            ) : (
              <VerticalCardFit band={band} placement={card.params}>{render(card, time, false)}</VerticalCardFit>
            )}
          </div>
        );
      });
  const groupEntries = [...groups.values()];
  const groupLayers = groupEntries.map((group) => {
        const head = group.members.find(({ card }) => card.id === group.order[0])?.card ??
        doc.cards.find(({ id }) => id === group.order[0]) ?? group.members[0].card;
        return (
          <div key={`group:${group.name}`} className="seg-stack overlay-layout-group"
            data-group={group.name} data-band={geom.vertical ? "upper" : undefined}
            style={{ left: geom.edge + number(head.params.offsetX), top: geom.topEdge + number(head.params.offsetY) }}>
            {group.members.map(renderGroupCard)}
          </div>
        );
      });
  const docOrder = new Map(doc.cards.map(({ id }, index) => [id, index]));
  const ordered = [
    ...soloLayers.map((node, index) => ({ node, index: docOrder.get(independent[index].card.id)! })),
    ...groupLayers.map((node, index) => ({ node, index: Math.min(...groupEntries[index].members
      .filter(({ active }) => active).map(({ card }) => docOrder.get(card.id)!)) })),
  ].sort((a, b) => a.index - b.index);
  return <div ref={ref} className="overlay-layout">{ordered.map(({ node }) => node)}</div>;
}
