import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import mammoth from "mammoth";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { imageMimeForName, sniffImageMime } from "./image-files";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { AiSuggestion, DocxBodySafeAnchor, DocxFeatureSummary, ExportRequest, ImportedDocument, SourceTrackedChangePreview } from "../src/shared";
import { chooseAnchoredCandidate } from "../src/shared";
import { carryEmphasis, emphasisFromPieces, splitByEmphasis, type EmphasisFormat, type EmphasisSpan } from "../src/emphasis";

const WORD_STORY_PART_PATTERN = /^word\/(?:document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/i;
const BROWSER_IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/svg+xml",
  "image/webp"
]);
const EMF_IMAGE_CONTENT_TYPES = new Set(["image/emf", "image/x-emf"]);
const emfPreviewTimeoutMs = 5000;
const execFile = promisify(execFileCallback);
let defaultEmfConverterUnavailable = false;

type DocxImageAttributes = {
  src: string;
  alt?: string;
  title?: string;
};

type MammothImage = {
  contentType: string;
  readAsBase64String(): Promise<string>;
  readAsBuffer(): Promise<Buffer>;
};

const convertDocxImage = mammoth.images.imgElement(async (image: MammothImage): Promise<DocxImageAttributes> => {
  const contentType = image.contentType.toLowerCase();
  if (BROWSER_IMAGE_CONTENT_TYPES.has(contentType)) {
    return {
      src: `data:${image.contentType};base64,${await image.readAsBase64String()}`
    };
  }
  if (EMF_IMAGE_CONTENT_TYPES.has(contentType)) {
    const preview = await convertEmfImageToSvgDataUri(image);
    if (preview) {
      return {
        src: preview.dataUri,
        alt: "DOCX image preview generated: EMF preserved in source DOCX",
        title: `EMF preview generated with ${preview.converterName}; original EMF preserved in source DOCX`
      };
    }
  }

  const displayFormat = displayImageFormat(contentType);
  return {
    src: unsupportedImagePlaceholder(contentType),
    alt: `DOCX image preview unavailable: ${displayFormat} preserved in source DOCX`,
    title: `${displayFormat} preview unavailable; preserved in source DOCX`
  };
});

async function convertEmfImageToSvgDataUri(image: MammothImage): Promise<{ converterName: string; dataUri: string } | null> {
  const configuredConverter = process.env.WRITER_EMF_CONVERTER?.trim();
  const converter = configuredConverter || (defaultEmfConverterUnavailable ? "" : "emf2svg-conv");
  if (!converter) {
    return null;
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "nebula-writer-emf-"));
  const inputPath = join(tempDirectory, "image.emf");
  const outputPath = join(tempDirectory, "image.svg");
  try {
    await writeFile(inputPath, await image.readAsBuffer());
    await execFile(converter, ["-i", inputPath, "-o", outputPath], {
      maxBuffer: 1024 * 1024,
      timeout: emfPreviewTimeoutMs
    });
    const svg = sanitizeConvertedSvgPreview(await readFile(outputPath, "utf8"));
    if (!svg) {
      return null;
    }
    return {
      converterName: basename(converter),
      dataUri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
    };
  } catch (error) {
    if (!configuredConverter && isMissingExecutableError(error)) {
      defaultEmfConverterUnavailable = true;
    }
    return null;
  } finally {
    await rm(tempDirectory, { force: true, recursive: true });
  }
}

function sanitizeConvertedSvgPreview(svg: string): string | null {
  const trimmed = svg.trim();
  if (!/<svg(?:\s|>)/i.test(trimmed) || !/<\/svg>/i.test(trimmed)) {
    return null;
  }
  return trimmed
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
}

function isMissingExecutableError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

export async function importDocx(buffer: Buffer, name: string): Promise<ImportedDocument> {
  const displayBuffer = await acceptedTrackedChangesForDisplay(buffer);
  const conversion = await convertDisplayDocxToHtml(displayBuffer, buffer);
  const [features, textBoxParagraphs, bodySafeAnchorDetails, sourceTrackedChanges] = await Promise.all([
    analyzeDocxFeatures(buffer),
    extractTextBoxParagraphs(conversion.buffer),
    extractDocxBodySafeAnchorDetails(buffer),
    extractSourceTrackedChangePreview(buffer)
  ]);
  const html = annotateTextBoxParagraphs(annotateOfficeMathPreviews(conversion.result.value || "<p></p>", conversion.officeMathPreviews), textBoxParagraphs);
  const plainText = htmlToText(html);
  const bodySafeAnchors = bodySafeAnchorDetails.map((anchor) => anchor.text);

  return {
    bodySafeAnchors,
    bodySafeAnchorDetails,
    id: randomUUID(),
    name,
    html,
    plainText,
    messages: [
      ...(features.trackedChanges > 0
        ? [`info: Tracked changes are shown as accepted in the editor; ${sourceTrackedChanges.length ? `${sourceTrackedChanges.length} source revision preview${sourceTrackedChanges.length === 1 ? "" : "s"} available; ` : ""}original revision markup is preserved for source-based DOCX export.`]
        : []),
      ...fidelityImportWarnings(features),
      ...conversion.messages,
      ...conversion.result.messages.map((message) => `${message.type}: ${message.message}`)
    ],
    features,
    sourceTrackedChanges
  };
}

// Tell the user up front what the browser view and rebuilt (non-source) export
// will lose, instead of letting them discover it after exporting back to Word.
function fidelityImportWarnings(features: DocxFeatureSummary): string[] {
  const warnings: string[] = [];
  const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  if (features.tables > 0) {
    warnings.push(`warning: ${count(features.tables, "table")} imported. Table text is editable, but borders, shading, and merged-cell layout are kept only by source-based review export — a rebuilt export from the editor produces plain tables.`);
  }
  if (features.images > 0) {
    warnings.push(`info: ${count(features.images, "image")} imported. Unsupported formats (EMF/TIFF) appear as previews or placeholders in the editor; the original media stays intact in source-based review export.`);
  }
  if (features.formulas > 0) {
    warnings.push(`info: ${count(features.formulas, "equation")} shown as protected previews. Avoid editing equation preview text; the original math XML is preserved for source-based review export.`);
  }
  if (features.commentRanges > 0) {
    warnings.push(`warning: ${count(features.commentRanges, "Word comment marker")} in the source are not shown in this editor. Review them in Word; they remain in the source DOCX.`);
  }
  if (features.notes > 0) {
    warnings.push(`warning: ${count(features.notes, "footnote/endnote reference")} are not editable here and survive only through source-based review export.`);
  }
  if (features.textBoxes > 0) {
    warnings.push(`warning: ${count(features.textBoxes, "text box/shape")} detected. Text inside boxes and shapes is not editable in this editor and survives only through source-based review export.`);
  }
  if ((features.headerFooterParts ?? 0) > 0) {
    warnings.push(`warning: This document has header/footer content, which is not shown or editable here. It is preserved by source-based review export but lost in a rebuilt export.`);
  }
  const structural = features.bookmarks + features.fields + features.contentControls + features.customXml;
  if (structural > 0) {
    warnings.push(`info: ${structural} bookmark/field/content-control structure${structural === 1 ? "" : "s"} (including citation fields) are preserved only by source-based review export, not by a rebuilt export from the editor.`);
  }
  return warnings;
}

async function convertDisplayDocxToHtml(displayBuffer: Buffer, sourceBuffer: Buffer) {
  const displayWithMathPreviews = await docxWithOfficeMathPreviews(displayBuffer);
  try {
    return {
      buffer: displayWithMathPreviews.buffer,
      messages: [] as string[],
      officeMathPreviews: displayWithMathPreviews.previews,
      result: await mammoth.convertToHtml({ buffer: displayWithMathPreviews.buffer }, mammothImportOptions())
    };
  } catch (error) {
    if (displayBuffer !== sourceBuffer && isXmlDomWarningError(error)) {
      const sourceWithMathPreviews = await docxWithOfficeMathPreviews(sourceBuffer);
      return {
        buffer: sourceWithMathPreviews.buffer,
        messages: ["warning: Existing tracked changes use complex nested Word revision markup; Nebula is showing Word's raw visible text for this import while preserving source markup for export."],
        officeMathPreviews: sourceWithMathPreviews.previews,
        result: await mammoth.convertToHtml({ buffer: sourceWithMathPreviews.buffer }, mammothImportOptions())
      };
    }
    throw error;
  }
}

interface OfficeMathPreview {
  mathml?: string;
  renderedSvg?: string;
  text: string;
  token: string;
}

interface OmmlNode {
  attrs: Record<string, string>;
  children: Array<OmmlNode | string>;
  name: string;
}

interface MathJaxApi {
  mathml2svgPromise(mathml: string, options: { display?: boolean }): Promise<unknown>;
  startup: {
    adaptor: {
      serializeXML(node: unknown): string;
    };
  };
}

interface MathJaxModule {
  default: {
    init(config: unknown): Promise<MathJaxApi>;
  };
}

let mathJaxPromise: Promise<MathJaxApi> | null = null;

async function docxWithOfficeMathPreviews(buffer: Buffer): Promise<{ buffer: Buffer; previews: OfficeMathPreview[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXmlFile = zip.file("word/document.xml");
  const documentXml = await documentXmlFile?.async("string");
  if (!documentXml) {
    return { buffer, previews: [] };
  }

  const previews: OfficeMathPreview[] = [];
  let patchedXml = "";
  let cursor = 0;
  const mathPattern = /<m:oMathPara\b[\s\S]*?<\/m:oMathPara>|<m:oMath\b[\s\S]*?<\/m:oMath>/g;
  for (const match of documentXml.matchAll(mathPattern)) {
    const mathXml = match[0];
    const index = match.index ?? 0;
    patchedXml += documentXml.slice(cursor, index);
    cursor = index + mathXml.length;
    const preview = await officeMathPreview(mathXml);
    if (!preview) {
      patchedXml += mathXml;
      continue;
    }
    const token = `NEBULA_DOCX_EQUATION_${previews.length}_END`;
    previews.push({ ...preview, token });
    patchedXml += textRunXml(token);
  }
  patchedXml += documentXml.slice(cursor);

  if (!previews.length || patchedXml === documentXml) {
    return { buffer, previews };
  }

  zip.file("word/document.xml", patchedXml);
  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    previews
  };
}

async function officeMathPreview(mathXml: string): Promise<Omit<OfficeMathPreview, "token"> | null> {
  const text = officeMathPreviewText(mathXml);
  if (!text) {
    return null;
  }
  const mathml = officeMathToMathMl(mathXml, mathXml.startsWith("<m:oMathPara"));
  const renderedSvg = mathml ? await renderMathMlSvg(mathml) : null;
  return {
    ...(mathml ? { mathml } : {}),
    ...(renderedSvg ? { renderedSvg } : {}),
    text
  };
}

function officeMathPreviewText(mathXml: string): string {
  const pieces = [...mathXml.matchAll(/<m:t\b[^>]*>([\s\S]*?)<\/m:t>|<m:chr\b[^>]*\bm:val="([^"]*)"[^>]*\/?>/g)]
    .map((match) => decodeEntities(stripTags(match[1] ?? match[2] ?? "")))
    .join("");
  return pieces.replace(/\s+/g, " ").trim();
}

