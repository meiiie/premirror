import { describe, expect, it } from "bun:test";

import { defaultPremirrorOptions } from "@premirror/core";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

import { createPremirror, premirrorInvalidationKey } from "./index";

const paragraphSpec = basicSchema.spec.nodes.get("paragraph");
const imageSpec = basicSchema.spec.nodes.get("image");

if (!paragraphSpec || !imageSpec) {
  throw new Error("Missing base schema specs");
}

const schema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes
      .update("paragraph", {
        ...paragraphSpec,
        attrs: {
          ...paragraphSpec.attrs,
          manualPageBreakBefore: { default: false },
        },
      })
      .update("image", {
        ...imageSpec,
        inline: false,
        group: "block",
        atom: true,
        draggable: true,
        attrs: {
          src: { default: "" },
          alt: { default: "" },
          widthPx: { default: 480 },
          heightPx: { default: 270 },
          align: { default: "center" },
        },
        parseDOM: [],
        toDOM(node) {
          return [
            "img",
            {
              src: node.attrs.src,
              alt: node.attrs.alt,
              width: node.attrs.widthPx,
              height: node.attrs.heightPx,
              "data-premirror-image-block": "true",
            },
          ];
        },
      }),
    "paragraph block*",
    "block",
  ),
  marks: basicSchema.spec.marks,
});

describe("@premirror/prosemirror-adapter", () => {
  it("extracts snapshot blocks and marks", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const strong = schema.marks.strong;
    if (!strong) throw new Error("Missing strong mark");
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [
          schema.text("Hello ", []),
          schema.text("bold", [strong.create()]),
        ]),
      ]),
      plugins: runtime.plugins,
    });

    const snapshot = runtime.toSnapshot(state);
    expect(snapshot.blocks.length).toBe(1);
    expect(snapshot.blocks[0]?.runs.length).toBeGreaterThanOrEqual(2);
  });

  it("measures snapshot runs", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("Measure me")]),
      ]),
      plugins: runtime.plugins,
    });
    const measured = runtime.measureSnapshot(runtime.toSnapshot(state));
    const firstKey = Object.keys(measured.measuredRuns)[0];
    expect(firstKey).toBeDefined();
    expect(measured.measuredRuns[firstKey!]?.widthPx).toBeGreaterThanOrEqual(0);
  });

  it("extracts image blocks with explicit dimensions", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("image", {
          src: "https://example.com/lesson.svg",
          alt: "Lesson image",
          widthPx: 420,
          heightPx: 240,
          align: "center",
        }),
      ]),
      plugins: runtime.plugins,
    });

    const snapshot = runtime.toSnapshot(state);
    expect(snapshot.blocks.length).toBe(1);
    expect(snapshot.blocks[0]?.type).toBe("image");
    expect(snapshot.blocks[0]?.attrs.widthPx).toBe(420);
    expect(snapshot.blocks[0]?.attrs.heightPx).toBe(240);
    expect(snapshot.blocks[0]?.runs).toEqual([]);
  });

  it("insertPageBreak command dispatches a transaction", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("One")]),
      ]),
      plugins: runtime.plugins,
    });

    let nextState: EditorState | undefined;
    const didRun = runtime.commands.insertPageBreak(state, (tr) => {
      nextState = state.apply(tr);
    });

    expect(didRun).toBe(true);
    expect(nextState).toBeDefined();
    if (!nextState) return;
    expect(nextState.doc.childCount).toBeGreaterThanOrEqual(2);
  });

  it("tracks invalidation range on doc change", () => {
    const runtime = createPremirror(defaultPremirrorOptions());
    const state = EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("abc")]),
      ]),
      plugins: runtime.plugins,
    });
    const tr = state.tr.insertText("x", 2);
    const next = state.apply(tr);
    const inval = premirrorInvalidationKey.getState(next) ?? null;
    expect(inval).not.toBeNull();
    expect(runtime.getInvalidationRange(next)).toEqual(inval);
  });
});
