import assert from "node:assert/strict";
import { parseOverlay, withOverlayCards } from "../../src/overlay/types.ts";
import { parsePickedOverlay } from "../../src/overlay/handoff.ts";
import { aspectOfDoc } from "../../src/stage.ts";

const cards = [
  { id: "late", kind: "stat-proof", start: 3, end: 4, seg: "__proto__", params: { value: 125, manualX: 16 } },
  { id: "__proto__", kind: "pin-board", start: 1, end: 4, seg: "__proto__", params: { title: "保留文案", offsetX: 14 } },
  { id: "tie", kind: "stat-proof", start: 1, end: 3, seg: "__proto__" },
  { id: "removed", kind: "unknown-kind", start: 0, end: 1 },
  { id: "outside", kind: "stat-proof", start: 2, end: 3 },
];
const parse = (raw) => {
  const parsed = parseOverlay(raw);
  assert.ok(parsed.doc, parsed.error);
  return parsed;
};

export function verifyDocument() {
  const legacy = { version: 1, cards };
  const { doc: old, warnings } = parse(legacy);
  assert.equal(aspectOfDoc(old), "16:9");
  assert.equal(warnings, undefined);
  assert.equal(old.refinement, undefined);
  assert.deepEqual(old.cards.map(({ id }) => id), ["__proto__", "tie", "outside", "late"]);
  assert.equal(old.cards[0].params.title, "保留文案");
  assert.equal(old.cards[0].params.offsetX, 14);
  assert.equal(old.cards.at(-1).params.manualX, 16);
  assert.ok(Object.hasOwn(old.cards[2].params, "value"), "由注册表补齐旧稿参数");
  assert.deepEqual(parse({ version: 1, cards: [] }).doc.cards, []);

  const refinement = JSON.parse(JSON.stringify({
    schema: 1,
    paintOrder: ["outside", "tie", "outside", "removed"],
    groups: {
      ["__proto__"]: {
        order: ["late", "late", "outside", "removed"],
        frames: { "9:16": { x: 70, y: 91, fit: 0.8 }, "16:9": { x: 89, y: -3, fit: 1.2 } },
      },
      departed: { order: ["outside"], frames: { "9:16": { x: 8, y: 9, fit: 1 } } },
      unused: { order: ["removed"], frames: { "9:16": { x: 8, y: 9, fit: 1 } } },
    },
    byCard: {
      ["__proto__"]: {
        frames: {
          "9:16": {
            base: { mode: "auto", group: "__proto__", order: 1, placement: { position: "top-left", offsetX: 14, scale: 1.1, title: "不可回写文案" } },
            current: { mode: "free", x: 72, y: 80, scale: 1.25 },
          },
          "16:9": { current: { mode: "group", group: "__proto__", x: 0, y: -3, scale: 1 } },
        },
      },
      outside: { frames: { "9:16": {
        base: { mode: "group", group: "departed", x: 0, y: 0, scale: 1 },
        current: { mode: "free", x: 20, y: 30, scale: 1 },
      } } },
      removed: { frames: {} },
    },
  }));
  const first = parse({ ...legacy, aspect: "9:16", refinement });
  const data = first.doc.refinement;
  assert.equal(data.schema, 1);
  assert.deepEqual(data.paintOrder, ["outside", "tie", "late", "__proto__"]);
  assert.deepEqual(data.groups["__proto__"].order, ["late", "__proto__", "tie"]);
  assert.ok(Object.hasOwn(data.groups, "__proto__"));
  assert.ok(Object.hasOwn(data.byCard, "__proto__"));
  assert.equal(Object.hasOwn(data.groups, "unused"), false);
  assert.deepEqual(data.groups.departed.order, ["outside"], "基准仍引用此组");
  const record = data.byCard["__proto__"].frames["9:16"];
  assert.deepEqual(record.base.placement, { position: "top-left", offsetX: 14, scale: 1.1 });
  assert.equal(record.base.order, 1);
  assert.deepEqual(record.current, { mode: "free", x: 72, y: 80, scale: 1.25 });
  const saved = JSON.stringify(first.doc);
  const reread = parse(saved);
  assert.deepEqual(reread.doc, first.doc);
  assert.equal(reread.warnings, undefined);
  assert.deepEqual(parsePickedOverlay(saved, null, "9:16").doc.refinement, data);

  const newCard = { ...old.cards[0], id: "inserted" };
  const next = withOverlayCards(first.doc, [...first.doc.cards.filter(({ id }) => id !== "__proto__"), newCard]);
  assert.deepEqual(next.refinement.groups["__proto__"].order, ["late", "tie", "inserted"]);
  assert.deepEqual(next.refinement.paintOrder, ["outside", "tie", "late", "inserted"]);
  assert.equal(Object.hasOwn(next.refinement.byCard, "__proto__"), false);
  assert.ok(Object.hasOwn(first.doc.refinement.byCard, "__proto__"));
  assert.deepEqual(withOverlayCards(next, []).refinement, { schema: 1, paintOrder: [] });

  const invalid = parse({ ...legacy, refinement: {
    ...refinement,
    groups: { ["__proto__"]: { order: [], frames: { "9:16": { x: 0, y: Infinity, fit: 1 }, "16:9": { x: 0, y: 0, fit: 0 } } } },
    byCard: { late: { frames: {
      "9:16": { base: { mode: "auto", placement: { scale: -1 } }, current: { mode: "free", x: 0, y: 0, scale: 0 } },
      "16:9": { current: { mode: "group", x: 0, y: 0, scale: 2 } },
      "4:3": { current: { mode: "free", x: 0, y: 0, scale: 2 } },
    } }, tie: { frames: { "9:16": { current: { mode: "bogus" } } } },
    outside: { frames: { "9:16": { current: { mode: "group", group: "missing", x: 0, y: 0, scale: 2 } } } } },
  } });
  assert.ok(invalid.warnings.length >= 4);
  assert.equal(Object.hasOwn(invalid.doc.refinement.byCard ?? {}, "late"), false);
  assert.equal(Object.hasOwn(invalid.doc.refinement.byCard ?? {}, "tie"), false);
  assert.equal(Object.hasOwn(invalid.doc.refinement.byCard ?? {}, "outside"), false);
  assert.deepEqual(invalid.doc.refinement.groups["__proto__"].frames, {});
  assert.equal(invalid.doc.cards.at(-1).params.manualX, 16);

  assert.ok(parse({ ...legacy, refinement: null }).warnings.length);
  const unknown = { ...legacy, cards: first.doc.cards, refinement: { schema: 2, other: { keep: true } } };
  const original = JSON.stringify(unknown);
  assert.match(parseOverlay(unknown).error, /无法.*精修/);
  assert.equal(parseOverlay(unknown).doc, undefined);
  assert.throws(() => parsePickedOverlay(original, null, "9:16"), /无法.*精修/);
  assert.equal(JSON.stringify(unknown), original);
  assert.ok(parseOverlay({ ...legacy, refinement: { schema: "1" } }).error);
  assert.ok(parseOverlay({ cards: [cards[3]] }).error);
  assert.ok(parseOverlay({ cards: [cards[0], cards[0]] }).error);
  assert.ok(parseOverlay({ cards: [{ ...cards[0], end: 1 }] }).error);
  assert.ok(parseOverlay({ cards: [{ ...cards[0], end: Infinity }] }).error);
  return { checks: ["v1 与空稿", "双画幅往返", "顺排和层级", "失效引用", "部分回退", "未知版本保护"] };
}