function officeMathToMathMl(mathXml: string, display: boolean): string | null {
  const root = parseOmmlXml(mathXml);
  if (!root) {
    return null;
  }
  const body = ommlNodeToMathMl(root);
  if (!body) {
    return null;
  }
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? " display=\"block\"" : ""}><mrow>${body}</mrow></math>`;
}

async function renderMathMlSvg(mathml: string): Promise<string | null> {
  try {
    const mathJax = await mathJaxRuntime();
    const svg = await mathJax.mathml2svgPromise(mathml, { display: mathml.includes("display=\"block\"") });
    return mathJax.startup.adaptor.serializeXML(svg);
  } catch {
    return null;
  }
}

function mathJaxRuntime(): Promise<MathJaxApi> {
  mathJaxPromise ??= importMathJaxForServer().then((MathJax) => MathJax.init({ loader: { load: ["input/mml", "output/svg"] } }));
  return mathJaxPromise;
}

async function importMathJaxForServer(): Promise<MathJaxModule["default"]> {
  const hiddenGlobals = hideBrowserGlobalsForMathJax();
  try {
    return ((await import("mathjax")) as MathJaxModule).default;
  } finally {
    restoreBrowserGlobalsForMathJax(hiddenGlobals);
  }
}

type BrowserGlobalSnapshot = Array<[string, PropertyDescriptor | undefined]>;

function hideBrowserGlobalsForMathJax(): BrowserGlobalSnapshot {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  const keys = ["window", "document", "DOMParser", "XMLSerializer", "Node", "HTMLElement"];
  return keys.map((key): [string, PropertyDescriptor | undefined] => {
    const descriptor = Object.getOwnPropertyDescriptor(globalObject, key);
    try {
      delete globalObject[key];
    } catch {
      // Some runtimes expose non-configurable browser globals. In that case
      // MathJax will keep its existing behavior rather than failing import.
    }
    return [key, descriptor];
  });
}

function restoreBrowserGlobalsForMathJax(snapshot: BrowserGlobalSnapshot): void {
  const globalObject = globalThis as unknown as Record<string, unknown>;
  for (const [key, descriptor] of snapshot) {
    if (descriptor) {
      Object.defineProperty(globalObject, key, descriptor);
    }
  }
}

function parseOmmlXml(xml: string): OmmlNode | null {
  const root: OmmlNode = { attrs: {}, children: [], name: "root" };
  const stack = [root];
  const tokenPattern = /<([^>]+)>|([^<]+)/g;

  for (const token of xml.matchAll(tokenPattern)) {
    if (token[2]) {
      stack[stack.length - 1].children.push(decodeEntities(token[2]));
      continue;
    }
    const rawTag = token[1]?.trim();
    if (!rawTag || rawTag.startsWith("?") || rawTag.startsWith("!")) {
      continue;
    }
    if (rawTag.startsWith("/")) {
      const closingName = rawTag.slice(1).trim();
      while (stack.length > 1) {
        const candidate = stack.pop();
        if (candidate?.name === closingName) {
          break;
        }
      }
      continue;
    }

    const selfClosing = rawTag.endsWith("/");
    const match = rawTag.match(/^([^\s/]+)([\s\S]*?)(?:\/)?$/);
    if (!match) {
      continue;
    }
    const node: OmmlNode = {
      attrs: parseXmlAttributes(match[2] ?? ""),
      children: [],
      name: match[1]
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root.children.find((child): child is OmmlNode => typeof child !== "string" && (localXmlName(child.name) === "oMath" || localXmlName(child.name) === "oMathPara")) ?? null;
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z0-9:_-]+)="([^"]*)"/g)) {
    attrs[match[1]] = decodeEntities(match[2]);
  }
  return attrs;
}

function ommlNodeToMathMl(node: OmmlNode | string | null | undefined): string {
  if (!node || typeof node === "string") {
    return "";
  }
  switch (localXmlName(node.name)) {
    case "oMath":
    case "oMathPara":
    case "e":
    case "num":
    case "den":
    case "sub":
    case "sup":
      return ommlChildrenToMathMl(node.children);
    case "r":
      return runTextToMathMl(ommlRunText(node), ommlRunIsNormalText(node));
    case "t":
      return runTextToMathMl(ommlTextContent(node), false);
    case "sSub":
      return ommlScriptToMathMl("msub", node, ["e", "sub"]);
    case "sSup":
      return ommlScriptToMathMl("msup", node, ["e", "sup"]);
    case "sSubSup":
      return ommlScriptToMathMl("msubsup", node, ["e", "sub", "sup"]);
    case "f":
      return ommlFractionToMathMl(node);
    case "d":
      return ommlDelimiterToMathMl(node);
    case "m":
      return ommlMatrixToMathMl(node);
    case "mr":
      return `<mtr>${directOmmlChildren(node, "e").map((child) => `<mtd>${wrapMathRow(ommlNodeToMathMl(child))}</mtd>`).join("")}</mtr>`;
    case "rad":
      return ommlRadicalToMathMl(node);
    default:
      return ommlChildrenToMathMl(node.children);
  }
}

function ommlChildrenToMathMl(children: Array<OmmlNode | string>): string {
  return children.map(ommlNodeToMathMl).join("");
}

function ommlScriptToMathMl(tag: "msub" | "msup" | "msubsup", node: OmmlNode, childNames: string[]): string {
  const pieces = childNames.map((name) => wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, name))));
  return pieces.every(Boolean) ? `<${tag}>${pieces.join("")}</${tag}>` : ommlChildrenToMathMl(node.children);
}

function ommlFractionToMathMl(node: OmmlNode): string {
  const numerator = wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, "num")));
  const denominator = wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, "den")));
  return numerator && denominator ? `<mfrac>${numerator}${denominator}</mfrac>` : ommlChildrenToMathMl(node.children);
}

function ommlDelimiterToMathMl(node: OmmlNode): string {
  const properties = directOmmlChild(node, "dPr");
  const begin = directOmmlChild(properties, "begChr")?.attrs["m:val"] ?? directOmmlChild(properties, "begChr")?.attrs.val ?? "(";
  const end = directOmmlChild(properties, "endChr")?.attrs["m:val"] ?? directOmmlChild(properties, "endChr")?.attrs.val ?? ")";
  const body = wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, "e")));
  if (!body) {
    return "";
  }
  return `<mrow><mo>${escapeXml(begin)}</mo>${body}<mo>${escapeXml(end)}</mo></mrow>`;
}

function ommlMatrixToMathMl(node: OmmlNode): string {
  const rows = directOmmlChildren(node, "mr").map(ommlNodeToMathMl).join("");
  return rows ? `<mtable>${rows}</mtable>` : ommlChildrenToMathMl(node.children);
}

function ommlRadicalToMathMl(node: OmmlNode): string {
  const body = wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, "e")));
  const degree = wrapMathRow(ommlNodeToMathMl(directOmmlChild(node, "deg")));
  if (!body) {
    return "";
  }
  return degree ? `<mroot>${body}${degree}</mroot>` : `<msqrt>${body}</msqrt>`;
}

function directOmmlChild(node: OmmlNode | null | undefined, name: string): OmmlNode | null {
  return directOmmlChildren(node, name)[0] ?? null;
}

function directOmmlChildren(node: OmmlNode | null | undefined, name: string): OmmlNode[] {
  if (!node) {
    return [];
  }
  return node.children.filter((child): child is OmmlNode => typeof child !== "string" && localXmlName(child.name) === name);
}

function ommlRunText(node: OmmlNode): string {
  return descendantOmmlChildren(node, "t").map(ommlTextContent).join("");
}

function ommlTextContent(node: OmmlNode): string {
  return node.children.map((child) => typeof child === "string" ? child : ommlTextContent(child)).join("");
}

function descendantOmmlChildren(node: OmmlNode, name: string): OmmlNode[] {
  const matches: OmmlNode[] = [];
  for (const child of node.children) {
    if (typeof child === "string") {
      continue;
    }
    if (localXmlName(child.name) === name) {
      matches.push(child);
    }
    matches.push(...descendantOmmlChildren(child, name));
  }
  return matches;
}

function ommlRunIsNormalText(node: OmmlNode): boolean {
  return descendantOmmlChildren(node, "nor").length > 0;
}

function runTextToMathMl(text: string, forceText: boolean): string {
  if (!text) {
    return "";
  }
  if (forceText) {
    return `<mtext>${escapeXml(text)}</mtext>`;
  }
  const chars = Array.from(text);
  const tokens: string[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (/\s/u.test(char)) {
      tokens.push("<mspace width=\"0.33em\"/>");
      index += 1;
      continue;
    }
    if (/[0-9.]/u.test(char)) {
      let value = char;
      index += 1;
      while (index < chars.length && /[0-9.]/u.test(chars[index])) {
        value += chars[index];
        index += 1;
      }
      tokens.push(`<mn>${escapeXml(value)}</mn>`);
      continue;
    }
    if (isMathIdentifierCharacter(char)) {
      let value = char;
      index += 1;
      while (index < chars.length && isMathIdentifierCharacter(chars[index])) {
        value += chars[index];
        index += 1;
      }
      const normal = value.length > 1 ? " mathvariant=\"normal\"" : "";
      tokens.push(`<mi${normal}>${escapeXml(value)}</mi>`);
      continue;
    }
    tokens.push(`<mo>${escapeXml(char)}</mo>`);
    index += 1;
  }
  return tokens.join("");
}

function isMathIdentifierCharacter(value: string): boolean {
  return /\p{L}/u.test(value);
}

function wrapMathRow(value: string | null | undefined): string {
  return value ? `<mrow>${value}</mrow>` : "";
}

function localXmlName(name: string): string {
  return name.includes(":") ? name.split(":").pop() ?? name : name;
}

function annotateOfficeMathPreviews(html: string, previews: OfficeMathPreview[]): string {
  return previews.reduce((current, preview) => current.replace(
    new RegExp(escapeRegExp(preview.token), "g"),
    [
      "<span",
      " data-docx-equation=\"true\"",
      ` data-docx-equation-text="${escapeXml(preview.text)}"`,
      preview.mathml ? ` data-docx-mathml="${escapeXml(preview.mathml)}"` : "",
      preview.renderedSvg ? ` data-docx-mathjax-svg="${escapeXml(preview.renderedSvg)}"` : "",
      " role=\"math\"",
      ` aria-label="Word equation preview: ${escapeXml(preview.text)}"`,
      " title=\"Word equation preview; original OMML is preserved in source DOCX\"",
      ">",
      escapeXml(preview.text),
      "</span>"
    ].join("")
  ), html);
}

function mammothImportOptions() {
  return {
    convertImage: convertDocxImage,
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Heading 1'] => h1:fresh",
      "p[style-name='Heading 2'] => h2:fresh",
      "p[style-name='Heading 3'] => h3:fresh",
      "u => u",
      "highlight => mark"
    ]
  };
}

function isXmlDomWarningError(error: unknown): boolean {
  return error instanceof Error && /\[xmldom warning\]/i.test(error.message);
}

export async function extractDocxBodySafeAnchorCandidates(buffer: Buffer, limit = 24): Promise<string[]> {
  return (await extractDocxBodySafeAnchorDetails(buffer, limit)).map((anchor) => anchor.text);
}

export async function extractDocxBodySafeAnchorDetails(buffer: Buffer, limit = 24): Promise<DocxBodySafeAnchor[]> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    return [];
  }

  const candidates: Array<{ index: number; section: string | null; text: string }> = [];
  let inReferenceSection = false;
  let currentSection: string | null = null;
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const paragraphXml = match[0];
    const offset = match.index ?? 0;
    const text = compactAnchorText(paragraphText(paragraphXml));
    const isReferenceHeading = isReferenceSectionHeading(text);
    const sectionHeading = sectionHeadingForParagraph(text, paragraphXml);
    if (sectionHeading) {
      currentSection = sectionHeading;
    }
    if (isReferenceHeading) {
      inReferenceSection = true;
    } else if (inReferenceSection && sectionHeading) {
      inReferenceSection = false;
    }

    if (
      inReferenceSection
      || isInsideProtectedContainer(documentXml, offset)
      || containsRevisionSensitiveXml(paragraphXml)
    ) {
      continue;
    }

    for (const sentence of splitAnchorSentences(text)) {
      const trimmed = sentence.trim();
      if (isBodySafeAnchorCandidate(trimmed) && !candidates.some((candidate) => candidate.text === trimmed)) {
        candidates.push({ index: candidates.length, section: currentSection, text: trimmed });
      }
    }
  }

  if (candidates.length <= limit) {
    return candidates.map(({ section, text }) => ({ section, text }));
  }

  const selected = new Map<number, string>();
  for (let slot = 0; slot < limit; slot += 1) {
    const target = Math.round((slot / Math.max(1, limit - 1)) * (candidates.length - 1));
    const nearest = candidates
      .filter((candidate) => !selected.has(candidate.index))
      .sort((left, right) => Math.abs(left.index - candidates[target].index) - Math.abs(right.index - candidates[target].index))[0];
    if (nearest) {
      selected.set(nearest.index, nearest.text);
    }
  }

  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => candidates.find((candidate) => candidate.text === text))
    .filter((candidate): candidate is { index: number; section: string | null; text: string } => Boolean(candidate))
    .map(({ section, text }) => ({ section, text }));
}

export async function analyzeDocxFeatures(buffer: Buffer): Promise<DocxFeatureSummary> {
  const zip = await JSZip.loadAsync(buffer);
  const storyXml = await readWordStoryXml(zip);
  const formulas = countOfficeMath(storyXml);
  const citationFields = countMatches(storyXml, /ADDIN\s+(?:CSL_CITATION|ZOTERO_ITEM|Mendeley Cite|EN\.CITE|PAPERPILE_CITATION|Paperpile)/gi);
  const fields = countMatches(storyXml, /<(?:w:fldSimple|w:fldChar|w:instrText)\b/gi);
  const contentControls = countMatches(storyXml, /<w:sdt\b/gi);
  const customXml = countMatches(storyXml, /<w:customXml\b/gi);
  const hyperlinks = countMatches(storyXml, /<w:hyperlink\b/gi);
  const bookmarks = countMatches(storyXml, /<w:bookmarkStart\b/gi);
  const commentRanges = countMatches(storyXml, /<(?:w:commentRangeStart|w:commentReference|w:comment)\b/gi);
  const notes = countMatches(storyXml, /<w:(?:footnoteReference|endnoteReference)\b/gi);
  const trackedChanges = countMatches(
    storyXml,
    /<w:(?:ins|del|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|moveFrom|moveTo)\b/gi
  );
  const tables = countMatches(storyXml, /<w:tbl\b/gi);
  const images = countMatches(storyXml, /<(?:w:drawing|w:pict)\b/gi);
  const textBoxes = countTextBoxes(storyXml);
  const bibliographySections = countReferenceSectionHeadings(storyXml);
  let headerFooterParts = 0;
  await Promise.all(Object.keys(zip.files)
    .filter((path) => /^word\/(?:header|footer)\d*\.xml$/.test(path))
    .map(async (path) => {
      const xml = await zip.file(path)?.async("string");
      if (xml && /<w:t\b[^>]*>[^<]/.test(xml)) {
        headerFooterParts += 1;
      }
    }));

  return {
    formulas,
    citationFields,
    fields,
    contentControls,
    customXml,
    hyperlinks,
    bookmarks,
    commentRanges,
    notes,
    trackedChanges,
    tables,
    images,
    textBoxes,
    headerFooterParts,
    bibliographySections,
    preservationRecommended: Boolean(
      formulas ||
      citationFields ||
      fields ||
      contentControls ||
      customXml ||
      hyperlinks ||
      bookmarks ||
      commentRanges ||
      notes ||
      trackedChanges ||
      tables ||
      images ||
      textBoxes ||
      bibliographySections
    )
  };
}

// The limit is a runaway bound, not a working cap: a real reviewed proposal
// carries hundreds of tracked changes (dogfooding hit one with 376), and
// capping at 64 silently dropped every change past the first section.
async function extractSourceTrackedChangePreview(buffer: Buffer, limit = 1000): Promise<SourceTrackedChangePreview[]> {
  const zip = await JSZip.loadAsync(buffer);
  const storyXml = await readWordStoryXml(zip);
  if (!storyXml) {
    return [];
  }

  const previews: SourceTrackedChangePreviewFragment[] = [];
  const patterns: Array<{ kind: SourceTrackedChangePreview["kind"]; pattern: RegExp }> = [
    { kind: "inserted", pattern: /<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/gi },
    { kind: "deleted", pattern: /<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/gi },
    { kind: "movedTo", pattern: /<w:moveTo\b([^>]*)>([\s\S]*?)<\/w:moveTo>/gi },
    { kind: "movedFrom", pattern: /<w:moveFrom\b([^>]*)>([\s\S]*?)<\/w:moveFrom>/gi }
  ];

  for (const { kind, pattern } of patterns) {
    for (const match of storyXml.matchAll(pattern)) {
      const text = trackedChangePreviewText(match[2] ?? "");
      if (!text.trim()) {
        continue;
      }
      const index = match.index ?? previews.length;
      const attrs = match[1] ?? "";
      // Plain text just before this change survives in the accepted document,
      // so it anchors an inline marker (especially for deletions, whose own
      // text is gone from the accepted view).
      const contextBefore = trackedChangePreviewText(storyXml.slice(Math.max(0, index - 600), index), { includeDeleted: false }).slice(-60).trim() || undefined;
      previews.push({
        author: revisionAttribute(attrs, "author"),
        contextBefore,
        date: revisionAttribute(attrs, "date"),
        endIndex: index + match[0].length,
        index,
        kind,
        revisionId: wordAttribute(attrs, "id"),
        text: text.slice(0, 420)
      });
    }
  }

  return mergeSourceTrackedChangePreviewFragments(previews, limit, storyXml);
}

function trackedChangePreviewText(xml: string, options: { includeDeleted?: boolean } = {}): string {
  const includeDeleted = options.includeDeleted ?? true;
  const normalized = xml
    .replace(/<w:tab\b[^>]*\/>/gi, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, "\n")
    // Paragraph boundaries separate with a space so context anchors don't glue
    // the previous heading/paragraph onto the next ("FixtureThe committee").
    .replace(/<\/w:p>/gi, " ");
  // Context anchors must come from the ACCEPTED view (w:t only): deleted runs
  // are absent from the imported document, so an anchor containing them can
  // never be found there.
  const pattern = includeDeleted
    ? /<w:(?:t|delText)\b[^>]*>([\s\S]*?)<\/w:(?:t|delText)>/gi
    : /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
  return [...normalized.matchAll(pattern)]
    .map((match) => decodeEntities(stripTags(match[1] ?? "")))
    .join("")
    .replace(/\s+/g, " ");
}

function revisionAttribute(attrs: string, name: "author" | "date"): string | undefined {
  return wordAttribute(attrs, name);
}

interface SourceTrackedChangePreviewFragment extends SourceTrackedChangePreview {
  endIndex: number;
  index: number;
  revisionId?: string;
}

function wordAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\bw:${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(attrs);
  const value = decodeEntities(match?.[1] ?? match?.[2] ?? "").trim();
  return value || undefined;
}

function mergeSourceTrackedChangePreviewFragments(previews: SourceTrackedChangePreviewFragment[], limit: number, storyXml = ""): SourceTrackedChangePreview[] {
  const merged: SourceTrackedChangePreviewFragment[] = [];
  for (const preview of previews.sort((left, right) => left.index - right.index)) {
    const previous = merged[merged.length - 1];
    // Never merge across a paragraph boundary: a structural suggestion is one
    // w:ins/w:del per paragraph, and gluing them yields an aggregate that no
    // longer matches anything in the document ("structure.First point"), so
    // it can never anchor or materialize as marks.
    const crossesParagraph = Boolean(previous)
      && /<\/w:p>/i.test(storyXml.slice(previous.endIndex, preview.index));
    if (previous && !crossesParagraph && shouldMergeSourceTrackedChangePreview(previous, preview)) {
      previous.text = `${previous.text}${preview.text}`.slice(0, 420);
      previous.endIndex = preview.endIndex;
      continue;
    }
    merged.push({ ...preview });
  }

  return merged
    .map((preview) => ({
      author: preview.author,
      contextBefore: preview.contextBefore,
      date: preview.date,
      kind: preview.kind,
      text: normalizeComparableText(preview.text).slice(0, 420)
    }))
    .filter((preview) => isUsefulSourceTrackedChangePreview(preview.text))
    .slice(0, limit);
}

function shouldMergeSourceTrackedChangePreview(left: SourceTrackedChangePreviewFragment, right: SourceTrackedChangePreviewFragment): boolean {
  const sameMetadata = left.kind === right.kind
    && left.author === right.author;
  if (!sameMetadata) {
    return false;
  }
  if (left.revisionId && right.revisionId && left.revisionId === right.revisionId) {
    return left.revisionId === right.revisionId;
  }
  return sourceRevisionDatesAreClose(left.date, right.date) && right.index - left.endIndex < 240;
}

function isUsefulSourceTrackedChangePreview(text: string): boolean {
  // Small revisions matter now that imported revisions become actionable
  // inline suggestions (a one-word grammar fix is a legitimate tracked
  // change); only drop empty/whitespace fragments.
  return text.trim().length >= 2;
}

function sourceRevisionDatesAreClose(leftDate: string | undefined, rightDate: string | undefined): boolean {
  if (leftDate === rightDate) {
    return true;
  }
  if (!leftDate || !rightDate) {
    return false;
  }
  const leftTime = Date.parse(leftDate);
  const rightTime = Date.parse(rightDate);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= 120_000;
}

export async function exportDocx(request: ExportRequest): Promise<Buffer> {
  const blocks = htmlToBlocks(request.html ?? "");
  const document = new Document({
    creator: "Nebula Writer",
    title: request.title,
    sections: [
      {
        properties: {},
        children: blocks.map(blockToParagraph)
      }
    ]
  });

  const buffer = await Packer.toBuffer(document);
  // Mark-derived cards (id "…-mark-export") are already present as revision
  // runs parsed from the HTML's suggestion spans — matching them again by
  // text would double-track them.
  const pendingSuggestions = (request.suggestions ?? []).filter((suggestion) =>
    suggestion.status === "pending" && !suggestion.id.endsWith("-mark-export"));
  const hasRevisionRuns = blocks.some((block) => block.runs.some((run) => run.revision));
  return request.trackedChanges && (pendingSuggestions.length || hasRevisionRuns)
    ? addTrackedChanges(buffer, blocks, pendingSuggestions)
    : buffer;
}

export async function exportTrackedChangesFromSource(sourceDocx: Buffer, suggestions: AiSuggestion[]): Promise<Buffer> {
  return (await exportTrackedChangesFromSourceWithReport(sourceDocx, suggestions)).buffer;
}

export async function acceptTrackedChangesByAuthor(sourceDocx: Buffer, author: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(sourceDocx);
  let changed = false;

  await Promise.all(Object.entries(zip.files).map(async ([path, file]) => {
    if (file.dir || !WORD_STORY_PART_PATTERN.test(path)) {
      return;
    }

    const xml = await file.async("string");
    const acceptedXml = acceptInlineTrackedChangesByAuthor(xml, author);
    if (acceptedXml !== xml) {
      zip.file(path, acceptedXml);
      changed = true;
    }
  }));

  return changed ? zip.generateAsync({ type: "nodebuffer" }) : sourceDocx;
}

async function acceptedTrackedChangesForDisplay(sourceDocx: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(sourceDocx);
  let changed = false;

  await Promise.all(Object.entries(zip.files).map(async ([path, file]) => {
    if (file.dir || !WORD_STORY_PART_PATTERN.test(path)) {
      return;
    }

    const xml = await file.async("string");
    const acceptedXml = acceptInlineTrackedChangesForDisplay(xml);
    if (acceptedXml !== xml) {
      zip.file(path, acceptedXml);
      changed = true;
    }
  }));

  return changed ? zip.generateAsync({ type: "nodebuffer" }) : sourceDocx;
}

export interface TrackedChangeExportReport {
  commentedSuggestionIds: string[];
  commentedSuggestionOriginals: string[];
  commentedSuggestionReasonCounts: Array<{ count: number; reason: string }>;
  commentedSuggestionReasons: string[];
  commentedSuggestionTitles: string[];
  commentedSuggestions: number;
  matchedSuggestionIds: string[];
  matchedSuggestionTitles: string[];
  matchedSuggestions: number;
  totalSuggestions: number;
  unmatchedSuggestionIds: string[];
  unmatchedSuggestionOriginals: string[];
  unmatchedSuggestionTitles: string[];
  unmatchedSuggestions: number;
}

export interface TrackedChangeExportResult {
  buffer: Buffer;
  report: TrackedChangeExportReport;
}

export async function exportTrackedChangesFromSourceWithReport(sourceDocx: Buffer, suggestions: AiSuggestion[]): Promise<TrackedChangeExportResult> {
  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === "pending");
  if (!pendingSuggestions.length) {
    return {
      buffer: sourceDocx,
      report: emptyTrackedChangeExportReport()
    };
  }

  const zip = await JSZip.loadAsync(sourceDocx);
  const documentXmlFile = zip.file("word/document.xml");
  if (!documentXmlFile) {
    return {
      buffer: sourceDocx,
      report: {
        commentedSuggestionIds: [],
        commentedSuggestionOriginals: [],
        commentedSuggestionReasonCounts: [],
        commentedSuggestionReasons: [],
        commentedSuggestions: 0,
        commentedSuggestionTitles: [],
        matchedSuggestionIds: [],
        matchedSuggestionTitles: [],
        matchedSuggestions: 0,
        totalSuggestions: pendingSuggestions.length,
        unmatchedSuggestionIds: pendingSuggestions.map((suggestion) => suggestion.id),
        unmatchedSuggestionOriginals: pendingSuggestions.map((suggestion) => suggestion.original),
        unmatchedSuggestions: pendingSuggestions.length,
        unmatchedSuggestionTitles: pendingSuggestions.map((suggestion) => suggestion.title)
      }
    };
  }

  const sourceDocumentXml = await documentXmlFile.async("string");
  const storyXml = await readWordStoryXml(zip);
  const revisionIds = revisionIdAllocatorFromXml(storyXml);
  const commentIds = commentIdAllocatorFromXml(storyXml);
  const usedSuggestionIds = new Set<string>();
  // Image replacements first: each swaps one picture run for a tracked
  // delete/insert pair with a new media part; the text pipeline then runs on
  // the result (figure runs hold no text, so the two never collide).
  const imageResult = await replaceDocxImages(zip, sourceDocumentXml, pendingSuggestions.filter((suggestion) => suggestion.kind === "image"), revisionIds);
  for (const suggestion of imageResult.applied) {
    usedSuggestionIds.add(suggestion.id);
  }
  const imageFailureReasons = new Map(imageResult.failed.map(({ suggestion, reason }) => [suggestion.id, reason]));
  const documentXml = imageResult.xml;
  // Anchor-safety guard: a short original that appears in several places
  // cannot be located reliably by text matching, so route it to a Word comment
  // instead of silently patching the first occurrence (which may be the wrong
  // one — the classic failure mode of minimal manual-edit diffs).
  const paragraphTexts = [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((match) => paragraphText(match[0]));
  const bodyText = paragraphTexts.join("\n");
  // Placement anchors: when the original occurs in several paragraphs, the
  // surroundings recorded at staging time pick the paragraph the AI meant.
  const preferredParagraphs = preferredParagraphsByAnchor(paragraphTexts, pendingSuggestions);
  const ambiguousAnchorReasons = new Map<string, string>();
  for (const suggestion of pendingSuggestions) {
    if (suggestion.commentOnly || suggestion.kind === "image" || preferredParagraphs.has(suggestion.id)) {
      continue;
    }
    const anchor = suggestion.original.trim();
    if (anchor.length >= UNIQUE_ANCHOR_MIN_LENGTH) {
      continue;
    }
    const occurrences = countTextOccurrences(bodyText, anchor);
    if (occurrences > 1) {
      const preview = anchor.length > 60 ? `${anchor.slice(0, 57)}...` : anchor;
      ambiguousAnchorReasons.set(
        suggestion.id,
        `Source text "${preview}" appears ${occurrences === 10 ? "10 or more" : occurrences} times in the document, so Nebula preserved this edit as a Word comment instead of guessing which occurrence to change.`
      );
    }
  }
  const trackedChangeCandidates = pendingSuggestions.filter((suggestion) => !suggestion.commentOnly && suggestion.kind !== "image" && !ambiguousAnchorReasons.has(suggestion.id));
  const patchedParagraphs = patchOriginalParagraphs(documentXml, trackedChangeCandidates, usedSuggestionIds, revisionIds, preferredParagraphs);
  const patchedSequences = patchParagraphSequences(patchedParagraphs, trackedChangeCandidates, usedSuggestionIds, revisionIds);
  const patchedSensitiveTextRuns = patchSensitiveParagraphTextRuns(patchedSequences, trackedChangeCandidates, usedSuggestionIds, revisionIds);
  const trackedSuggestionCount = usedSuggestionIds.size;
  const trackedSuggestionIds = pendingSuggestions.filter((suggestion) => usedSuggestionIds.has(suggestion.id)).map((suggestion) => suggestion.id);
  const trackedSuggestionTitles = pendingSuggestions.filter((suggestion) => usedSuggestionIds.has(suggestion.id)).map((suggestion) => suggestion.title);
  const anchoredCommentResult = anchorSuggestionComments(patchedSensitiveTextRuns, pendingSuggestions, usedSuggestionIds, commentIds);
  const commentFallbackSuggestions = pendingSuggestions.filter((suggestion) => !usedSuggestionIds.has(suggestion.id));
  const commentFallbacks = commentFallbackSuggestions.map((suggestion) => ({
    id: commentIds.next(),
    reason: suggestion.commentOnly
      ? "Suggestion was marked comment-only for Word handoff; no body source text was found, so Nebula added it to the review comments appendix."
      : "Could not find safe body source text for tracked changes; added to the review comments appendix.",
    suggestion
  }));
  const patchedDocumentXml = commentFallbacks.length
    ? appendSuggestionCommentAppendix(anchoredCommentResult.xml, commentFallbacks)
    : anchoredCommentResult.xml;
  const comments = [...anchoredCommentResult.comments, ...commentFallbacks].map((comment) => ({
    ...comment,
    reason: ambiguousAnchorReasons.get(comment.suggestion.id) ?? imageFailureReasons.get(comment.suggestion.id) ?? comment.reason
  }));

  zip.file("word/document.xml", patchedDocumentXml);
  if (comments.length) {
    await addSuggestionComments(zip, comments);
  }
  await enableTrackRevisions(zip);
  const commentedSuggestionReasons = comments.map((comment) => comment.reason ?? "Preserved as a Word comment because this source text could not be rewritten safely.");
  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    report: {
      commentedSuggestionIds: comments.map((comment) => comment.suggestion.id),
      commentedSuggestionOriginals: comments.map((comment) => comment.suggestion.original),
      commentedSuggestionReasonCounts: summarizeStringCounts(commentedSuggestionReasons),
      commentedSuggestionReasons,
      commentedSuggestions: comments.length,
      commentedSuggestionTitles: comments.map((comment) => comment.suggestion.title),
      matchedSuggestionIds: trackedSuggestionIds,
      matchedSuggestionTitles: trackedSuggestionTitles,
      matchedSuggestions: trackedSuggestionCount,
      totalSuggestions: pendingSuggestions.length,
      unmatchedSuggestionIds: [],
      unmatchedSuggestionOriginals: [],
      unmatchedSuggestions: 0,
      unmatchedSuggestionTitles: []
    }
  };
}

/* ------------------------------- images ------------------------------- */

export interface DocxExtractedImage {
  /** Position among the document's pictures (drawing runs) in document order. */
  index: number;
  bytes: Buffer;
  mime: string;
  width: number | null;
  height: number | null;
  altText: string | null;
  /** The picture's own paragraph text, else its caption or the preceding paragraph. */
  context: string | null;
  paragraphIndex: number | null;
}

const EMU_PER_PIXEL = 9525;
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function documentRelationshipTargets(relsXml: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(match[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
    if (id && target) {
      targets.set(id, target);
    }
  }
  return targets;
}

/** Every run holding a <w:drawing>, in document order, with its span in the XML. */
function drawingRunsInOrder(documentXml: string): Array<{ start: number; end: number; runXml: string; drawingXml: string }> {
  const runs: Array<{ start: number; end: number; runXml: string; drawingXml: string }> = [];
  for (const match of documentXml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)) {
    const drawingStart = match.index ?? 0;
    const runStart = Math.max(documentXml.lastIndexOf("<w:r>", drawingStart), documentXml.lastIndexOf("<w:r ", drawingStart));
    const runClose = documentXml.indexOf("</w:r>", drawingStart + match[0].length);
    if (runStart < 0 || runClose < 0) {
      continue;
    }
    const end = runClose + "</w:r>".length;
    runs.push({ start: runStart, end, runXml: documentXml.slice(runStart, end), drawingXml: match[0] });
  }
  return runs;
}

function captionContext(paragraphs: Array<{ text: string }>, index: number): string | null {
  if (index < 0) {
    return null;
  }
  const own = paragraphs[index]?.text.trim();
  if (own) {
    return own;
  }
  const next = paragraphs[index + 1]?.text.trim();
  if (next && /^(?:figure|fig\.|table|scheme|chart|panel)\b/i.test(next)) {
    return next;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previous = paragraphs[cursor]?.text.trim();
    if (previous) {
      return previous;
    }
  }
  return null;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** The document's pictures with their media bytes, sizes, alt text, and captions — what an agent needs to look at figures. */
export async function extractDocxImages(buffer: Buffer, limit = 24): Promise<DocxExtractedImage[]> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    return [];
  }
  const relsXml = (await zip.file("word/_rels/document.xml.rels")?.async("string")) ?? "";
  const targets = documentRelationshipTargets(relsXml);
  const paragraphs = [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    text: paragraphText(match[0])
  }));
  const images: DocxExtractedImage[] = [];
  const runs = drawingRunsInOrder(documentXml);
  for (let index = 0; index < runs.length && images.length < limit; index += 1) {
    const run = runs[index];
    const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(run.drawingXml)?.[1];
    const target = embed ? targets.get(embed) : undefined;
    if (!target) {
      continue;
    }
    const mediaPath = target.startsWith("/") ? target.slice(1) : `word/${target}`;
    const bytes = await zip.file(mediaPath)?.async("nodebuffer");
    if (!bytes) {
      continue;
    }
    const mime = sniffImageMime(bytes) ?? imageMimeForName(mediaPath);
    if (!mime) {
      // EMF/TIFF and friends: no CLI can look at them; leave them out.
      continue;
    }
    const extent = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(run.drawingXml);
    const docPr = /<wp:docPr\b[^>]*>/.exec(run.drawingXml)?.[0] ?? "";
    const altText = /\bdescr="([^"]*)"/.exec(docPr)?.[1] ?? /\btitle="([^"]*)"/.exec(docPr)?.[1] ?? null;
    const paragraphIndex = paragraphs.findIndex((paragraph) => paragraph.start <= run.start && run.end <= paragraph.end);
    images.push({
      index,
      bytes,
      mime,
      width: extent ? Math.round(Number(extent[1]) / EMU_PER_PIXEL) : null,
      height: extent ? Math.round(Number(extent[2]) / EMU_PER_PIXEL) : null,
      altText: altText ? decodeXmlEntities(altText) : null,
      context: captionContext(paragraphs, paragraphIndex),
      paragraphIndex: paragraphIndex >= 0 ? paragraphIndex : null
    });
  }
  return images;
}

function maxDocPrId(documentXml: string): number {
  let max = 0;
  for (const match of documentXml.matchAll(/<wp:docPr\b[^>]*\bid="(\d+)"/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * Swap document pictures for the files image suggestions carry, as tracked
 * changes: the old run is wrapped in <w:del>, a copy pointing at a new media
 * part (same extent, fresh drawing id) in <w:ins>. Highest index first so the
 * spans of earlier runs stay valid.
 */
async function replaceDocxImages(
  zip: JSZip,
  documentXml: string,
  suggestions: AiSuggestion[],
  revisionIds: RevisionIdAllocator
): Promise<{ xml: string; applied: AiSuggestion[]; failed: Array<{ suggestion: AiSuggestion; reason: string }> }> {
  if (!suggestions.length) {
    return { xml: documentXml, applied: [], failed: [] };
  }
  const relsPath = "word/_rels/document.xml.rels";
  let relsXml = (await zip.file(relsPath)?.async("string"))
    ?? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let contentTypesXml = (await zip.file("[Content_Types].xml")?.async("string")) ?? null;
  let xml = documentXml;
  const applied: AiSuggestion[] = [];
  const failed: Array<{ suggestion: AiSuggestion; reason: string }> = [];
  let nextDocPrId = maxDocPrId(xml) + 1;
  const ordered = [...suggestions].sort((a, b) => (b.image?.index ?? 0) - (a.image?.index ?? 0));
  for (const suggestion of ordered) {
    const image = suggestion.image;
    if (!image) {
      failed.push({ suggestion, reason: "The image suggestion carries no replacement file." });
      continue;
    }
    const runs = drawingRunsInOrder(xml);
    const run = runs[image.index];
    if (!run) {
      failed.push({ suggestion, reason: `The document has ${runs.length} picture${runs.length === 1 ? "" : "s"}; there is no picture ${image.index + 1} to replace.` });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(image.path);
    } catch {
      failed.push({ suggestion, reason: "The replacement image file is no longer available." });
      continue;
    }
    const mime = sniffImageMime(bytes);
    const extension = mime ? IMAGE_EXTENSION_BY_MIME[mime] : undefined;
    if (!mime || !extension) {
      failed.push({ suggestion, reason: "The replacement file is not a PNG, JPEG, GIF, or WebP image." });
      continue;
    }
    const relId = `rId${nextRelationshipIdFromXml(relsXml)}`;
    const mediaName = `media/nebula-image-${randomUUID().slice(0, 8)}.${extension}`;
    zip.file(`word/${mediaName}`, bytes);
    relsXml = relsXml.replace("</Relationships>", `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${mediaName}"/></Relationships>`);
    if (contentTypesXml && !new RegExp(`Extension="${extension}"`, "i").test(contentTypesXml)) {
      contentTypesXml = contentTypesXml.replace("</Types>", `<Default Extension="${extension}" ContentType="${mime}"/></Types>`);
    }
    const author = suggestionAuthor(suggestion);
    const replacementRun = run.runXml
      .replace(/(<a:blip\b[^>]*\br:embed=")[^"]+(")/, `$1${relId}$2`)
      .replace(/(<wp:docPr\b[^>]*\bid=")\d+(")/, `$1${nextDocPrId++}$2`);
    const tracked = `<w:del w:id="${revisionIds.next()}" w:author="${escapeXml(author)}" w:date="${revisionDate()}">${run.runXml}</w:del>`
      + `<w:ins w:id="${revisionIds.next()}" w:author="${escapeXml(author)}" w:date="${revisionDate()}">${replacementRun}</w:ins>`;
    xml = `${xml.slice(0, run.start)}${tracked}${xml.slice(run.end)}`;
    applied.push(suggestion);
  }
  if (applied.length) {
    zip.file(relsPath, relsXml);
    if (contentTypesXml) {
      zip.file("[Content_Types].xml", contentTypesXml);
    }
  }
  return { xml, applied, failed };
}

