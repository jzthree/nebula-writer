import Image from "@tiptap/extension-image";

function imageDimension(element: HTMLElement, name: "width" | "height"): number | null {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Keep Word display dimensions through TipTap and the shared document. The
// rebuilt exporter applies page bounds when converting these values to OOXML.
export default Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (element) => imageDimension(element, "width") },
      height: { default: null, parseHTML: (element) => imageDimension(element, "height") }
    };
  }
});
