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
          align: "center",
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
};

type ResizeSession = {
  pos: number;
  startX: number;
  startWidth: number;
  aspectRatio: number;
  maxWidth: number;
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
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readImageAttrs(node: ProseMirrorNode): DemoImageAttrs {
  return {
    src: String(node.attrs.src ?? ""),
    alt: String(node.attrs.alt ?? ""),
    widthPx: Number(node.attrs.widthPx ?? 480),
    heightPx: Number(node.attrs.heightPx ?? 270),
    align: (node.attrs.align === "left" || node.attrs.align === "right" ? node.attrs.align : "center") as ImageAlignment,
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

function buildFragmentDecorations(
  doc: ProseMirrorNode,
  layout: LayoutOutput,
  pageLayoutMode: PageLayoutMode,
): DecorationSet {
  const decorations: Decoration[] = [];
  const paragraphBoxes = new Map<string, ParagraphBox>();
  const imageBoxes: ImageBox[] = [];
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
        if (fragment.kind === "image") {
          const bounds = fragment.bounds;
          if (!bounds) continue;
          imageBoxes.push({
            from: fragment.pmRange.from,
            to: fragment.pmRange.to,
            left: pagePlacement.left + frame.bounds.x + bounds.x,
            top: pagePlacement.top + frame.bounds.y + bounds.y,
            width: bounds.width,
            height: bounds.height,
          });
          continue;
        }
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
    decorations.push(
      Decoration.node(image.from, image.to, {
        class: "premirror-image-block",
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
  projection: ReturnType<typeof useProjectedSelection>,
): SelectedImageInfo | null {
  const selection = editorState.selection;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== "image") {
    return null;
  }
  const rect = projection.rects[0];
  if (!rect) return null;
  return {
    pos: selection.from,
    attrs: readImageAttrs(selection.node),
    rect: {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    },
  };
}

export function App() {
  const options = useMemo(() => {
    const defaults = defaultPremirrorOptions();
    return {
      ...defaults,
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
  const [resizeSession, setResizeSession] = useState<ResizeSession | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const { layout, diagnostics } = usePremirrorEngine({
    editorState,
    runtime,
    layoutInput,
  });

  const contentFrameWidth = layoutInput.page.widthPx - layoutInput.margins.leftPx - layoutInput.margins.rightPx;

  const projection = useProjectedSelection(editorState, layout, pageLayoutMode);
  const fragmentDecorations = useMemo(
    () => buildFragmentDecorations(editorState.doc, layout, pageLayoutMode),
    [editorState.doc, layout, pageLayoutMode],
  );
  const selectedImage = useMemo(
    () => getSelectedImageInfo(editorState, projection),
    [editorState, projection],
  );

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

  const setSelectedImageAlign = useCallback(
    (align: ImageAlignment) => {
      if (!selectedImage) return;
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
      updateImageAttrsAtPos(selectedImage.pos, {
        widthPx: nextWidth,
        heightPx: nextHeight,
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
      updateImageAttrsAtPos(selectedImage.pos, {
        src: dataUrl,
        alt: file.name,
        widthPx: nextWidth,
        heightPx: nextHeight,
      });
      event.target.value = "";
    },
    [contentFrameWidth, selectedImage, updateImageAttrsAtPos],
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

      <div className="paged-viewport-wrap">
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
                  className="image-toolbar"
                  style={{
                    left: selectedImage.rect.left,
                    top: Math.max(0, selectedImage.rect.top - 48),
                  }}
                >
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
                      Center
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
                      {Math.round(selectedImage.attrs.widthPx)}×{Math.round(selectedImage.attrs.heightPx)}
                    </span>
                  </div>
                </div>
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