// Anchors at least this long are trusted even when repeated (long duplicated
// sentences are rare and the historical first-match behavior is kept for them).
const UNIQUE_ANCHOR_MIN_LENGTH = 32;

function countTextOccurrences(haystack: string, needle: string): number {
  const query = needle.trim();
  if (!query) {
    return 0;
  }
  const countIn = (text: string, value: string): number => {
    let count = 0;
    let index = text.indexOf(value);
    while (index >= 0 && count < 10) {
      count += 1;
      index = text.indexOf(value, index + value.length);
    }
    return count;
  };
  const exact = countIn(haystack, query);
  return exact > 0 ? exact : countIn(haystack.toLowerCase(), query.toLowerCase());
}

function emptyTrackedChangeExportReport(): TrackedChangeExportReport {
  return {
    commentedSuggestionIds: [],
    commentedSuggestionOriginals: [],
    commentedSuggestionReasonCounts: [],
    commentedSuggestionReasons: [],
    commentedSuggestions: 0,
    commentedSuggestionTitles: [],
    matchedSuggestionIds: [],
    matchedSuggestionTitles: [],
    matchedSuggestions: 0,
    totalSuggestions: 0,
    unmatchedSuggestionIds: [],
    unmatchedSuggestionOriginals: [],
    unmatchedSuggestions: 0,
    unmatchedSuggestionTitles: []
  };
}

