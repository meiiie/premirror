import { describe, expect, it } from "bun:test";

import {
  createLayoutInputFromOptions,
  defaultPremirrorOptions,
} from "@premirror/core";
import { createPremirror } from "@premirror/prosemirror-adapter";
import { EditorState } from "prosemirror-state";

import { demoSchema } from "./schema";

describe("demo integration", () => {
  it("runs snapshot -> measure -> compose end-to-end", async () => {
    const options = defaultPremirrorOptions();
    const runtime = createPremirror(options);
    const compose = await import("@premirror/composer");

    const state = EditorState.create({
      schema: demoSchema,
      doc: demoSchema.node("doc", null, [
        demoSchema.node("paragraph", null, [
          demoSchema.text("Hello world from integration test."),
        ]),
        demoSchema.node("image", {
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
    const measured = runtime.measureSnapshot(snapshot);
    const layout = compose.composeLayout(
      measured,
      null,
      createLayoutInputFromOptions(options),
    );

    expect(layout.pages.length).toBeGreaterThan(0);
    expect(layout.metrics.blocks).toBeGreaterThan(0);
    expect(layout.pages[0]?.frames[0]?.fragments.some((fragment) => fragment.kind === "image")).toBe(true);
  });

  it("composes floating images with wrapped text lanes", async () => {
    const options = defaultPremirrorOptions({
      policies: {
        slotSelectionPolicy: "multi_slot_fill",
      },
    });
    const runtime = createPremirror(options);
    const compose = await import("@premirror/composer");

    const state = EditorState.create({
      schema: demoSchema,
      doc: demoSchema.node("doc", null, [
        demoSchema.node("image", {
          src: "https://example.com/lesson.svg",
          alt: "Floating lesson image",
          widthPx: 240,
          heightPx: 160,
          align: "left",
          placement: "float",
          offsetXPx: 0,
          offsetYPx: 0,
        }),
        demoSchema.node("paragraph", null, [
          demoSchema.text(
            Array.from({ length: 60 }, () => "Premirror wraps text beside a floated image").join(" "),
          ),
        ]),
      ]),
      plugins: runtime.plugins,
    });

    const snapshot = runtime.toSnapshot(state);
    const measured = runtime.measureSnapshot(snapshot);
    const layout = compose.composeLayout(
      measured,
      null,
      createLayoutInputFromOptions(options),
    );

    const textFragment = layout.pages[0]?.frames[0]?.fragments.find((fragment) => fragment.kind === "text");
    expect(textFragment).toBeDefined();
    if (!textFragment) return;
    expect(textFragment.lines.some((line) => (line.runs[0]?.x ?? 0) > 0)).toBe(true);
  });
});
