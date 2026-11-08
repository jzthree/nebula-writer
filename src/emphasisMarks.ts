/**
 * The web editor's marks and Writer's formatting model, both ways: bold,
 * italic, underline, strike, superscript, subscript, highlight (with its
 * colour) and text colour (the textStyle mark's colour attribute).
 */

import type { Mark, Schema } from "@tiptap/pm/model";
import { DEFAULT_HIGHLIGHT_COLOR, formatOf, normalizeColor, type EmphasisFormat } from "./emphasis";

/** The formatting a text node's marks declare (colours from the highlight and textStyle marks' attributes). */
export function marksEmphasis(marks: ReadonlyArray<{ type: { name: string }; attrs?: Record<string, unknown> }>): EmphasisFormat {
  const format: EmphasisFormat = {};
  for (const mark of marks) {
    switch (mark.type.name) {
      case "bold":
      case "strong":
        format.bold = true;
        break;
      case "italic":
      case "em":
        format.italic = true;
        break;
      case "underline":
        format.underline = true;
        break;
      case "strike":
        format.strike = true;
        break;
      case "superscript":
        format.superscript = true;
        break;
      case "subscript":
        format.subscript = true;
        break;
      case "highlight": {
        format.highlight = true;
        const color = normalizeColor(mark.attrs?.color);
        if (color) {
          format.highlightColor = color;
        }
        break;
      }
      case "textStyle": {
        const color = normalizeColor(mark.attrs?.color);
        if (color && color !== "#000000") {
          format.color = color;
        }
        break;
      }
      default:
        break;
    }
  }
  return formatOf(format);
}

/** The marks that give text this formatting, in a ProseMirror schema (kinds the schema lacks are skipped). */
export function emphasisMarks(schema: Schema, format: EmphasisFormat): Mark[] {
  const clean = formatOf(format);
  const marks: Mark[] = [];
  const add = (name: string, on: boolean | undefined, attrs?: Record<string, unknown>) => {
    const type = schema.marks[name];
    if (on && type) {
      marks.push(type.create(attrs));
    }
  };
  add("bold", clean.bold);
  add("italic", clean.italic);
  add("underline", clean.underline);
  add("strike", clean.strike);
  add("superscript", clean.superscript);
  add("subscript", clean.subscript);
  add("highlight", clean.highlight, { color: clean.highlightColor ?? DEFAULT_HIGHLIGHT_COLOR });
  add("textStyle", Boolean(clean.color), { color: clean.color });
  return marks;
}