function summarizeStringCounts(values: string[]): Array<{ count: number; reason: string }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ count, reason }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => imageAltText(attrs))
    .replace(/<\/t[dh]>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/table>/gi, "\n")
    .replace(/<\/(p|h1|h2|h3|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export interface TextBlock {
  type: "heading1" | "heading2" | "heading3" | "paragraph" | "bullet";
  runs: Array<{ text: string; bold?: boolean; italics?: boolean; underline?: boolean; highlight?: boolean; revision?: TextRunRevision }>;
}

/** A run that came from a suggestion mark in the editor HTML: the mark IS the
 * tracked change, so export emits it directly instead of re-finding the edit
 * by text matching (which cannot express multi-paragraph structural
 * suggestions — they exported as plain duplicated text before this). */
export interface TextRunRevision {
  kind: "insert" | "delete";
  author: string;
}

export function htmlToBlocks(html: string): TextBlock[] {
  const normalized = html
    .replace(/<li\b[^>]*>/gi, "<p data-type=\"bullet\">")
    .replace(/<\/li>/gi, "</p>")
    .replace(/<br\s*\/?>/gi, "\n");
  const matches = [...normalized.matchAll(/<(h1|h2|h3|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi)];
  const blocks = matches.map((match): TextBlock => {
    const [, tag, attrs, inner] = match;
    return {
      type: attrs.includes("data-type=\"bullet\"")
        ? "bullet"
        : tag === "h1"
          ? "heading1"
          : tag === "h2"
            ? "heading2"
            : tag === "h3"
              ? "heading3"
              : "paragraph",
      runs: parseRuns(inner)
    };
  });

  return blocks.length ? blocks : [{ type: "paragraph", runs: [{ text: htmlToText(html) }] }];
}

function parseRuns(innerHtml: string): TextBlock["runs"] {
  const runs: TextBlock["runs"] = [];
  // Suggestion-mark spans are semantic: their content is a pending insertion
  // or deletion by a named author. Capture that as run revision info before
  // generic tag stripping erases it.
  const suggestionPattern = /<span\b[^>]*data-suggestion-(insertion|deletion)[^>]*>([\s\S]*?)<\/span>/gi;
  let cursor = 0;
  for (const match of innerHtml.matchAll(suggestionPattern)) {
    parseInlineRuns(innerHtml.slice(cursor, match.index), runs);
    const author = /\bauthorname="([^"]*)"/i.exec(match[0])?.[1] || "Agent";
    parseInlineRuns(match[2], runs, {
      kind: match[1].toLowerCase() === "insertion" ? "insert" : "delete",
      author: decodeEntities(author)
    });
    cursor = (match.index ?? 0) + match[0].length;
  }
  parseInlineRuns(innerHtml.slice(cursor), runs);
  return runs.length ? runs : [{ text: "" }];
}

function parseInlineRuns(fragment: string, runs: TextBlock["runs"], revision?: TextRunRevision): void {
  // Drop every tag except the formatting pairs the tokenizer understands.
  // Without this, an unrecognized tag (e.g. a suggestion-mark <span> with
  // attributes) fails both alternatives at its "<", and [^<]+ then captures
  // the tag's attribute text as literal document content.
  const cleaned = fragment.replace(/<\/?(?!(?:strong|b|em|i|u|mark)\b)[a-zA-Z][^>]*>/gi, "");
  const tokenPattern = /<(strong|b|em|i|u|mark)\b[^>]*>([\s\S]*?)<\/\1>|([^<]+)/gi;
  for (const token of cleaned.matchAll(tokenPattern)) {
    if (token[3]) {
      pushRun(runs, decodeEntities(token[3]), false, false, revision);
    } else {
      const tag = token[1].toLowerCase();
      const inner = token[2];
      // Nested emphasis (<strong><em>…</em></strong>) collapses to the union of the tags.
      pushRun(
        runs,
        decodeEntities(stripTags(inner)),
        tag === "strong" || tag === "b" || /<(?:strong|b)\b/i.test(inner),
        tag === "em" || tag === "i" || /<(?:em|i)\b/i.test(inner),
        revision,
        tag === "u" || /<u\b/i.test(inner),
        tag === "mark" || /<mark\b/i.test(inner)
      );
    }
  }
}

function pushRun(runs: TextBlock["runs"], text: string, bold = false, italics = false, revision?: TextRunRevision, underline = false, highlight = false): void {
  if (!text) {
    return;
  }
  runs.push({
    text,
    ...(bold ? { bold } : {}),
    ...(italics ? { italics } : {}),
    ...(underline ? { underline } : {}),
    ...(highlight ? { highlight } : {}),
    ...(revision ? { revision } : {})
  });
}

function blockToParagraph(block: TextBlock): Paragraph {
  const heading = block.type === "heading1"
    ? HeadingLevel.HEADING_1
    : block.type === "heading2"
      ? HeadingLevel.HEADING_2
      : block.type === "heading3"
        ? HeadingLevel.HEADING_3
        : undefined;

  return new Paragraph({
    heading,
    bullet: block.type === "bullet" ? { level: 0 } : undefined,
    children: block.runs.map((run) => new TextRun({
      text: run.text,
      bold: run.bold,
      italics: run.italics,
      underline: run.underline ? {} : undefined,
      highlight: run.highlight ? "yellow" : undefined
    }))
  });
}

async function addTrackedChanges(baseDocx: Buffer, blocks: TextBlock[], suggestions: AiSuggestion[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(baseDocx);
  const documentXmlFile = zip.file("word/document.xml");
  if (!documentXmlFile) {
    return baseDocx;
  }

  const documentXml = await documentXmlFile.async("string");
  const revisionIds = revisionIdAllocatorFromXml(documentXml);
  const usedSuggestionIds = new Set<string>();
  const paragraphs = blocks.map((block) => blockToTrackedXml(block, suggestions, usedSuggestionIds, revisionIds));
  const unmatched = suggestions.filter((suggestion) => !usedSuggestionIds.has(suggestion.id));
  if (unmatched.length) {
    paragraphs.push(...unmatchedSuggestionsXml(unmatched, revisionIds));
  }

  const patchedDocumentXml = documentXml.replace(
    /<w:body>[\s\S]*?<w:sectPr/,
    `<w:body>${paragraphs.join("")}<w:sectPr`
  );
  zip.file("word/document.xml", patchedDocumentXml);
  await enableTrackRevisions(zip);

  return zip.generateAsync({ type: "nodebuffer" });
}

async function enableTrackRevisions(zip: JSZip): Promise<void> {
  const settingsFile = zip.file("word/settings.xml");
  if (settingsFile) {
    const settingsXml = await settingsFile.async("string");
    if (!settingsXml.includes("<w:trackRevisions")) {
      zip.file("word/settings.xml", settingsXml.replace("</w:settings>", "<w:trackRevisions/></w:settings>"));
    }
    await ensureSettingsContentType(zip);
    await ensureSettingsRelationship(zip);
    return;
  }

  zip.file(
    "word/settings.xml",
    [
      "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
      "<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
      "<w:trackRevisions/>",
      "</w:settings>"
    ].join("")
  );
  await ensureSettingsContentType(zip);
  await ensureSettingsRelationship(zip);
}

async function ensureSettingsContentType(zip: JSZip): Promise<void> {
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (!contentTypesFile) {
    return;
  }

  const contentTypesXml = await contentTypesFile.async("string");
  if (/PartName="\/word\/settings\.xml"/i.test(contentTypesXml)) {
    return;
  }

  const override = "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>";
  zip.file("[Content_Types].xml", contentTypesXml.replace("</Types>", `${override}</Types>`));
}

async function ensureSettingsRelationship(zip: JSZip): Promise<void> {
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  const settingsRelType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
  if (!relsFile) {
    zip.file(
      relsPath,
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        `<Relationship Id="rId1" Type="${settingsRelType}" Target="settings.xml"/>`,
        "</Relationships>"
      ].join("")
    );
    return;
  }

  const relsXml = await relsFile.async("string");
  if (relsXml.includes(settingsRelType)) {
    return;
  }

  const nextRelationshipId = nextRelationshipIdFromXml(relsXml);
  const relationship = `<Relationship Id="rId${nextRelationshipId}" Type="${settingsRelType}" Target="settings.xml"/>`;
  zip.file(relsPath, relsXml.replace("</Relationships>", `${relationship}</Relationships>`));
}

function nextRelationshipIdFromXml(relsXml: string): number {
  let maxRelationshipId = 0;
  for (const match of relsXml.matchAll(/\bId="rId(\d+)"/g)) {
    maxRelationshipId = Math.max(maxRelationshipId, Number(match[1]));
  }
  return maxRelationshipId + 1;
}

function patchOriginalParagraphs(
  documentXml: string,
  suggestions: AiSuggestion[],
  usedSuggestionIds: Set<string>,
  revisionIds: RevisionIdAllocator,
  preferredParagraphs: Map<string, number> = new Map()
): string {
  let inReferenceSection = false;
  let paragraphIndex = -1;
  return documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml, offset: number) => {
    paragraphIndex += 1;
    const text = paragraphText(paragraphXml).trim();
    const isReferenceHeading = isReferenceSectionHeading(text);
    if (isReferenceHeading) {
      inReferenceSection = true;
    } else if (inReferenceSection && isHeadingParagraph(paragraphXml)) {
      inReferenceSection = false;
    }

    if (inReferenceSection || isInsideProtectedContainer(documentXml, offset) || containsRevisionSensitiveXml(paragraphXml)) {
      return paragraphXml;
    }

    const changes = findSuggestionRanges(text, suggestions.filter((suggestion) => (
      !usedSuggestionIds.has(suggestion.id) && (preferredParagraphs.get(suggestion.id) ?? paragraphIndex) === paragraphIndex
    )));
    if (!changes.length) {
      return paragraphXml;
    }

    for (const change of changes) {
      usedSuggestionIds.add(change.suggestion.id);
    }

    const fullText = paragraphText(paragraphXml);
    const leadingOffset = fullText.length - fullText.trimStart().length;
    let patchedParagraph: string | null = paragraphXml;
    for (const change of [...changes].sort((left, right) => right.start - left.start)) {
      patchedParagraph = patchParagraphTextRunChange(
        patchedParagraph,
        {
          start: change.start + leadingOffset,
          end: change.end + leadingOffset,
          replacement: change.suggestion.replacement,
          emphasis: change.suggestion.emphasis?.replacement ?? null
        },
        revisionIds,
        suggestionAuthor(change.suggestion)
      );
      if (!patchedParagraph) {
        break;
      }
    }
    if (patchedParagraph) {
      return patchedParagraph;
    }

    const openTag = paragraphXml.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
    const paragraphProperties = paragraphXml.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
    return `${openTag}${paragraphProperties}${trackedRunsXml(text, changes, revisionIds)}</w:p>`;
  });
}

