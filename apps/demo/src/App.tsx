import { Toolbar } from "@base-ui-components/react/toolbar";
import { Switch } from "@base-ui-components/react/switch";
import {
  ProseMirror,
  ProseMirrorDoc,
  reactKeys,
} from "@handlewithcare/react-prosemirror";
import {
  createLayoutInputFromOptions,
  defaultPremirrorOptions,
  type ImageAlignment,
  type ImagePlacement,
  type LayoutOutput,
} from "@premirror/core";
import { createPremirror } from "@premirror/prosemirror-adapter";
import {
  getPageLayoutGeometry,
  type PageLayoutMode,
  PremirrorPageViewport,
  usePremirrorEngine,
  useProjectedSelection,
} from "@premirror/react";
import { keymap } from "prosemirror-keymap";
import { type Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "prosemirror-state";
import { baseKeymap, joinBackward, selectNodeBackward, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { Decoration, DecorationSet } from "prosemirror-view";
import { type ChangeEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LuBold, LuItalic, LuCode, LuSeparatorHorizontal, LuGithub, LuImage } from "react-icons/lu";

import lessonImageUrl from "./assets/lesson-image.svg";
import { demoSchema } from "./schema";

function buildInitialState(
  runtime: ReturnType<typeof createPremirror>,
): EditorState {
  const strong = demoSchema.marks.strong;
  const em = demoSchema.marks.em;
  const code = demoSchema.marks.code;
  if (!strong || !em || !code) {
    throw new Error("demoSchema missing basic marks");
  }

  const fixtureParagraphs = [
    "Premirror Milestone 1 test document. This paragraph is intentionally long so we can validate word wrapping inside the composed frame. The quick brown fox jumps over the lazy dog while pagination logic tracks run boundaries and maps document ranges to absolute fragment positions.",
    "Second paragraph for wrapping and flow. We expect lines to break naturally at word boundaries and continue on subsequent lines before moving to the next page frame. This should mimic a word-processor style reading flow rather than a single scroll box.",
    "Third paragraph adds more content pressure. Layout metrics should increase pages when required, and each line fragment should remain fully inside the page content rect with no orphan leading character rendered outside its decorated run.",
    "Fourth paragraph repeats structured prose to force pagination. Typography and measured widths from pretext should drive deterministic line breaks. Selection and caret mapping should still align with these visual fragments.",
    "Fifth paragraph: the architecture keeps ProseMirror as source of truth while decorations project fragments into absolute page coordinates. This gives us editable rich text with page-aware rendering behavior.",
    "Sixth paragraph closes the synthetic test fixture. If everything works, we should see multiple pages and no inner frame scrolling. Wrapping should remain stable across refreshes.",
  ];
  const repeated = Array.from({ length: 7 }, (_, i) =>
    fixtureParagraphs.map((text) => `${text} Section ${i + 1}.`),
  ).flat();
  const docNodes = repeated.flatMap((text, i) => {
    const paragraph = demoSchema.node("paragraph", null, [demoSchema.text(text)]);
    const blocks: ProseMirrorNode[] = [paragraph];
    if ((i + 1) % 8 === 0) {
      blocks.push(
        demoSchema.node("image", {
          src: lessonImageUrl,
          alt: `Lesson illustration ${i + 1}`,
          widthPx: 480,
          heightPx: 270,
          align: i === 7 ? "left" : "center",
          placement: i === 7 ? "float" : "block",
          offsetXPx: 0,
          offsetYPx: 0,
        }),
      );
    }
    if ((i + 1) % 3 === 0) {
      blocks.push(demoSchema.node("paragraph"));
    }
    return blocks;
  });
  const doc = demoSchema.node(
    "doc",
    null,
    docNodes,
  );

  return EditorState.create({
    doc,
    schema: demoSchema,
    plugins: [
      reactKeys(),
      history(),
      ...runtime.plugins,
      keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Shift-Mod-z": redo,
        "Mod-b": toggleMark(strong),
        "Mod-i": toggleMark(em),
        "Mod-`": toggleMark(code),
        ArrowLeft: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const pos = state.selection.from;
          if (pos <= 1) return false;
          if (!dispatch) return true;
          dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos - 1)).scrollIntoView());
          return true;
        },
        ArrowRight: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const pos = state.selection.from;
          const max = Math.max(1, state.doc.content.size);
          if (pos >= max) return false;
          if (!dispatch) return true;
          dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos + 1)).scrollIntoView());
          return true;
        },
        Backspace: (state, dispatch) => {
          if (!state.selection.empty) return false;
          const { $from } = state.selection;
          if ($from.parent.isTextblock && $from.parentOffset === 0) {
            if (joinBackward(state, dispatch)) return true;
            if (selectNodeBackward(state, dispatch)) return true;
          }
          const pos = state.selection.from;
          if (pos <= 1) return false;
          if (!dispatch) return true;
          dispatch(state.tr.delete(pos - 1, pos).scrollIntoView());
          return true;
        },
      }),
      keymap(baseKeymap),
      ...runtime.keymaps,
    ],
  });
}

function styleForRunPosition(
  left: number,
  top: number,
  _width: number,
  lineHeight: number,
): string {
  return [
    "position:absolute",
    `left:${left}px`,
    `top:${top}px`,
    `height:${lineHeight}px`,
    `line-height:${lineHeight}px`,
    "white-space:pre",
  ].join(";");
}

