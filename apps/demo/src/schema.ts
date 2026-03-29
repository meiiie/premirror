import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

const paragraphSpec = basicSchema.spec.nodes.get("paragraph")!;
const imageSpec = basicSchema.spec.nodes.get("image");

if (!imageSpec) {
  throw new Error("Missing image spec");
}

/** CommonMark-ish schema with list nodes and Premirror pagination attrs on paragraphs. */
export const demoSchema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes
      .update("paragraph", {
        ...paragraphSpec,
        attrs: {
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
        parseDOM: [
          {
            tag: "img[data-premirror-image-block]",
            getAttrs(dom: string | HTMLElement) {
              if (!(dom instanceof HTMLElement)) return false;
              return {
                src: dom.getAttribute("src") ?? "",
                alt: dom.getAttribute("alt") ?? "",
                widthPx: Number.parseFloat(dom.getAttribute("data-width-px") ?? dom.getAttribute("width") ?? "480"),
                heightPx: Number.parseFloat(dom.getAttribute("data-height-px") ?? dom.getAttribute("height") ?? "270"),
                align: dom.getAttribute("data-align") ?? "center",
              };
            },
          },
        ],
        toDOM(node) {
          return [
            "img",
            {
              src: node.attrs.src,
              alt: node.attrs.alt,
              width: node.attrs.widthPx,
              height: node.attrs.heightPx,
              "data-premirror-image-block": "true",
              "data-width-px": node.attrs.widthPx,
              "data-height-px": node.attrs.heightPx,
              "data-align": node.attrs.align,
            },
          ];
        },
      }),
    "paragraph block*",
    "block",
  ),
  marks: basicSchema.spec.marks,
});