function containsRevisionSensitiveXml(paragraphXml: string): boolean {
  return /<(?:m:oMath|m:oMathPara|w:fldSimple|w:fldChar|w:instrText|w:sdt|w:customXml(?:\b|[A-Z][A-Za-z]*)|w:hyperlink|w:bookmarkStart|w:bookmarkEnd|w:commentRangeStart|w:commentRangeEnd|w:commentReference|w:footnoteReference|w:endnoteReference|w:ins|w:del|w:moveFromRangeStart|w:moveFromRangeEnd|w:moveToRangeStart|w:moveToRangeEnd|w:moveFrom|w:moveTo|w:drawing|w:pict|v:imagedata)\b/i.test(paragraphXml);
}

function commentReasonForParagraph(paragraphXml: string): string {
  if (containsExistingTrackedRevisionXml(paragraphXml)) {
    return "Source text is in a paragraph that already contains tracked changes, so Nebula preserved the edit as a Word comment.";
  }
  if (containsMediaXml(paragraphXml)) {
    return "Source text is in a paragraph that also contains preserved DOCX media, so Nebula preserved the edit as a Word comment.";
  }
  if (containsOfficeMathXml(paragraphXml)) {
    return "Source text is in a paragraph that contains a Word equation/math object, so Nebula preserved the edit as a Word comment instead of rewriting OMML.";
  }
  if (containsUnsafeInlineRevisionTargetXml(paragraphXml)) {
    return "Source text overlaps protected inline Word structure such as a formula, field, citation, hyperlink, content control, custom XML, footnote, or endnote.";
  }
  if (/<(?:w:commentRangeStart|w:commentRangeEnd|w:commentReference)\b/i.test(paragraphXml)) {
    return "Source text is in a paragraph that already contains Word comments, so Nebula preserved the edit as a Word comment.";
  }
  if (containsRevisionSensitiveXml(paragraphXml)) {
    return "Source text is in revision-sensitive Word XML, so Nebula preserved the edit as a Word comment.";
  }
  return "Source text matched the document, but Nebula could not rewrite the paragraph safely as tracked changes.";
}

function containsExistingTrackedRevisionXml(paragraphXml: string): boolean {
  return /<w:(?:ins|del|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|moveFrom|moveTo)\b/i.test(paragraphXml);
}

function containsUnsafeInlineRevisionTargetXml(paragraphXml: string): boolean {
  return /<(?:m:oMath|m:oMathPara|w:sdt|w:customXml(?:\b|[A-Z][A-Za-z]*)|w:hyperlink|w:footnoteReference|w:endnoteReference|w:drawing|w:pict|v:imagedata)\b/i.test(paragraphXml);
}

// Inline structures whose runs cannot be split around safely, so a paragraph
// containing them must be handed off to a comment rather than rewritten. Unlike
// containsUnsafeInlineRevisionTargetXml, this deliberately EXCLUDES hyperlinks,
// footnote/endnote references, and comment/bookmark markers: those can be
// preserved by editing the mutable text around them (they are marked protected
// per-run, and patchParagraphTextRunChange refuses any span that would disturb
// their boundary markers), so an edit elsewhere in the paragraph still lands as
// a tracked change instead of collapsing to a comment.
function containsUnsplittableInlineXml(paragraphXml: string): boolean {
  return /<(?:m:oMath|m:oMathPara|w:sdt|w:customXml(?:\b|[A-Z][A-Za-z]*)|w:drawing|w:pict|v:imagedata)\b/i.test(paragraphXml);
}

// Structural boundary markers that must survive verbatim: rewriting a run span
// that contains one would drop or reorder it, corrupting a comment, bookmark,
// hyperlink, field, footnote, or existing revision. Edits that would touch such
// a span are refused (and fall back to a comment) instead.
function spanDisturbsProtectedMarker(xmlSlice: string): boolean {
  return /<\/?(?:w:hyperlink|w:commentRangeStart|w:commentRangeEnd|w:commentReference|w:bookmarkStart|w:bookmarkEnd|w:fldSimple|w:fldChar|w:instrText|w:footnoteReference|w:endnoteReference|w:ins|w:del|w:moveFrom|w:moveTo)\b/i.test(xmlSlice);
}

function containsOfficeMathXml(paragraphXml: string): boolean {
  return /<m:oMath(?:Para)?\b/i.test(paragraphXml);
}

function containsMediaXml(paragraphXml: string): boolean {
  return /<(?:w:drawing|w:pict|v:imagedata)\b/i.test(paragraphXml);
}

function patchSensitiveParagraphTextRuns(
  documentXml: string,
  suggestions: AiSuggestion[],
  usedSuggestionIds: Set<string>,
  revisionIds: RevisionIdAllocator
): string {
  let inReferenceSection = false;
  return documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml, offset: number) => {
    const text = paragraphText(paragraphXml).trim();
    const isReferenceHeading = isReferenceSectionHeading(text);
    if (isReferenceHeading) {
      inReferenceSection = true;
    } else if (inReferenceSection && isHeadingParagraph(paragraphXml)) {
      inReferenceSection = false;
    }

    if (
      inReferenceSection
      || isInsideProtectedContainer(documentXml, offset)
      || !containsRevisionSensitiveXml(paragraphXml)
      || containsExistingTrackedRevisionXml(paragraphXml)
      || containsUnsplittableInlineXml(paragraphXml)
    ) {
      return paragraphXml;
    }

    let patchedXml = paragraphXml;
    for (const suggestion of suggestions) {
      if (usedSuggestionIds.has(suggestion.id)) {
        continue;
      }
      const nextXml = patchParagraphTextRuns(patchedXml, suggestion, revisionIds);
      if (!nextXml) {
        continue;
      }
      patchedXml = nextXml;
      usedSuggestionIds.add(suggestion.id);
    }
    return patchedXml;
  });
}

interface TextRunSegment {
  protected: boolean;
  text: string;
  textEnd: number;
  textStart: number;
  xml: string;
  xmlEnd: number;
  xmlStart: number;
}

interface MutableTextChange {
  end: number;
  replacement: string;
  start: number;
  /** Emphasis the AI asked for on the replacement; null/undefined = carry the original's emphasis over. */
  emphasis?: EmphasisSpan[] | null;
}

function patchParagraphTextRuns(paragraphXml: string, suggestion: AiSuggestion, revisionIds: RevisionIdAllocator): string | null {
  const text = paragraphText(paragraphXml);
  const range = findTextRange(text, suggestion.original);
  if (!range) {
    return null;
  }

  const textRuns = collectTextRunSegments(paragraphXml);
  const changes = mutableChangesAroundProtectedRuns(text, range, textRuns, suggestion);
  if (!changes.length) {
    return null;
  }

  let patchedXml = paragraphXml;
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    const nextXml = patchParagraphTextRunChange(patchedXml, change, revisionIds, suggestionAuthor(suggestion));
    if (!nextXml) {
      return null;
    }
    patchedXml = nextXml;
  }
  return patchedXml;
}

function mutableChangesAroundProtectedRuns(
  text: string,
  range: { start: number; end: number },
  textRuns: TextRunSegment[],
  suggestion: AiSuggestion
): MutableTextChange[] {
  const protectedPieces = textRuns
    .filter((run) => run.protected && run.textStart < range.end && range.start < run.textEnd)
    .map((run) => {
      const start = Math.max(range.start, run.textStart);
      const end = Math.min(range.end, run.textEnd);
      return { start, end, text: text.slice(start, end) };
    })
    .filter((piece) => piece.text.length > 0)
    .sort((left, right) => left.start - right.start);

  if (!protectedPieces.length) {
    return text.slice(range.start, range.end) === suggestion.replacement
      ? []
      : [{ start: range.start, end: range.end, replacement: suggestion.replacement }];
  }

  const changes: MutableTextChange[] = [];
  let originalCursor = range.start;
  let replacementCursor = 0;

  for (const protectedPiece of protectedPieces) {
    const protectedIndex = suggestion.replacement.indexOf(protectedPiece.text, replacementCursor);
    if (protectedIndex < 0) {
      return [];
    }
    pushMutableTextChange(changes, text, originalCursor, protectedPiece.start, suggestion.replacement.slice(replacementCursor, protectedIndex));
    originalCursor = protectedPiece.end;
    replacementCursor = protectedIndex + protectedPiece.text.length;
  }

  pushMutableTextChange(changes, text, originalCursor, range.end, suggestion.replacement.slice(replacementCursor));
  return changes;
}