const IMAGE_WIDTH_PRESETS = [320, 480, 640] as const;
const MIN_IMAGE_WIDTH_PX = 180;
const MIN_IMAGE_HEIGHT_PX = 120;

type DemoImageAttrs = {
  src: string;
  alt: string;
  widthPx: number;
  heightPx: number;
  align: ImageAlignment;
  placement: ImagePlacement;
  offsetXPx: number;
  offsetYPx: number;
};

type SelectedImageInfo = {
  pos: number;
  attrs: DemoImageAttrs;
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  frame: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  anchorTop: number;
};

type ResizeSession = {
  pos: number;
  startX: number;
  startWidth: number;
  aspectRatio: number;
  maxWidth: number;
};

type MoveSession = {
  pos: number;
  clientX: number;
  clientY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  imageWidth: number;
  imageHeight: number;
  previewLeft: number;
  previewTop: number;
};

type ParagraphBox = {
  from: number;
  to: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type ImageBox = {
  from: number;
  to: number;
  left: number;
  top: number;
  width: number;
  height: number;
  pageIndex: number;
  frameIndex: number;
  frameLeft: number;
  frameTop: number;
  frameWidth: number;
  frameHeight: number;
};

type FrameBox = {
  pageIndex: number;
  frameIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type FragmentAnchor = {
  pos: number;
  pageIndex: number;
  frameIndex: number;
  top: number;
  bottom: number;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readImageAttrs(node: ProseMirrorNode): DemoImageAttrs {
  const widthPx = Number(node.attrs.widthPx ?? 480);
  const heightPx = Number(node.attrs.heightPx ?? 270);
  const offsetXPx = Number(node.attrs.offsetXPx ?? 0);
  const offsetYPx = Number(node.attrs.offsetYPx ?? 0);
  return {
    src: String(node.attrs.src ?? ""),
    alt: String(node.attrs.alt ?? ""),
    widthPx: Number.isFinite(widthPx) ? widthPx : 480,
    heightPx: Number.isFinite(heightPx) ? heightPx : 270,
    align: (node.attrs.align === "left" || node.attrs.align === "right" ? node.attrs.align : "center") as ImageAlignment,
    placement: (node.attrs.placement === "float" ? "float" : "block") as ImagePlacement,
    offsetXPx: Number.isFinite(offsetXPx) ? Math.max(0, offsetXPx) : 0,
    offsetYPx: Number.isFinite(offsetYPx) ? Math.max(0, offsetYPx) : 0,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected file reader result"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function measureImage(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = dataUrl;
  });
}

function clampPos(doc: ProseMirrorNode, pos: number): number {
  const max = Math.max(1, doc.content.size);
  return Math.max(1, Math.min(pos, max));
}

function paragraphRangeFromBlockId(
  doc: ProseMirrorNode,
  blockId: string,
): { from: number; to: number } | null {
  const m = /^block-(\d+)$/.exec(blockId);
  if (!m) return null;
  const pos = clampPos(doc, Number.parseInt(m[1]!, 10));
  const node = doc.nodeAt(pos);
  if (!node || node.type.name !== "paragraph") return null;
  return { from: pos, to: pos + node.nodeSize };
}

function paragraphRangeAtPos(
  doc: ProseMirrorNode,
  pos: number,
): { from: number; to: number } | null {
  const clamped = clampPos(doc, pos);
  const resolved = doc.resolve(clamped);
  for (let d = resolved.depth; d >= 0; d--) {
    const node = resolved.node(d);
    if (node.type.name !== "paragraph") continue;
    const from = resolved.before(d);
    const to = from + node.nodeSize;
    return { from, to };
  }
  return null;
}

function blockPosFromBlockId(blockId: string): number | null {
  const match = /^block-(\d+)$/.exec(blockId);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

function collectFrameBoxes(
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
): FrameBox[] {
  const frameBoxes: FrameBox[] = [];
  const geometry = getPageLayoutGeometry(layout, pageLayoutMode);
  layout.pages.forEach((page, pageIdx) => {
    const pagePlacement = geometry.pagePlacements[pageIdx] ?? { left: 0, top: 0 };
    page.frames.forEach((frame, frameIdx) => {
      frameBoxes.push({
        pageIndex: pageIdx,
        frameIndex: frameIdx,
        left: pagePlacement.left + frame.bounds.x,
        top: pagePlacement.top + frame.bounds.y,
        width: frame.bounds.width,
        height: frame.bounds.height,
      });
    });
  });
  return frameBoxes;
}

function collectFragmentAnchors(
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
): FragmentAnchor[] {
  const anchors: FragmentAnchor[] = [];
  const geometry = getPageLayoutGeometry(layout, pageLayoutMode);
  layout.pages.forEach((page, pageIdx) => {
    const pagePlacement = geometry.pagePlacements[pageIdx] ?? { left: 0, top: 0 };
    page.frames.forEach((frame, frameIdx) => {
      frame.fragments.forEach((fragment) => {
        const pos = blockPosFromBlockId(fragment.blockId);
        if (pos === null) return;
        if (fragment.kind === "image" && fragment.bounds) {
          anchors.push({
            pos,
            pageIndex: pageIdx,
            frameIndex: frameIdx,
            top: pagePlacement.top + frame.bounds.y + fragment.bounds.y,
            bottom: pagePlacement.top + frame.bounds.y + fragment.bounds.y + fragment.bounds.height,
          });
          return;
        }
        if (fragment.lines.length === 0) return;
        const top = Math.min(...fragment.lines.map((line) => pagePlacement.top + frame.bounds.y + line.y));
        const bottom = Math.max(
          ...fragment.lines.map((line) => pagePlacement.top + frame.bounds.y + line.y + line.height),
        );
        anchors.push({
          pos,
          pageIndex: pageIdx,
          frameIndex: frameIdx,
          top,
          bottom,
        });
      });
    });
  });
  return anchors;
}

function findFrameForPoint(
  x: number,
  y: number,
  frames: FrameBox[],
): FrameBox | null {
  const containing = frames.find(
    (frame) =>
      x >= frame.left &&
      x <= frame.left + frame.width &&
      y >= frame.top &&
      y <= frame.top + frame.height,
  );
  if (containing) return containing;
  if (frames.length === 0) return null;
  return frames.reduce((best, frame) => {
    const bestCx = best.left + best.width / 2;
    const bestCy = best.top + best.height / 2;
    const frameCx = frame.left + frame.width / 2;
    const frameCy = frame.top + frame.height / 2;
    const bestDistance = (bestCx - x) ** 2 + (bestCy - y) ** 2;
    const frameDistance = (frameCx - x) ** 2 + (frameCy - y) ** 2;
    return frameDistance < bestDistance ? frame : best;
  });
}

function alignForOffsetX(offsetXPx: number, maxOffsetX: number): ImageAlignment {
  if (maxOffsetX <= 0) return "center";
  const leftDistance = Math.abs(offsetXPx);
  const centerDistance = Math.abs(offsetXPx - maxOffsetX / 2);
  const rightDistance = Math.abs(offsetXPx - maxOffsetX);
  if (leftDistance <= centerDistance && leftDistance <= rightDistance) return "left";
  if (rightDistance <= centerDistance && rightDistance <= leftDistance) return "right";
  return "center";
}

function pointerToViewportContentPoint(
  clientX: number,
  clientY: number,
  container: HTMLDivElement | null,
): { x: number; y: number } {
  if (!container) {
    return { x: clientX, y: clientY };
  }
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left + container.scrollLeft,
    y: clientY - rect.top + container.scrollTop,
  };
}

function collectImageBoxes(
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
): ImageBox[] {
  const imageBoxes: ImageBox[] = [];
  const geometry = getPageLayoutGeometry(layout, pageLayoutMode);
  layout.pages.forEach((page, pageIdx) => {
    const pagePlacement = geometry.pagePlacements[pageIdx] ?? { left: 0, top: 0 };
    page.frames.forEach((frame, frameIdx) => {
      for (const fragment of frame.fragments) {
        if (fragment.kind !== "image" || !fragment.bounds) continue;
        imageBoxes.push({
          from: fragment.pmRange.from,
          to: fragment.pmRange.to,
          left: pagePlacement.left + frame.bounds.x + fragment.bounds.x,
          top: pagePlacement.top + frame.bounds.y + fragment.bounds.y,
          width: fragment.bounds.width,
          height: fragment.bounds.height,
          pageIndex: pageIdx,
          frameIndex: frameIdx,
          frameLeft: pagePlacement.left + frame.bounds.x,
          frameTop: pagePlacement.top + frame.bounds.y,
          frameWidth: frame.bounds.width,
          frameHeight: frame.bounds.height,
        });
      }
    });
  });
  return imageBoxes;
}

function buildFragmentDecorations(
  doc: ProseMirrorNode,
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
  selectedImagePos: number | null,
): DecorationSet {
  const decorations: Decoration[] = [];
  const paragraphBoxes = new Map<string, ParagraphBox>();
  const imageBoxes = collectImageBoxes(layout, pageLayoutMode);
  const runPlacements: Array<{
    runFrom: number;
    runTo: number;
    paragraphKey: string;
    left: number;
    top: number;
    width: number;
    lineHeight: number;
  }> = [];

  const upsertParagraphLine = (
    key: string,
    paragraph: { from: number; to: number },
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => {
    const prev = paragraphBoxes.get(key);
    if (!prev) {
      paragraphBoxes.set(key, {
        from: paragraph.from,
        to: paragraph.to,
        left,
        top,
        right,
        bottom,
      });
      return;
    }
    prev.left = Math.min(prev.left, left);
    prev.top = Math.min(prev.top, top);
    prev.right = Math.max(prev.right, right);
    prev.bottom = Math.max(prev.bottom, bottom);
  };

  const geometry = getPageLayoutGeometry(layout, pageLayoutMode);
  layout.pages.forEach((page, pageIdx) => {
    const pagePlacement = geometry.pagePlacements[pageIdx] ?? { left: 0, top: 0 };
    for (const frame of page.frames) {
      for (const fragment of frame.fragments) {
        if (fragment.kind === "image") continue;
        const fragmentParagraph = paragraphRangeFromBlockId(doc, fragment.blockId);
        for (const line of fragment.lines) {
          const lineTop = pagePlacement.top + frame.bounds.y + line.y;
          const lineBottom = lineTop + line.height;
          const paragraph =
            fragmentParagraph ??
            paragraphRangeAtPos(doc, line.pmRange.from) ??
            paragraphRangeAtPos(doc, line.pmRange.from > 1 ? line.pmRange.from - 1 : line.pmRange.from);
          if (paragraph) {
            // Paragraph box should represent full editable context width, not
            // just measured text bounds, so clicks in trailing whitespace map
            // to expected caret positions.
            const lineLeft = pagePlacement.left + frame.bounds.x;
            const lineRight = pagePlacement.left + frame.bounds.x + frame.bounds.width;
            const paragraphKey = `${paragraph.from}:${paragraph.to}`;
            upsertParagraphLine(
              paragraphKey,
              paragraph,
              lineLeft,
              lineTop,
              lineRight,
              lineBottom,
            );
          }

          for (const run of line.runs) {
            if (run.pmRange.from >= run.pmRange.to) continue;
            const runParagraph =
              fragmentParagraph ??
              paragraphRangeAtPos(doc, run.pmRange.from) ??
              paragraphRangeAtPos(doc, run.pmRange.from > 1 ? run.pmRange.from - 1 : run.pmRange.from);
            if (!runParagraph) continue;
            runPlacements.push({
              runFrom: run.pmRange.from,
              runTo: run.pmRange.to,
              paragraphKey: `${runParagraph.from}:${runParagraph.to}`,
              left: pagePlacement.left + frame.bounds.x + run.x,
              top: lineTop,
              width: run.width,
              lineHeight: line.height,
            });
          }
        }
      }
    }
  });

  for (const box of paragraphBoxes.values()) {
    decorations.push(
      Decoration.node(box.from, box.to, {
        class: "premirror-fragment-paragraph",
        style: [
          "position:absolute",
          `left:${box.left}px`,
          `top:${box.top}px`,
          `width:${Math.max(1, box.right - box.left)}px`,
          `height:${Math.max(1, box.bottom - box.top)}px`,
          "margin:0",
          "overflow:visible",
        ].join(";"),
      }),
    );
  }

  for (const image of imageBoxes) {
    const imageClass =
      selectedImagePos === image.from
        ? "premirror-image-block ProseMirror-selectednode"
        : "premirror-image-block";
    decorations.push(
      Decoration.node(image.from, image.to, {
        class: imageClass,
        style: [
          "position:absolute",
          `left:${image.left}px`,
          `top:${image.top}px`,
          `width:${Math.max(1, image.width)}px`,
          `height:${Math.max(1, image.height)}px`,
          "margin:0",
        ].join(";"),
      }),
    );
  }

  for (const run of runPlacements) {
    const paragraphBox = paragraphBoxes.get(run.paragraphKey);
    if (!paragraphBox) continue;
    decorations.push(
      Decoration.inline(
        run.runFrom,
        run.runTo,
        {
          class: "premirror-fragment-run",
          style: styleForRunPosition(
            run.left - paragraphBox.left,
            run.top - paragraphBox.top,
            run.width,
            run.lineHeight,
          ),
        },
        {
          inclusiveStart: false,
          inclusiveEnd: false,
        },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

function getSelectedImageInfo(
  editorState: EditorState,
  imageBoxes: ImageBox[],
): SelectedImageInfo | null {
  const selection = editorState.selection;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") {
    return null;
  }
  const box = imageBoxes.find((image) => image.from === selection.from && image.to === selection.to);
  if (!box) return null;
  const attrs = readImageAttrs(selection.node);
  return {
    pos: selection.from,
    attrs,
    rect: {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
    },
    frame: {
      left: box.frameLeft,
      top: box.frameTop,
      width: box.frameWidth,
      height: box.frameHeight,
    },
    anchorTop: box.top - (attrs.placement === "float" ? attrs.offsetYPx : 0),
  };
}

export function App() {
  const options = useMemo(() => {
    const defaults = defaultPremirrorOptions();
    return {
      ...defaults,
      policies: {
        ...defaults.policies,
        slotSelectionPolicy: "multi_slot_fill" as const,
      },
      typography: {
        ...defaults.typography,
        defaultFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      },
    };
  }, []);
  const runtime = useMemo(() => createPremirror(options), [options]);
  const layoutInput = useMemo(() => createLayoutInputFromOptions(options), [options]);

  const [editorState, setEditorState] = useState(() => buildInitialState(runtime));
  const [showDebug, setShowDebug] = useState(false);
  const [pageLayoutMode, setPageLayoutMode] = useState<PageLayoutMode>("spread");
  const [moveSession, setMoveSession] = useState<MoveSession | null>(null);
  const [resizeSession, setResizeSession] = useState<ResizeSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const moveSessionRef = useRef<MoveSession | null>(null);
  const viewportWrapRef = useRef<HTMLDivElement | null>(null);

  const { layout, diagnostics } = usePremirrorEngine({
    editorState,
    runtime,
    layoutInput,
  });

  const contentFrameWidth = layoutInput.page.widthPx - layoutInput.margins.leftPx - layoutInput.margins.rightPx;

  const projection = useProjectedSelection(editorState, layout, pageLayoutMode);
  const frameBoxes = useMemo(() => collectFrameBoxes(layout, pageLayoutMode), [layout, pageLayoutMode]);
  const fragmentAnchors = useMemo(
    () => collectFragmentAnchors(layout, pageLayoutMode),
    [layout, pageLayoutMode],
  );
  const imageBoxes = useMemo(() => collectImageBoxes(layout, pageLayoutMode), [layout, pageLayoutMode]);
  const selectedImagePos = useMemo(() => {
    const selection = editorState.selection;
    return selection instanceof NodeSelection && selection.node.type.name === "image"
      ? selection.from
      : null;
  }, [editorState.selection]);
  const fragmentDecorations = useMemo(
    () => buildFragmentDecorations(editorState.doc, layout, pageLayoutMode, selectedImagePos),
    [editorState.doc, layout, pageLayoutMode, selectedImagePos],
  );
  const selectedImage = useMemo(
    () => getSelectedImageInfo(editorState, imageBoxes),
    [editorState, imageBoxes],
  );

  useEffect(() => {
    moveSessionRef.current = moveSession;
  }, [moveSession]);

  const dispatch = useCallback((tr: Transaction) => {
    setEditorState((s) => s.apply(tr));
  }, []);

  const applyTransaction = useCallback(
    (build: (state: EditorState) => Transaction | null) => {
      setEditorState((state) => {
        const tr = build(state);
        return tr ? state.apply(tr) : state;
      });
    },
    [],
  );

  const run = useCallback(
    (fn: (s: EditorState, d?: (tr: Parameters<EditorState["apply"]>[0]) => void) => boolean) => {
      fn(editorState, dispatch);
    },
    [editorState, dispatch],
  );

  const updateImageAttrsAtPos = useCallback(
    (pos: number, patch: Partial<DemoImageAttrs>) => {
      applyTransaction((state) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== "image") return null;
        let tr = state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          ...patch,
        });
        tr = tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView();
        return tr;
      });
    },
    [applyTransaction],
  );

  const commitImageMove = useCallback(
    (session: MoveSession) => {
      const centerX = session.previewLeft + session.imageWidth / 2;
      const centerY = session.previewTop + session.imageHeight / 2;
      const targetFrame = findFrameForPoint(centerX, centerY, frameBoxes);
      if (!targetFrame) {
        updateImageAttrsAtPos(session.pos, {
          placement: "float",
        });
        return;
      }

      applyTransaction((state) => {
        const node = state.doc.nodeAt(session.pos);
        if (!node || node.type.name !== "image") return null;

        const frameAnchors = fragmentAnchors
          .filter(
            (anchor) =>
              anchor.pageIndex === targetFrame.pageIndex &&
              anchor.frameIndex === targetFrame.frameIndex &&
              anchor.pos !== session.pos,
          )
          .sort((a, b) => a.top - b.top);

        const precedingAnchor =
          [...frameAnchors]
            .reverse()
            .find((anchor) => anchor.top + (anchor.bottom - anchor.top) / 2 <= centerY) ?? null;

        let insertPos = session.pos;
        let anchorTop = targetFrame.top;

        if (precedingAnchor) {
          const precedingNode = state.doc.nodeAt(precedingAnchor.pos);
          insertPos = precedingAnchor.pos + (precedingNode?.nodeSize ?? 0);
          anchorTop = precedingAnchor.bottom;
        } else if (frameAnchors[0]) {
          insertPos = frameAnchors[0].pos;
          anchorTop = targetFrame.top;
        } else {
          insertPos = Math.max(1, state.doc.content.size);
          anchorTop = targetFrame.top;
        }

        const maxOffsetX = Math.max(0, targetFrame.width - session.imageWidth);
        const maxOffsetY = Math.max(
          0,
          targetFrame.top + targetFrame.height - session.imageHeight - anchorTop,
        );
        const offsetXPx = Math.round(
          clampNumber(session.previewLeft - targetFrame.left, 0, maxOffsetX),
        );
        const offsetYPx = Math.round(
          clampNumber(session.previewTop - anchorTop, 0, maxOffsetY),
        );
        const align = alignForOffsetX(offsetXPx, maxOffsetX);
        const nextAttrs = {
          ...node.attrs,
          placement: "float",
          offsetXPx,
          offsetYPx,
          align,
        };

        if (insertPos === session.pos) {
          let tr = state.tr.setNodeMarkup(session.pos, undefined, nextAttrs);
          tr = tr.setSelection(NodeSelection.create(tr.doc, session.pos)).scrollIntoView();
          return tr;
        }

        let tr = state.tr.delete(session.pos, session.pos + node.nodeSize);
        const mappedInsertPos = tr.mapping.map(insertPos, -1);
        tr = tr.insert(mappedInsertPos, node.type.create(nextAttrs));
        tr = tr.setSelection(NodeSelection.create(tr.doc, mappedInsertPos)).scrollIntoView();
        return tr;
      });
    },
    [applyTransaction, fragmentAnchors, frameBoxes, updateImageAttrsAtPos],
  );

  useEffect(() => {
    if (!moveSession) return;

    const onPointerMove = (event: PointerEvent) => {
      const nextPoint = pointerToViewportContentPoint(
        event.clientX,
        event.clientY,
        viewportWrapRef.current,
      );
      setMoveSession((session) =>
        !session
          ? null
          : (() => {
              const nextSession = {
                ...session,
                clientX: event.clientX,
                clientY: event.clientY,
                previewLeft: nextPoint.x - session.pointerOffsetX,
                previewTop: nextPoint.y - session.pointerOffsetY,
              };
              moveSessionRef.current = nextSession;
              return nextSession;
            })(),
      );
    };

    const onPointerUp = () => {
      const session = moveSessionRef.current;
      if (session) {
        commitImageMove(session);
      }
      window.setTimeout(() => {
        const editor = document.querySelector(".ProseMirror");
        if (editor instanceof HTMLElement) {
          editor.focus();
        }
      }, 0);
      moveSessionRef.current = null;
      setMoveSession(null);
    };

    const scrollMargin = 96;
    const scrollStep = 96;
    const autoScrollInterval = window.setInterval(() => {
      const session = moveSessionRef.current;
      const container = viewportWrapRef.current;
      if (!session || !container) return;
      const rect = container.getBoundingClientRect();
      let didScroll = false;
      if (session.clientY > rect.bottom - scrollMargin) {
        container.scrollTop += scrollStep;
        didScroll = true;
      } else if (session.clientY < rect.top + scrollMargin) {
        container.scrollTop -= scrollStep;
        didScroll = true;
      }
      if (didScroll) {
        const nextPoint = pointerToViewportContentPoint(
          session.clientX,
          session.clientY,
          container,
        );
        setMoveSession((current) =>
          !current
            ? null
            : (() => {
                const nextSession = {
                  ...current,
                  previewLeft: nextPoint.x - current.pointerOffsetX,
                  previewTop: nextPoint.y - current.pointerOffsetY,
                };
                moveSessionRef.current = nextSession;
                return nextSession;
              })(),
        );
      }
    }, 16);

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.clearInterval(autoScrollInterval);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [commitImageMove, moveSession]);

  useEffect(() => {
    if (!resizeSession) return;

    const onPointerMove = (event: PointerEvent) => {
      const nextWidth = clampNumber(
        resizeSession.startWidth + (event.clientX - resizeSession.startX),
        MIN_IMAGE_WIDTH_PX,
        resizeSession.maxWidth,
      );
      const nextHeight = Math.max(
        MIN_IMAGE_HEIGHT_PX,
        Math.round(nextWidth / Math.max(0.1, resizeSession.aspectRatio)),
      );
      updateImageAttrsAtPos(resizeSession.pos, {
        widthPx: Math.round(nextWidth),
        heightPx: nextHeight,
      });
    };

    const onPointerUp = () => {
      setResizeSession(null);
    };

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizeSession, updateImageAttrsAtPos]);

  const strongMark = demoSchema.marks.strong;
  const emMark = demoSchema.marks.em;
  const codeMark = demoSchema.marks.code;

  const toggleBold = useCallback(() => {
    if (!strongMark) return;
    run((s, d) => toggleMark(strongMark)(s, d));
  }, [run, strongMark]);

  const toggleItalic = useCallback(() => {
    if (!emMark) return;
    run((s, d) => toggleMark(emMark)(s, d));
  }, [run, emMark]);

  const toggleCode = useCallback(() => {
    if (!codeMark) return;
    run((s, d) => toggleMark(codeMark)(s, d));
  }, [run, codeMark]);

  const insertImage = useCallback(() => {
    run((state, dispatchTransaction) => {
      const image = state.schema.nodes.image;
      if (!image) return false;
      const { $from } = state.selection;
      const insertPos = $from.depth > 0 ? $from.after(1) : state.selection.to;
      const node = image.create({
        src: lessonImageUrl,
        alt: "Lesson illustration",
        widthPx: 480,
        heightPx: 270,
        align: "center",
        placement: "block",
        offsetXPx: 0,
        offsetYPx: 0,
      });
      if (dispatchTransaction) {
        dispatchTransaction(state.tr.insert(insertPos, node).scrollIntoView());
      }
      return true;
    });
  }, [run]);

  const preventToolbarFocus = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
  }, []);

  const setSelectedImagePlacement = useCallback(
    (placement: ImagePlacement) => {
      if (!selectedImage) return;
      if (placement === "block") {
        updateImageAttrsAtPos(selectedImage.pos, {
          placement: "block",
          offsetXPx: 0,
          offsetYPx: 0,
        });
        return;
      }
      const maxX = Math.max(0, selectedImage.frame.width - selectedImage.rect.width);
      const maxY = Math.max(
        0,
        selectedImage.frame.top + selectedImage.frame.height - selectedImage.rect.height - selectedImage.anchorTop,
      );
      const offsetXPx = Math.round(
        clampNumber(selectedImage.rect.left - selectedImage.frame.left, 0, maxX),
      );
      const offsetYPx = Math.round(
        clampNumber(selectedImage.rect.top - selectedImage.anchorTop, 0, maxY),
      );
      updateImageAttrsAtPos(selectedImage.pos, {
        placement: "float",
        offsetXPx,
        offsetYPx,
        align: alignForOffsetX(offsetXPx, maxX),
      });
    },
    [selectedImage, updateImageAttrsAtPos],
  );

  const setSelectedImageAlign = useCallback(
    (align: ImageAlignment) => {
      if (!selectedImage) return;
      if (selectedImage.attrs.placement === "float") {
        const maxX = Math.max(0, selectedImage.frame.width - selectedImage.rect.width);
        const offsetXPx =
          align === "left" ? 0 : align === "right" ? maxX : Math.round(maxX / 2);
        updateImageAttrsAtPos(selectedImage.pos, {
          align,
          offsetXPx,
        });
        return;
      }
      updateImageAttrsAtPos(selectedImage.pos, { align });
    },
    [selectedImage, updateImageAttrsAtPos],
  );

  const setSelectedImageWidth = useCallback(
    (widthPx: number) => {
      if (!selectedImage) return;
      const aspectRatio = selectedImage.attrs.widthPx / Math.max(1, selectedImage.attrs.heightPx);
      const nextWidth = clampNumber(widthPx, MIN_IMAGE_WIDTH_PX, contentFrameWidth);
      const nextHeight = Math.max(MIN_IMAGE_HEIGHT_PX, Math.round(nextWidth / Math.max(0.1, aspectRatio)));
      const maxOffsetX = Math.max(0, selectedImage.frame.width - nextWidth);
      const maxOffsetY = Math.max(
        0,
        selectedImage.frame.top + selectedImage.frame.height - nextHeight - selectedImage.anchorTop,
      );
      updateImageAttrsAtPos(selectedImage.pos, {
        widthPx: nextWidth,
        heightPx: nextHeight,
        offsetXPx: Math.round(clampNumber(selectedImage.attrs.offsetXPx, 0, maxOffsetX)),
        offsetYPx: Math.round(clampNumber(selectedImage.attrs.offsetYPx, 0, maxOffsetY)),
      });
    },
    [contentFrameWidth, selectedImage, updateImageAttrsAtPos],
  );

  const triggerReplaceImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onReplaceImage = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file || !selectedImage) return;
      const dataUrl = await readFileAsDataUrl(file);
      const measured = await measureImage(dataUrl);
      const aspectRatio = measured.width / Math.max(1, measured.height);
      const nextWidth = clampNumber(measured.width, MIN_IMAGE_WIDTH_PX, contentFrameWidth);
      const nextHeight = Math.max(MIN_IMAGE_HEIGHT_PX, Math.round(nextWidth / Math.max(0.1, aspectRatio)));
      const maxOffsetX = Math.max(0, selectedImage.frame.width - nextWidth);
      const maxOffsetY = Math.max(
        0,
        selectedImage.frame.top + selectedImage.frame.height - nextHeight - selectedImage.anchorTop,
      );
      updateImageAttrsAtPos(selectedImage.pos, {
        src: dataUrl,
        alt: file.name,
        widthPx: nextWidth,
        heightPx: nextHeight,
        offsetXPx: Math.round(clampNumber(selectedImage.attrs.offsetXPx, 0, maxOffsetX)),
        offsetYPx: Math.round(clampNumber(selectedImage.attrs.offsetYPx, 0, maxOffsetY)),
      });
      event.target.value = "";
    },
    [contentFrameWidth, selectedImage, updateImageAttrsAtPos],
  );

  const startImageMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedImage) return;
      const startPoint = pointerToViewportContentPoint(
        event.clientX,
        event.clientY,
        viewportWrapRef.current,
      );
      const nextSession = {
        pos: selectedImage.pos,
        clientX: event.clientX,
        clientY: event.clientY,
        pointerOffsetX: startPoint.x - selectedImage.rect.left,
        pointerOffsetY: startPoint.y - selectedImage.rect.top,
        imageWidth: selectedImage.rect.width,
        imageHeight: selectedImage.rect.height,
        previewLeft: selectedImage.rect.left,
        previewTop: selectedImage.rect.top,
      };
      moveSessionRef.current = nextSession;
      setMoveSession(nextSession);
    },
    [selectedImage],
  );

  const startImageResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedImage) return;
      setResizeSession({
        pos: selectedImage.pos,
        startX: event.clientX,
        startWidth: selectedImage.attrs.widthPx,
        aspectRatio: selectedImage.attrs.widthPx / Math.max(1, selectedImage.attrs.heightPx),
        maxWidth: contentFrameWidth,
      });
    },
    [contentFrameWidth, selectedImage],
  );

  const pageBreak = useCallback(() => {
    run((s, d) => runtime.commands.insertPageBreak(s, d));
  }, [run, runtime.commands]);

  return (
    <div className="word-shell">
      <Toolbar.Root className="word-toolbar">
        <Toolbar.Group className="word-toolbar-group">
          <Toolbar.Button className="word-toolbar-icon-btn" type="button" onClick={toggleBold} aria-label="Bold">
            <LuBold />
          </Toolbar.Button>
          <Toolbar.Button className="word-toolbar-icon-btn" type="button" onClick={toggleItalic} aria-label="Italic">
            <LuItalic />
          </Toolbar.Button>
          <Toolbar.Button className="word-toolbar-icon-btn" type="button" onClick={toggleCode} aria-label="Code">
            <LuCode />
          </Toolbar.Button>
          <Toolbar.Button className="word-toolbar-icon-btn" type="button" onClick={insertImage} aria-label="Insert image">
            <LuImage />
          </Toolbar.Button>
          <Toolbar.Separator className="word-toolbar-sep" />
          <Toolbar.Button className="word-toolbar-icon-btn" type="button" onClick={pageBreak} aria-label="Page break">
            <LuSeparatorHorizontal />
          </Toolbar.Button>
        </Toolbar.Group>
        <Toolbar.Group className="word-toolbar-group word-toolbar-debug">
          <a
            className="word-toolbar-link-btn"
            href="https://github.com/samwillis/premirror"
            target="_blank"
            rel="noopener noreferrer"
          >
            <LuGithub />
            premirror
          </a>
          <Toolbar.Separator className="word-toolbar-sep" />
          <span className="word-toolbar-label">Facing</span>
          <Switch.Root
            className="word-debug-switch"
            checked={pageLayoutMode === "spread"}
            onCheckedChange={(checked) => {
              setPageLayoutMode(checked ? "spread" : "single");
            }}
          >
            <Switch.Thumb className="word-debug-thumb" />
          </Switch.Root>
          <Toolbar.Separator className="word-toolbar-sep" />
          <span className="word-toolbar-label">Debug</span>
          <Switch.Root
            className="word-debug-switch"
            checked={showDebug}
            onCheckedChange={(checked) => {
              setShowDebug(checked);
            }}
          >
            <Switch.Thumb className="word-debug-thumb" />
          </Switch.Root>
        </Toolbar.Group>
      </Toolbar.Root>

      <div className="doc-title-row">
        <div className="doc-title">Untitled document</div>
        <div className="doc-meta">
          pages {layout.pages.length} · compose {diagnostics.timings.composeMs.toFixed(1)}ms · measure{" "}
          {diagnostics.timings.measurementMs.toFixed(1)}ms
        </div>
      </div>

      <div ref={viewportWrapRef} className="paged-viewport-wrap">
        <div className="paged-viewport-inner">
          <div className="premirror-stack">
            <PremirrorPageViewport
              layout={layout}
              showDebug={showDebug}
              pageLayoutMode={pageLayoutMode}
              editorLayer={
                <ProseMirror
                  state={editorState}
                  dispatchTransaction={dispatch}
                  decorations={() => fragmentDecorations}
                >
                  <ProseMirrorDoc />
                </ProseMirror>
              }
            />
            {selectedImage ? (
              <>
                <div
                  aria-label="Move image"
                  className={`image-drag-surface ${moveSession ? "is-dragging" : ""}`}
                  style={{
                    left: selectedImage.rect.left,
                    top: selectedImage.rect.top,
                    width: selectedImage.rect.width,
                    height: selectedImage.rect.height,
                  }}
                  onPointerDown={startImageMove}
                />
                {moveSession ? (
                  <div
                    aria-hidden
                    className="image-drag-preview"
                    style={{
                      left: moveSession.previewLeft,
                      top: moveSession.previewTop,
                      width: moveSession.imageWidth,
                      height: moveSession.imageHeight,
                    }}
                  />
                ) : null}
                <div
                  className="image-toolbar"
                  style={{
                    left: selectedImage.rect.left,
                    top: Math.max(0, selectedImage.rect.top - 48),
                  }}
                >
                  <div className="image-toolbar-group">
                    <button
                      type="button"
                      className={`image-toolbar-btn ${selectedImage.attrs.placement === "block" ? "is-active" : ""}`}
                      onPointerDown={preventToolbarFocus}
                      onClick={() => setSelectedImagePlacement("block")}
                    >
                      In flow
                    </button>
                    <button
                      type="button"
                      className={`image-toolbar-btn ${selectedImage.attrs.placement === "float" ? "is-active" : ""}`}
                      onPointerDown={preventToolbarFocus}
                      onClick={() => setSelectedImagePlacement("float")}
                    >
                      Float
                    </button>
                  </div>
                  <div className="image-toolbar-group">
                    <button
                      type="button"
                      className={`image-toolbar-btn ${selectedImage.attrs.align === "left" ? "is-active" : ""}`}
                      onPointerDown={preventToolbarFocus}
                      onClick={() => setSelectedImageAlign("left")}
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className={`image-toolbar-btn ${selectedImage.attrs.align === "center" ? "is-active" : ""}`}
                      onPointerDown={preventToolbarFocus}
                      onClick={() => setSelectedImageAlign("center")}
                    >
                      Mid
                    </button>
                    <button
                      type="button"
                      className={`image-toolbar-btn ${selectedImage.attrs.align === "right" ? "is-active" : ""}`}
                      onPointerDown={preventToolbarFocus}
                      onClick={() => setSelectedImageAlign("right")}
                    >
                      Right
                    </button>
                  </div>
                  <div className="image-toolbar-group">
                    {IMAGE_WIDTH_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`image-toolbar-btn ${Math.abs(selectedImage.attrs.widthPx - preset) < 8 ? "is-active" : ""}`}
                        onPointerDown={preventToolbarFocus}
                        onClick={() => setSelectedImageWidth(preset)}
                      >
                        {preset}px
                      </button>
                    ))}
                  </div>
                  <div className="image-toolbar-group">
                    <button
                      type="button"
                      className="image-toolbar-btn"
                      onPointerDown={preventToolbarFocus}
                      onClick={triggerReplaceImage}
                    >
                      Replace
                    </button>
                    <span className="image-toolbar-meta">
                      {selectedImage.attrs.placement === "float" ? "wrap" : "block"} · {Math.round(selectedImage.attrs.widthPx)}×{Math.round(selectedImage.attrs.heightPx)}
                    </span>
                  </div>
                </div>
                {!moveSession ? (
                  <button
                    type="button"
                    aria-label="Resize image"
                    className="image-resize-handle"
                    style={{
                      left: selectedImage.rect.left + selectedImage.rect.width - 8,
                      top: selectedImage.rect.top + selectedImage.rect.height - 8,
                    }}
                    onPointerDown={startImageResize}
                  />
                ) : null}
                <input
                  ref={fileInputRef}
                  className="image-file-input"
                  type="file"
                  accept="image/*"
                  onChange={onReplaceImage}
                />
              </>
            ) : null}
            {showDebug ? (
              <div className="selection-overlay" aria-hidden>
                {projection.rects.map((r, i) => (
                  <div
                    key={i}
                    className="selection-rect"
                    style={{
                      left: r.x,
                      top: r.y,
                      width: r.width,
                      height: r.height,
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