function pushMutableTextChange(changes: MutableTextChange[], text: string, start: number, end: number, replacement: string): void {
  if (start >= end || text.slice(start, end) === replacement) {
    return;
  }
  changes.push({ start, end, replacement });
}

function patchParagraphTextRunChange(
  paragraphXml: string,
  change: MutableTextChange,
  revisionIds: RevisionIdAllocator,
  author: string
): string | null {
  const textRuns = collectTextRunSegments(paragraphXml);
  const affectedRuns = textRuns.filter((run) => run.textStart < change.end && change.start < run.textEnd);
  if (!affectedRuns.length || affectedRuns.some((run) => run.protected)) {
    return null;
  }

  const firstRun = affectedRuns[0];
  const lastRun = affectedRuns[affectedRuns.length - 1];
  // Refuse edits whose rewritten run span would swallow a structural boundary
  // marker (comment/bookmark/hyperlink/field/footnote/existing-revision), so
  // those paragraphs still edit safely around the marker instead of corrupting
  // it. The edit falls back to a comment when this happens.
  if (spanDisturbsProtectedMarker(paragraphXml.slice(firstRun.xmlStart, lastRun.xmlEnd))) {
    return null;
  }
  const paragraphTextValue = paragraphText(paragraphXml);
  const prefix = paragraphTextValue.slice(firstRun.textStart, change.start);
  const suffix = paragraphTextValue.slice(change.end, lastRun.textEnd);
  const firstRunProperties = runPropertiesXml(firstRun.xml);
  const deletedPieces = affectedRuns.map((run) => ({
    runProperties: runPropertiesXml(run.xml),
    text: paragraphTextValue.slice(Math.max(run.textStart, change.start), Math.min(run.textEnd, change.end))
  }));
  // Emphasis on the new text: what the AI asked for, else the original's
  // carried across (kept words keep theirs, new words inherit from the word before).
  const deletedText = paragraphTextValue.slice(change.start, change.end);
  const originalEmphasis = emphasisFromPieces(deletedPieces.map((piece) => ({ text: piece.text, format: runEmphasis(piece.runProperties) })));
  const replacementEmphasis = change.emphasis ?? carryEmphasis(deletedText, originalEmphasis, change.replacement);
  const replacementXml = [
    formattedTextRunXml(prefix, firstRunProperties),
    formattedDeletedXml(deletedPieces, revisionIds.next(), author),
    change.replacement ? formattedInsertedXml(change.replacement, revisionIds.next(), author, firstRunProperties, replacementEmphasis) : "",
    formattedTextRunXml(suffix, runPropertiesXml(lastRun.xml))
  ].join("");

  return `${paragraphXml.slice(0, firstRun.xmlStart)}${replacementXml}${paragraphXml.slice(lastRun.xmlEnd)}`;
}

function collectTextRunSegments(paragraphXml: string): TextRunSegment[] {
  const runs: TextRunSegment[] = [];
  let textOffset = 0;
  for (const match of paragraphXml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
    const xml = match[0];
    const text = [...xml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((textMatch) => decodeEntities(stripTags(textMatch[1])))
      .join("");
    if (!text) {
      continue;
    }
    const xmlStart = match.index ?? 0;
    const run: TextRunSegment = {
      protected: isTextRunProtected(paragraphXml, xmlStart),
      text,
      textStart: textOffset,
      textEnd: textOffset + text.length,
      xml,
      xmlStart,
      xmlEnd: xmlStart + xml.length
    };
    runs.push(run);
    textOffset = run.textEnd;
  }
  return runs;
}

function isTextRunProtected(paragraphXml: string, offset: number): boolean {
  return isInsideXmlElement(paragraphXml, offset, "w:fldSimple")
    || isInsideComplexField(paragraphXml, offset)
    || isInsideXmlElement(paragraphXml, offset, "w:hyperlink")
    || isInsideXmlElement(paragraphXml, offset, "w:ins")
    || isInsideXmlElement(paragraphXml, offset, "w:del")
    || isInsideXmlElement(paragraphXml, offset, "w:moveFrom")
    || isInsideXmlElement(paragraphXml, offset, "w:moveTo");
}

function isInsideComplexField(paragraphXml: string, offset: number): boolean {
  const beforeRun = paragraphXml.slice(0, offset);
  let fieldDepth = 0;
  for (const match of beforeRun.matchAll(/<w:fldChar\b[^>]*\bw:fldCharType="(begin|end)"[^>]*>/gi)) {
    if (match[1] === "begin") {
      fieldDepth += 1;
    } else {
      fieldDepth = Math.max(0, fieldDepth - 1);
    }
  }
  return fieldDepth > 0;
}

function isInsideProtectedContainer(documentXml: string, offset: number): boolean {
  return isInsideXmlElement(documentXml, offset, "w:sdt") || isInsideXmlElement(documentXml, offset, "w:customXml");
}

function isInsideXmlElement(documentXml: string, offset: number, tagName: string): boolean {
  const beforeParagraph = documentXml.slice(0, offset);
  const openPattern = new RegExp(`<${escapeRegExp(tagName)}\\b`, "gi");
  const closePattern = new RegExp(`</${escapeRegExp(tagName)}>`, "gi");
  return lastMatchIndex(beforeParagraph, openPattern) > lastMatchIndex(beforeParagraph, closePattern);
}

function lastMatchIndex(value: string, pattern: RegExp): number {
  let lastIndex = -1;
  for (const match of value.matchAll(pattern)) {
    lastIndex = match.index ?? lastIndex;
  }
  return lastIndex;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeadingParagraph(paragraphXml: string): boolean {
  return /<w:pStyle\b[^>]*\bw:val="(?:Title|Heading[1-9])"/i.test(paragraphXml);
}

function sectionHeadingForParagraph(text: string, paragraphXml: string): string | null {
  const trimmed = compactAnchorText(text);
  if (!trimmed) {
    return null;
  }

  if (isHeadingParagraph(paragraphXml)) {
    return trimSectionHeading(trimmed);
  }

  const majorHeading = trimmed.match(/^(Background and scientific premise|Significance|Innovation|Approach|Timeline of proposed work|Sex as a Biological Variable|Expected Milestones and Impact)\b[.:]?/i);
  if (majorHeading) {
    return trimSectionHeading(majorHeading[1]);
  }

  const aimHeading = trimmed.match(/^((?:[Ss]pecific\s+)?[Aa]im\s+\d+[A-Z]?(?:\s*[:.]\s*|\s+(?=[A-Z]))[^.!?]{0,180}[.!?]?)/);
  if (aimHeading) {
    return trimSectionHeading(aimHeading[1]);
  }

  return null;
}

function trimSectionHeading(text: string): string {
  return compactAnchorText(text)
    .replace(/[.:;,\s]+$/g, "")
    .slice(0, 220)
    .trim();
}

function isReferenceSectionHeading(text: string): boolean {
  return /^(references|bibliography|works cited|literature cited|reference list)$/i.test(text.trim());
}

function paragraphText(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((match) => decodeEntities(stripTags(match[1])))
    .join("");
}

function splitAnchorSentences(text: string): string[] {
  const protectedDots = text
    .replace(/\b(Fig|fig|Dr|Mr|Ms|Mrs|vs)\./g, "$1<dot>")
    .replace(/\be\.g\./gi, (match) => match.replace(/\./g, "<dot>"))
    .replace(/\bi\.e\./gi, (match) => match.replace(/\./g, "<dot>"));
  return (protectedDots.match(/[^.!?]+[.!?]+/g) ?? [])
    .map((sentence) => sentence.replace(/<dot>/g, ".").trim());
}

function compactAnchorText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isBodySafeAnchorCandidate(sentence: string): boolean {
  if (sentence.length < 80 || sentence.length > 260) {
    return false;
  }
  if (/^(figure|fig\.|table|aim\s+\d|specific aim|references|bibliography)\b/i.test(sentence)) {
    return false;
  }
  if (isFigurePanelFragment(sentence)) {
    return false;
  }
  if (/[{}\[\]$]|\\cite|\\ref|<|>/.test(sentence)) {
    return false;
  }
  return /[a-z]/i.test(sentence) && sentence.split(/\s+/).length >= 12;
}

function isFigurePanelFragment(sentence: string): boolean {
  return /^\([A-Z]\)\s/.test(sentence.trim()) || /\([A-Z]\)[^.!?]{12,}\([A-Z]\)/.test(sentence);
}

function appendTrackedSuggestionAppendix(
  documentXml: string,
  suggestions: AiSuggestion[],
  revisionIds: RevisionIdAllocator
): string {
  const appendix = unmatchedSuggestionsXml(suggestions, revisionIds).join("");
  if (/<w:sectPr\b/.test(documentXml)) {
    return documentXml.replace(/<w:sectPr\b/, `${appendix}<w:sectPr`);
  }
  return documentXml.replace("</w:body>", `${appendix}</w:body>`);
}

interface SuggestionComment {
  id: number;
  reason?: string;
  suggestion: AiSuggestion;
}

function appendSuggestionCommentAppendix(documentXml: string, comments: SuggestionComment[]): string {
  const appendix = suggestionCommentReferenceXml(comments).join("");
  if (/<w:sectPr\b/.test(documentXml)) {
    return documentXml.replace(/<w:sectPr\b/, `${appendix}<w:sectPr`);
  }
  return documentXml.replace("</w:body>", `${appendix}</w:body>`);
}

function anchorSuggestionComments(
  documentXml: string,
  suggestions: AiSuggestion[],
  usedSuggestionIds: Set<string>,
  commentIds: CommentIdAllocator
): { comments: SuggestionComment[]; xml: string } {
  const comments: SuggestionComment[] = [];
  let inReferenceSection = false;
  let xml = documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml, offset: number) => {
    const text = paragraphText(paragraphXml).trim();
    const isReferenceHeading = isReferenceSectionHeading(text);
    if (isReferenceHeading) {
      inReferenceSection = true;
    } else if (inReferenceSection && isHeadingParagraph(paragraphXml)) {
      inReferenceSection = false;
    }

    if (inReferenceSection || isInsideProtectedContainer(documentXml, offset)) {
      return paragraphXml;
    }

    const paragraphSuggestions = suggestions.filter((candidate) => (
      !usedSuggestionIds.has(candidate.id) && paragraphContainsSuggestionAnchor(text, candidate)
    ));
    if (!paragraphSuggestions.length) {
      return paragraphXml;
    }

    const paragraphComments = paragraphSuggestions.map((suggestion) => ({
      id: commentIds.next(),
      reason: commentReasonForSuggestion(suggestion, paragraphXml),
      suggestion
    }));
    comments.push(...paragraphComments);
    for (const comment of paragraphComments) {
      usedSuggestionIds.add(comment.suggestion.id);
    }
    return insertCommentReferencesBeforeParagraphEnd(paragraphXml, paragraphComments.map((comment) => comment.id));
  });

  for (const suggestion of suggestions) {
    if (usedSuggestionIds.has(suggestion.id)) {
      continue;
    }
    const anchorIndex = findRawXmlSuggestionAnchor(xml, suggestion);
    if (
      anchorIndex < 0
      || isInsideReferenceSectionAt(xml, anchorIndex)
      || isInsideProtectedContainer(xml, anchorIndex)
    ) {
      continue;
    }
    const paragraphEnd = xml.indexOf("</w:p>", anchorIndex);
    if (paragraphEnd < 0) {
      continue;
    }
    const paragraphStart = xml.lastIndexOf("<w:p", anchorIndex);
    const paragraphXml = paragraphStart >= 0 && paragraphStart < paragraphEnd
      ? xml.slice(paragraphStart, paragraphEnd + "</w:p>".length)
      : null;
    const comment = {
      id: commentIds.next(),
      reason: commentReasonForSuggestion(suggestion, paragraphXml) ?? "Source text was found only in raw Word XML inside protected DOCX structure, so Nebula preserved the edit as a Word comment for manual review instead of rewriting that structure.",
      suggestion
    };
    comments.push(comment);
    usedSuggestionIds.add(suggestion.id);
    const reference = `<w:r><w:commentReference w:id="${comment.id}"/></w:r>`;
    xml = `${xml.slice(0, paragraphEnd)}${reference}${xml.slice(paragraphEnd)}`;
  }

  return { comments, xml };
}

function commentReasonForSuggestion(suggestion: AiSuggestion, paragraphXml: string | null): string {
  if (suggestion.commentOnly) {
    return "Suggestion was marked comment-only for Word handoff, so Nebula preserved it as a Word comment.";
  }
  return paragraphXml
    ? commentReasonForParagraph(paragraphXml)
    : "Source text was found only in raw Word XML inside protected DOCX structure, so Nebula preserved the edit as a Word comment for manual review instead of rewriting that structure.";
}

function paragraphContainsSuggestionAnchor(text: string, suggestion: AiSuggestion): boolean {
  const paragraph = normalizeComparableText(text);
  const query = normalizeComparableText(suggestion.original);
  if (!query) {
    return false;
  }
  const lowerParagraph = paragraph.toLowerCase();
  if (lowerParagraph.includes(query.toLowerCase())) {
    return true;
  }
  return commentAnchorFragments(suggestion.original).some((fragment) => lowerParagraph.includes(fragment.toLowerCase()));
}

function findRawXmlSuggestionAnchor(documentXml: string, suggestion: AiSuggestion): number {
  for (const candidate of [...rawXmlAnchorCandidates(suggestion.original), ...commentAnchorFragments(suggestion.original)]) {
    const index = documentXml.toLowerCase().indexOf(escapeXml(candidate).toLowerCase());
    if (index >= 0) {
      return index;
    }
    const looseMatch = looseXmlTextPattern(candidate).exec(documentXml);
    if (looseMatch?.index !== undefined) {
      return looseMatch.index;
    }
  }
  return -1;
}

function commentAnchorFragments(value: string): string[] {
  const fragments = new Set<string>();
  const chunks = value.split(/\n+/)
    .map(compactAnchorText)
    .filter(Boolean);

  for (const chunk of chunks) {
    if (isCommentAnchorFragmentCandidate(chunk)) {
      fragments.add(chunk);
    }
    for (const sentence of splitAnchorSentences(chunk)) {
      const fragment = compactAnchorText(sentence);
      if (isCommentAnchorFragmentCandidate(fragment)) {
        fragments.add(fragment);
      }
    }
  }

  return [...fragments].sort((left, right) => right.length - left.length);
}

function isCommentAnchorFragmentCandidate(fragment: string): boolean {
  if (fragment.length < 70 || fragment.length > 360) {
    return false;
  }
  if (/^(figure|fig\.|table|aim\s+\d|specific aim|references|bibliography)\b/i.test(fragment)) {
    return false;
  }
  if (isFigurePanelFragment(fragment)) {
    return false;
  }
  if (/[{}\[\]$]|\\cite|\\ref|<|>/.test(fragment)) {
    return false;
  }
  return /[a-z]/i.test(fragment) && fragment.split(/\s+/).length >= 10;
}

function rawXmlAnchorCandidates(value: string): string[] {
  const normalized = normalizeComparableText(value);
  if (!normalized) {
    return [];
  }
  const candidates = new Set<string>();
  const prefix = normalized.slice(0, 120).replace(/\s+\S*$/, "").trim();
  if (prefix.length >= 40) {
    candidates.add(prefix);
  }
  const words = normalized.split(/\s+/).slice(0, 8).join(" ");
  if (words.length >= 24) {
    candidates.add(words);
  }
  return [...candidates];
}

function looseXmlTextPattern(value: string): RegExp {
  const escaped = escapeXml(value);
  const source = Array.from(escaped).map((char) => (
    /\s/.test(char)
      ? "(?:\\s|<[^>]+>)+"
      : `${escapeRegExp(char)}(?:<[^>]+>)*`
  )).join("");
  return new RegExp(source, "i");
}

function isInsideReferenceSectionAt(documentXml: string, offset: number): boolean {
  let inReferenceSection = false;
  for (const match of documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    const paragraphStart = match.index ?? 0;
    if (paragraphStart > offset) {
      break;
    }
    const paragraphXml = match[0];
    const text = paragraphText(paragraphXml).trim();
    if (isReferenceSectionHeading(text)) {
      inReferenceSection = true;
    } else if (inReferenceSection && isHeadingParagraph(paragraphXml)) {
      inReferenceSection = false;
    }
  }
  return inReferenceSection;
}

function insertCommentReferencesBeforeParagraphEnd(paragraphXml: string, ids: number[]): string {
  const references = ids.map((id) => `<w:r><w:commentReference w:id="${id}"/></w:r>`).join("");
  return paragraphXml.replace(/<\/w:p>$/i, `${references}</w:p>`);
}

function suggestionCommentReferenceXml(comments: SuggestionComment[]): string[] {
  const paragraphs = [
    "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>AI review comments</w:t></w:r></w:p>"
  ];
  comments.forEach((comment) => {
    paragraphs.push(
      `<w:p>${textRunXml(`AI comment: ${comment.suggestion.title}`)}<w:r><w:commentReference w:id="${comment.id}"/></w:r></w:p>`
    );
  });
  return paragraphs;
}

async function addSuggestionComments(zip: JSZip, comments: SuggestionComment[]): Promise<void> {
  const commentsPath = "word/comments.xml";
  const commentsFile = zip.file(commentsPath);
  const commentsXml = commentsFile ? await commentsFile.async("string") : defaultCommentsXml();
  const nextCommentsXml = commentsXml.includes("</w:comments>")
    ? commentsXml.replace("</w:comments>", `${comments.map(suggestionCommentXml).join("")}</w:comments>`)
    : defaultCommentsXml(comments);

  zip.file(commentsPath, nextCommentsXml);
  await ensureCommentsContentType(zip);
  await ensureCommentsRelationship(zip);
}

function defaultCommentsXml(comments: SuggestionComment[] = []): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
    "<w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
    comments.map(suggestionCommentXml).join(""),
    "</w:comments>"
  ].join("");
}

function suggestionCommentXml(comment: SuggestionComment): string {
  const { suggestion } = comment;
  const paragraphs = [
    suggestion.title,
    `Original: ${suggestion.original}`,
    `Suggested revision: ${suggestion.replacement}`,
    comment.reason ? `Export note: ${comment.reason}` : "",
    `Rationale: ${suggestion.rationale}`
  ].filter((line) => line.trim()).map((line) => `<w:p>${textRunXml(line)}</w:p>`).join("");

  return `<w:comment w:id="${comment.id}" w:author="${escapeXml(suggestionAuthor(comment.suggestion))}" w:date="${revisionDate()}">${paragraphs}</w:comment>`;
}

async function ensureCommentsContentType(zip: JSZip): Promise<void> {
  const contentTypesFile = zip.file("[Content_Types].xml");
  if (!contentTypesFile) {
    return;
  }

  const contentTypesXml = await contentTypesFile.async("string");
  if (/PartName="\/word\/comments\.xml"/i.test(contentTypesXml)) {
    return;
  }

  const override = "<Override PartName=\"/word/comments.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml\"/>";
  zip.file("[Content_Types].xml", contentTypesXml.replace("</Types>", `${override}</Types>`));
}

async function ensureCommentsRelationship(zip: JSZip): Promise<void> {
  const relsPath = "word/_rels/document.xml.rels";
  const relsFile = zip.file(relsPath);
  const commentsRelType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
  if (!relsFile) {
    zip.file(
      relsPath,
      [
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        `<Relationship Id="rId1" Type="${commentsRelType}" Target="comments.xml"/>`,
        "</Relationships>"
      ].join("")
    );
    return;
  }

  const relsXml = await relsFile.async("string");
  if (relsXml.includes(commentsRelType)) {
    return;
  }

  const nextRelationshipId = nextRelationshipIdFromXml(relsXml);
  const relationship = `<Relationship Id="rId${nextRelationshipId}" Type="${commentsRelType}" Target="comments.xml"/>`;
  zip.file(relsPath, relsXml.replace("</Relationships>", `${relationship}</Relationships>`));
}

interface ParagraphSegment {
  end: number;
  protected: boolean;
  start: number;
  text: string;
  xml: string;
}

function patchParagraphSequences(
  documentXml: string,
  suggestions: AiSuggestion[],
  usedSuggestionIds: Set<string>,
  revisionIds: RevisionIdAllocator
): string {
  let patchedXml = documentXml;

  for (const suggestion of suggestions) {
    if (usedSuggestionIds.has(suggestion.id)) {
      continue;
    }
    const match = findParagraphSequence(patchedXml, suggestion);
    if (!match) {
      continue;
    }
    const replacement = paragraphSequenceTrackedXml(match.paragraphs, suggestion, revisionIds);
    patchedXml = `${patchedXml.slice(0, match.start)}${replacement}${patchedXml.slice(match.end)}`;
    usedSuggestionIds.add(suggestion.id);
  }

  return patchedXml;
}

function findParagraphSequence(documentXml: string, suggestion: AiSuggestion): { end: number; paragraphs: ParagraphSegment[]; start: number } | null {
  const query = normalizeComparableText(suggestion.original);
  if (!query) {
    return null;
  }
  const paragraphs = collectParagraphSegments(documentXml);

  for (let startIndex = 0; startIndex < paragraphs.length; startIndex += 1) {
    const sequence: ParagraphSegment[] = [];
    const textParts: string[] = [];
    for (let index = startIndex; index < Math.min(paragraphs.length, startIndex + 8); index += 1) {
      const paragraph = paragraphs[index];
      if (paragraph.protected) {
        break;
      }
      sequence.push(paragraph);
      if (paragraph.text.trim()) {
        textParts.push(paragraph.text);
      }
      const candidate = normalizeComparableText(textParts.join(" "));
      if (!candidate) {
        continue;
      }
      if (candidate === query || candidate.toLowerCase() === query.toLowerCase()) {
        return {
          start: sequence[0].start,
          end: sequence[sequence.length - 1].end,
          paragraphs: sequence
        };
      }
      if (!query.toLowerCase().startsWith(candidate.toLowerCase())) {
        break;
      }
    }
  }

  return null;
}

function collectParagraphSegments(documentXml: string): ParagraphSegment[] {
  let inReferenceSection = false;
  return [...documentXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map((match) => {
    const xml = match[0];
    const start = match.index ?? 0;
    const text = paragraphText(xml).trim();
    const isReferenceHeading = isReferenceSectionHeading(text);
    if (isReferenceHeading) {
      inReferenceSection = true;
    } else if (inReferenceSection && isHeadingParagraph(xml)) {
      inReferenceSection = false;
    }
    return {
      start,
      end: start + xml.length,
      xml,
      text,
      protected: inReferenceSection || isInsideProtectedContainer(documentXml, start) || containsRevisionSensitiveXml(xml)
    };
  });
}

function paragraphSequenceTrackedXml(paragraphs: ParagraphSegment[], suggestion: AiSuggestion, revisionIds: RevisionIdAllocator): string {
  const firstParagraph = paragraphs[0]?.xml ?? "<w:p>";
  const openTag = firstParagraph.match(/^<w:p\b[^>]*>/)?.[0] ?? "<w:p>";
  const paragraphProperties = firstParagraph.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/)?.[0] ?? "";
  const author = suggestionAuthor(suggestion);
  const deletedPieces: Array<{ runProperties: string; text: string }> = [];
  for (const paragraph of paragraphs) {
    const runs = collectTextRunSegments(paragraph.xml);
    if (!runs.length) {
      continue;
    }
    if (deletedPieces.length) {
      deletedPieces.push({ runProperties: "", text: " " });
    }
    for (const run of runs) {
      deletedPieces.push({ runProperties: runPropertiesXml(run.xml), text: run.text });
    }
  }
  const insertProperties = deletedPieces.find((piece) => piece.text.trim())?.runProperties ?? "";
  return `${openTag}${paragraphProperties}${formattedDeletedXml(deletedPieces, revisionIds.next(), author)}${formattedInsertedXml(suggestion.replacement, revisionIds.next(), author, insertProperties)}</w:p>`;
}

function blockToTrackedXml(
  block: TextBlock,
  suggestions: AiSuggestion[],
  usedSuggestionIds: Set<string>,
  revisionIds: RevisionIdAllocator
): string {
  const paragraphProperties = block.type === "heading1"
    ? "<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>"
    : block.type === "heading2"
      ? "<w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr>"
      : block.type === "heading3"
        ? "<w:pPr><w:pStyle w:val=\"Heading3\"/></w:pPr>"
        : "";

  // Runs that came from suggestion marks are self-describing tracked changes:
  // emit them directly. Text matching cannot express these (a structural
  // suggestion's inserted paragraphs used to export as plain document text).
  if (block.runs.some((run) => run.revision)) {
    const runsXml = block.runs.map((run) => {
      if (!run.revision) {
        return textRunXml(run.text);
      }
      return run.revision.kind === "delete"
        ? deletedRunXml(run.text, revisionIds.next(), run.revision.author)
        : insertedRunXml(run.text, revisionIds.next(), run.revision.author);
    }).join("");
    const bulletPrefix = block.type === "bullet" ? textRunXml("- ") : "";
    return `<w:p>${paragraphProperties}${bulletPrefix}${runsXml}</w:p>`;
  }

  const rawText = block.runs.map((run) => run.text).join("");
  const text = block.type === "bullet" ? `- ${rawText}` : rawText;
  const changes = findSuggestionRanges(text, suggestions.filter((suggestion) => !usedSuggestionIds.has(suggestion.id)));
  for (const change of changes) {
    usedSuggestionIds.add(change.suggestion.id);
  }

  return `<w:p>${paragraphProperties}${trackedRunsXml(text, changes, revisionIds)}</w:p>`;
}

interface TrackedRange {
  start: number;
  end: number;
  suggestion: AiSuggestion;
}

/**
 * For each anchored suggestion whose original occurs in more than one
 * paragraph, the paragraph whose surroundings match the anchor decisively.
 */
function preferredParagraphsByAnchor(paragraphTexts: string[], suggestions: AiSuggestion[]): Map<string, number> {
  const preferred = new Map<string, number>();
  for (const suggestion of suggestions) {
    if (!suggestion.anchor || suggestion.commentOnly || suggestion.kind === "image") {
      continue;
    }
    const candidates: Array<{ index: number; before: string; after: string }> = [];
    paragraphTexts.forEach((text, index) => {
      const range = findTextRange(text, suggestion.original);
      if (range) {
        candidates.push({
          index,
          before: `${index > 0 ? paragraphTexts[index - 1] : ""}\n${text.slice(0, range.start)}`,
          after: `${text.slice(range.end)}\n${paragraphTexts[index + 1] ?? ""}`
        });
      }
    });
    const chosen = chooseAnchoredCandidate(suggestion.anchor, candidates);
    if (chosen !== null) {
      preferred.set(suggestion.id, candidates[chosen].index);
    }
  }
  return preferred;
}

function findSuggestionRanges(text: string, suggestions: AiSuggestion[]): TrackedRange[] {
  const ranges: TrackedRange[] = [];
  for (const suggestion of suggestions) {
    const range = findTextRange(text, suggestion.original);
    if (!range || ranges.some((existing) => overlaps(existing, range))) {
      continue;
    }
    ranges.push({ ...range, suggestion });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function findTextRange(text: string, query: string): { start: number; end: number } | null {
  const exact = text.indexOf(query);
  if (exact >= 0) {
    return { start: exact, end: exact + query.length };
  }

  const normalizedText = normalizeTextWithPositions(text);
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  const normalizedIndex = normalizedText.text.indexOf(normalizedQuery);
  if (normalizedIndex >= 0) {
    return normalizedRange(normalizedText, normalizedIndex, normalizedQuery.length);
  }

  const lowerIndex = normalizedText.text.toLowerCase().indexOf(normalizedQuery.toLowerCase());
  if (lowerIndex >= 0) {
    return normalizedRange(normalizedText, lowerIndex, normalizedQuery.length);
  }

  return null;
}

function normalizedRange(normalizedText: { text: string; positions: number[] }, index: number, length: number): { start: number; end: number } | null {
  const start = normalizedText.positions[index];
  const lastPosition = normalizedText.positions[index + length - 1];
  return start === undefined || lastPosition === undefined ? null : { start, end: lastPosition + 1 };
}

function normalizeTextWithPositions(value: string): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        positions.push(index);
      }
    } else {
      text += char;
      positions.push(index);
    }
  }
  while (text.startsWith(" ")) {
    text = text.slice(1);
    positions.shift();
  }
  while (text.endsWith(" ")) {
    text = text.slice(0, -1);
    positions.pop();
  }
  return { text, positions };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function countOfficeMath(value: string): number {
  const mathObjects = countMatches(value, /<m:oMath\b/gi);
  return mathObjects || countMatches(value, /<m:oMathPara\b/gi);
}

function countReferenceSectionHeadings(value: string): number {
  return [...value.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .filter((match) => isReferenceSectionHeading(paragraphText(match[0])))
    .length;
}

function countTextBoxes(value: string): number {
  const wordTextBoxContents = countMatches(value, /<w:txbxContent\b/gi);
  return wordTextBoxContents || countMatches(value, /<(?:v:textbox|wps:txbx)\b/gi);
}

async function readWordStoryXml(zip: JSZip): Promise<string> {
  const files = zip.file(WORD_STORY_PART_PATTERN);
  if (!files.length) {
    return "";
  }
  return (await Promise.all(files.map((file) => file.async("string")))).join("\n");
}

async function extractTextBoxParagraphs(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  const storyXml = await readWordStoryXml(zip);
  const wordTextBoxContents = [...storyXml.matchAll(/<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/gi)].map((match) => match[0]);
  const containers = wordTextBoxContents.length
    ? wordTextBoxContents
    : [...storyXml.matchAll(/<(?:v:textbox|wps:txbx)\b[^>]*>[\s\S]*?<\/(?:v:textbox|wps:txbx)>/gi)].map((match) => match[0]);

  return containers.flatMap((container) => (
    [...container.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi)]
      .map((match) => normalizeComparableText(paragraphText(match[0])))
      .filter(Boolean)
  ));
}

function annotateTextBoxParagraphs(html: string, textBoxParagraphs: string[]): string {
  const remaining = textBoxParagraphs.map(normalizeComparableText).filter(Boolean);
  if (!remaining.length) {
    return html;
  }

  return html.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (match, attrs: string, innerHtml: string) => {
    const paragraph = normalizeComparableText(htmlToText(innerHtml));
    const index = remaining.findIndex((textBoxParagraph) => textBoxParagraph === paragraph);
    if (index < 0) {
      return match;
    }

    remaining.splice(index, 1);
    return `<p${setHtmlAttribute(attrs, "data-docx-text-box", "true")}>${innerHtml}</p>`;
  });
}

function setHtmlAttribute(attrs: string, name: string, value: string): string {
  const escapedValue = escapeXml(value);
  const attributePattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (attributePattern.test(attrs)) {
    return attrs.replace(attributePattern, ` ${name}="${escapedValue}"`);
  }
  return `${attrs} ${name}="${escapedValue}"`;
}

function normalizeComparableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unsupportedImagePlaceholder(contentType: string): string {
  const fileType = displayImageFormat(contentType);
  const svg = [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"520\" height=\"220\" viewBox=\"0 0 520 220\" role=\"img\" aria-label=\"DOCX image preview unavailable\">",
    "<rect width=\"520\" height=\"220\" rx=\"12\" fill=\"#f8f9fa\"/>",
    "<rect x=\"18\" y=\"18\" width=\"484\" height=\"184\" rx=\"10\" fill=\"#ffffff\" stroke=\"#b9c0c9\" stroke-dasharray=\"8 8\"/>",
    "<path d=\"M184 126l42-42 31 31 18-18 61 61H184z\" fill=\"#d7dce2\"/>",
    "<circle cx=\"324\" cy=\"82\" r=\"16\" fill=\"#c7d7fb\"/>",
    "<text x=\"260\" y=\"154\" text-anchor=\"middle\" font-family=\"Aptos, Segoe UI, sans-serif\" font-size=\"18\" font-weight=\"700\" fill=\"#3f464f\">Image preview unavailable</text>",
    `<text x="260" y="181" text-anchor="middle" font-family="Aptos, Segoe UI, sans-serif" font-size="13" fill="#68727d">${escapeXml(fileType)} will be preserved from the source DOCX</text>`,
    "</svg>"
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function displayImageFormat(contentType: string): string {
  const subtype = contentType.replace(/^image\//i, "").replace(/^x-/i, "").trim();
  if (!subtype) {
    return "UNKNOWN IMAGE";
  }
  const normalized = subtype.toLowerCase();
  if (normalized === "jpeg" || normalized === "jpg") {
    return "JPEG";
  }
  if (normalized === "tif" || normalized === "tiff") {
    return "TIFF";
  }
  return subtype.toUpperCase();
}

function overlaps(left: TrackedRange, right: { start: number; end: number }): boolean {
  return left.start < right.end && right.start < left.end;
}

function trackedRunsXml(text: string, changes: TrackedRange[], revisionIds: RevisionIdAllocator): string {
  if (!changes.length) {
    return textRunXml(text);
  }

  let cursor = 0;
  const xml: string[] = [];
  changes.forEach((change) => {
    const author = suggestionAuthor(change.suggestion);
    xml.push(textRunXml(text.slice(cursor, change.start)));
    xml.push(deletedRunXml(text.slice(change.start, change.end), revisionIds.next(), author));
    xml.push(formattedInsertedXml(change.suggestion.replacement, revisionIds.next(), author, "", change.suggestion.emphasis?.replacement ?? []));
    cursor = change.end;
  });
  xml.push(textRunXml(text.slice(cursor)));
  return xml.join("");
}

function unmatchedSuggestionsXml(suggestions: AiSuggestion[], revisionIds: RevisionIdAllocator): string[] {
  const paragraphs = [
    "<w:p><w:pPr><w:pStyle w:val=\"Heading2\"/></w:pPr><w:r><w:t>Unmatched AI suggestions</w:t></w:r></w:p>"
  ];
  suggestions.forEach((suggestion) => {
    paragraphs.push(
      `<w:p>${textRunXml(`${suggestion.title}: `)}${deletedRunXml(suggestion.original, revisionIds.next(), suggestionAuthor(suggestion))}${insertedRunXml(suggestion.replacement, revisionIds.next(), suggestionAuthor(suggestion))}</w:p>`
    );
  });
  return paragraphs;
}

class RevisionIdAllocator {
  private current: number;

  constructor(startAt: number) {
    this.current = Math.max(1, startAt);
  }

  next(): number {
    const value = this.current;
    this.current += 1;
    return value;
  }
}

class CommentIdAllocator {
  private current: number;

  constructor(startAt: number) {
    this.current = Math.max(0, startAt);
  }

  next(): number {
    const value = this.current;
    this.current += 1;
    return value;
  }
}

function revisionIdAllocatorFromXml(xml: string): RevisionIdAllocator {
  let maxRevisionId = 0;
  for (const tag of xml.matchAll(/<w:(?:ins|del|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd|moveFrom|moveTo)\b[^>]*>/gi)) {
    const idMatch = /\bw:id="(\d+)"/.exec(tag[0]);
    if (idMatch) {
      maxRevisionId = Math.max(maxRevisionId, Number(idMatch[1]));
    }
  }
  return new RevisionIdAllocator(maxRevisionId + 1);
}

function commentIdAllocatorFromXml(xml: string): CommentIdAllocator {
  let maxCommentId = -1;
  for (const tag of xml.matchAll(/<w:(?:comment|commentReference|commentRangeStart|commentRangeEnd)\b[^>]*>/gi)) {
    const idMatch = /\bw:id="(\d+)"/.exec(tag[0]);
    if (idMatch) {
      maxCommentId = Math.max(maxCommentId, Number(idMatch[1]));
    }
  }
  return new CommentIdAllocator(maxCommentId + 1);
}

function textRunXml(text: string): string {
  return text ? `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : "";
}

const DEFAULT_REVISION_AUTHOR = "Nebula Writer AI";

function runPropertiesXml(runXml: string): string {
  return runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] ?? "";
}

function formattedTextRunXml(text: string, runProperties: string): string {
  return text ? `<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>` : "";
}

function formattedDeletedXml(pieces: Array<{ runProperties: string; text: string }>, id: number, author: string): string {
  const runs = pieces
    .filter((piece) => piece.text)
    .map((piece) => `<w:r>${piece.runProperties}<w:delText xml:space="preserve">${escapeXml(piece.text)}</w:delText></w:r>`)
    .join("");
  return runs ? `<w:del w:id="${id}" w:author="${escapeXml(author)}" w:date="${revisionDate()}">${runs}</w:del>` : "";
}

function formattedInsertedXml(text: string, id: number, author: string, runProperties: string, emphasis: EmphasisSpan[] = []): string {
  if (!text) {
    return "";
  }
  const runs = splitByEmphasis(text, emphasis)
    .map((piece) => formattedTextRunXml(piece.text, withRunEmphasis(runProperties, piece.format)))
    .join("");
  return `<w:ins w:id="${id}" w:author="${escapeXml(author)}" w:date="${revisionDate()}">${runs}</w:ins>`;
}

/** Bold/italic/underline/highlight as a run's properties declare them. */
function runEmphasis(runProperties: string): EmphasisFormat {
  const on = (tag: string) => new RegExp(`<w:${tag}\\b(?:\\s[^>]*)?/?>`).test(runProperties)
    && !new RegExp(`<w:${tag}\\b[^>]*w:val="(?:0|false|none)"`).test(runProperties);
  return {
    ...(on("b") ? { bold: true } : {}),
    ...(on("i") ? { italic: true } : {}),
    ...(on("u") ? { underline: true } : {}),
    ...(on("highlight") ? { highlight: true } : {})
  };
}

/** The run properties with their emphasis replaced by `format` (everything else — fonts, size, colour — kept). */
function withRunEmphasis(runProperties: string, format: EmphasisFormat): string {
  const inner = (runProperties.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "")
    .replace(/<w:(?:b|bCs|i|iCs|u|highlight)\b(?:\s[^>]*)?\/>/g, "")
    .replace(/<w:(?:b|bCs|i|iCs|u|highlight)\b(?:\s[^>]*)?>[\s\S]*?<\/w:(?:b|bCs|i|iCs|u|highlight)>/g, "");
  const lead = `${format.bold ? "<w:b/><w:bCs/>" : ""}${format.italic ? "<w:i/><w:iCs/>" : ""}`;
  const tail = `${format.highlight ? "<w:highlight w:val=\"yellow\"/>" : ""}${format.underline ? "<w:u w:val=\"single\"/>" : ""}`;
  // Schema order: style and fonts first, then b/i; highlight and u come late.
  const head = inner.match(/^(?:\s*<w:rStyle\b[^>]*\/>)?(?:\s*<w:rFonts\b[^>]*\/>)?/)?.[0] ?? "";
  const content = `${head}${lead}${inner.slice(head.length)}${tail}`;
  return content ? `<w:rPr>${content}</w:rPr>` : "";
}

function suggestionAuthor(suggestion?: Pick<AiSuggestion, "proposedBy"> | null): string {
  const author = suggestion?.proposedBy?.trim();
  return author || DEFAULT_REVISION_AUTHOR;
}

function deletedRunXml(text: string, id: number, author: string): string {
  return `<w:del w:id="${id}" w:author="${escapeXml(author)}" w:date="${revisionDate()}"><w:r><w:delText xml:space="preserve">${escapeXml(text)}</w:delText></w:r></w:del>`;
}

function insertedRunXml(text: string, id: number, author: string): string {
  return `<w:ins w:id="${id}" w:author="${escapeXml(author)}" w:date="${revisionDate()}">${textRunXml(text)}</w:ins>`;
}

function acceptInlineTrackedChangesByAuthor(xml: string, author: string): string {
  const authorPattern = escapeRegExp(escapeXml(author));
  const authoredAttributePattern = `\\bw:author="${authorPattern}"`;
  const deletionPattern = new RegExp(
    `<w:del\\b(?=[^>]*${authoredAttributePattern})[^>]*>[\\s\\S]*?<\\/w:del>`,
    "g"
  );
  const insertionPattern = new RegExp(
    `<w:ins\\b(?=[^>]*${authoredAttributePattern})[^>]*>([\\s\\S]*?)<\\/w:ins>`,
    "g"
  );

  return xml
    .replace(deletionPattern, "")
    .replace(insertionPattern, (_match, content: string) => content);
}

function acceptInlineTrackedChangesForDisplay(xml: string): string {
  return xml
    .replace(/<w:moveFromRangeStart\b[^>]*\/>[\s\S]*?<w:moveFromRangeEnd\b[^>]*\/>/gi, "")
    .replace(/<w:moveFromRangeStart\b[^>]*\/>/gi, "")
    .replace(/<w:moveFromRangeEnd\b[^>]*\/>/gi, "")
    .replace(/<w:moveToRange(?:Start|End)\b[^>]*\/>/gi, "")
    .replace(removeXmlElements("w:del"), "")
    .replace(removeXmlElements("w:moveFrom"), "")
    .replace(unwrapXmlElement("w:ins"), "")
    .replace(unwrapXmlElement("w:moveTo"), "")
    .replace(/<w:move(?:From|To)Range(?:Start|End)\b[^>]*\/>/gi, "")
    .replace(removeXmlElements("w:pPrChange"), "")
    .replace(removeXmlElements("w:rPrChange"), "")
    .replace(removeXmlElements("w:tblPrChange"), "")
    .replace(removeXmlElements("w:trPrChange"), "")
    .replace(removeXmlElements("w:tcPrChange"), "");
}

function unwrapXmlElement(tagName: string): RegExp {
  const tag = escapeRegExp(tagName);
  return new RegExp(`<${tag}\\b[^>]*\\/?>|<\\/${tag}>`, "gi");
}

function removeXmlElements(tagName: string): RegExp {
  const tag = escapeRegExp(tagName);
  return new RegExp(`<${tag}\\b[^>]*\\/>|<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
}

function revisionDate(): string {
  return new Date().toISOString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function imageAltText(attrs: string): string {
  const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const altText = decodeEntities(altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? "").trim();
  if (/^DOCX image preview (?:generated|unavailable):/i.test(altText)) {
    return " ";
  }
  return altText ? ` ${altText} ` : " ";
}
