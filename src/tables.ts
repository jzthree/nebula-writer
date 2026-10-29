/**
 * Tables as Writer sees them: a grid of cell texts, the same in Word, Google
 * Docs and the web editor. A table suggestion carries the grid as it was when
 * staged (`before`) and the grid it should become (`rows`); every host turns
 * that difference into the same steps (planTableMorph) — delete the rows and
 * columns that went away, insert the ones that are new, then rewrite only the
 * cells whose text differs — so an added row lands where it belongs and an
 * unchanged cell keeps its formatting.
 */

/** A table in the document, in document order. */
export interface DocumentTable {
  /** 0-based position among the document's top-level tables. */
  index: number;
  /** Cell texts, row by row (a cell's paragraphs joined with "\n"). */
  rows: string[][];
  /** Index of the paragraph holding the first cell's text, when known. */
  paragraphIndex?: number | null;
  /** Text of the paragraph just before the table (often its caption), for orientation. */
  context?: string | null;
  /** Merged cells or rows of different lengths: only cell text can be changed, not the shape. */
  irregular?: boolean;
}

export type TableAction = "insert" | "replace" | "delete";

/** A proposed table change (the `table` of a suggestion of kind "table"). */
export interface AiTableEdit {
  action: TableAction;
  /** replace/delete: the table's index when staged. */
  index: number | null;
  /** insert/replace: the grid the table should hold. */
  rows: string[][] | null;
  /** replace/delete: the grid when staged, so a host applies only to the table it was made for. */
  before: string[][] | null;
  /** insert: the first row is a header row. */
  header?: boolean;
}

export const TABLE_LIMIT = 40;
export const TABLE_CELL_LIMIT = 2_000;
export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLUMNS = 30;

/** How prompts and cards refer to a table. */
export function documentTableLabel(table: Pick<DocumentTable, "index" | "context" | "rows">): string {
  const hint = (table.context ?? "").replace(/\s+/g, " ").trim();
  const shape = `${table.rows.length}×${columnCount(table.rows)}`;
  return `[Table ${table.index + 1}] ${shape}${hint ? ` after "${hint.length > 70 ? `${hint.slice(0, 67)}…` : hint}"` : ""}`;
}

export function columnCount(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function normalizeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Same cell texts (whitespace-insensitive), same shape. */
export function sameGrid(a: string[][], b: string[][]): boolean {
  return a.length === b.length && a.every((row, r) => row.length === b[r].length && row.every((cell, c) => normalizeCell(cell) === normalizeCell(b[r][c])));
}

/** A rectangular copy of `rows` (short rows padded with empty cells), cell text normalized to LF. */
export function rectangular(rows: string[][]): string[][] {
  const width = columnCount(rows);
  return rows.map((row) => Array.from({ length: width }, (_, c) => (row[c] ?? "").replace(/\r\n?/g, "\n")));
}

/** The table the edit was made for: the one at its index if unchanged, else the only one with the same grid. */
export function findEditTarget(tables: Array<Pick<DocumentTable, "index" | "rows">>, edit: Pick<AiTableEdit, "index" | "before">): number | null {
  if (!edit.before) {
    return null;
  }
  const at = edit.index !== null ? tables.find((table) => table.index === edit.index) : undefined;
  if (at && sameGrid(at.rows, edit.before)) {
    return at.index;
  }
  const same = tables.filter((table) => sameGrid(table.rows, edit.before as string[][]));
  return same.length === 1 ? same[0].index : null;
}

/* ------------------------------------------------------------------------- */
/* Morph planning                                                            */
/* ------------------------------------------------------------------------- */

/**
 * One step on the live table. Indices refer to the table as it is when the
 * step runs (after the steps before it). Inserted rows and columns are empty;
 * the setCell steps that follow fill them.
 */
export type TableStep =
  | { type: "deleteRow"; row: number }
  | { type: "deleteColumn"; column: number }
  | { type: "insertRow"; at: number }
  | { type: "insertColumn"; at: number }
  | { type: "setCell"; row: number; column: number; text: string };

export interface TableMorph {
  steps: TableStep[];
  /** Whether rows or columns are added or removed (not possible on an irregular table). */
  structural: boolean;
}

/** Longest common subsequence of two lists under a match predicate: pairs of matched indices, in order. */
function align<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = same(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j]) && table[i][j] === table[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** At least half of the shorter list's non-empty cells also appear in the other (as a multiset). */
function mostlyShared(a: string[], b: string[]): boolean {
  const other = b.map(normalizeCell).filter(Boolean);
  const cells = a.map(normalizeCell).filter(Boolean);
  if (!cells.length || !other.length) {
    return false;
  }
  const pool = new Map<string, number>();
  for (const cell of other) {
    pool.set(cell, (pool.get(cell) ?? 0) + 1);
  }
  let shared = 0;
  for (const cell of cells) {
    const left = pool.get(cell) ?? 0;
    if (left > 0) {
      shared += 1;
      pool.set(cell, left - 1);
    }
  }
  return shared * 2 >= Math.min(cells.length, other.length);
}

/**
 * Steps that turn `before` into `after`. Columns are matched first (a column
 * matches when most of its cells reappear in the other), then rows by their
 * cells in the matched columns; what is unmatched is deleted or inserted,
 * and every cell whose text then differs is set.
 */
export function planTableMorph(beforeRows: string[][], afterRows: string[][], options: { irregular?: boolean } = {}): TableMorph {
  const before = rectangular(beforeRows);
  const after = rectangular(afterRows);
  const beforeWidth = columnCount(before);
  const afterWidth = columnCount(after);
  const column = (grid: string[][], c: number) => grid.map((row) => row[c] ?? "");

  let columnPairs: Array<[number, number]>;
  let rowPairs: Array<[number, number]>;
  if (options.irregular || (beforeWidth === afterWidth && before.length === after.length)) {
    // Same shape (or a shape that must not change): cell by cell.
    columnPairs = Array.from({ length: Math.min(beforeWidth, afterWidth) }, (_, c) => [c, c]);
    rowPairs = Array.from({ length: Math.min(before.length, after.length) }, (_, r) => [r, r]);
  } else {
    columnPairs = align(
      Array.from({ length: beforeWidth }, (_, c) => column(before, c)),
      Array.from({ length: afterWidth }, (_, c) => column(after, c)),
      mostlyShared
    );
    if (!columnPairs.length && beforeWidth && afterWidth) {
      // Nothing recognisable column-wise (e.g. every value rewritten): keep columns by position.
      columnPairs = Array.from({ length: Math.min(beforeWidth, afterWidth) }, (_, c) => [c, c]);
    }
    const project = (grid: string[][], side: 0 | 1) => grid.map((row) => columnPairs.map((pair) => row[pair[side]] ?? ""));
    const beforeKept = project(before, 0);
    const afterKept = project(after, 1);
    rowPairs = align(
      beforeKept.map((_, r) => r),
      afterKept.map((_, r) => r),
      (r0, r1) => mostlyShared(beforeKept[r0], afterKept[r1])
    );
    if (!rowPairs.length && before.length && after.length) {
      rowPairs = Array.from({ length: Math.min(before.length, after.length) }, (_, r) => [r, r]);
    }
  }

  const keptColumns = new Set(columnPairs.map((pair) => pair[0]));
  const keptRows = new Set(rowPairs.map((pair) => pair[0]));
  const newColumns = new Set(columnPairs.map((pair) => pair[1]));
  const newRows = new Set(rowPairs.map((pair) => pair[1]));
  const steps: TableStep[] = [];
  for (let c = beforeWidth - 1; c >= 0; c -= 1) {
    if (!keptColumns.has(c)) steps.push({ type: "deleteColumn", column: c });
  }
  for (let r = before.length - 1; r >= 0; r -= 1) {
    if (!keptRows.has(r)) steps.push({ type: "deleteRow", row: r });
  }
  // After the deletions the table holds exactly the matched rows and columns,
  // in order; inserting each new one at its final index, in ascending order,
  // builds the target shape.
  for (let r = 0; r < after.length; r += 1) {
    if (!newRows.has(r)) steps.push({ type: "insertRow", at: r });
  }
  for (let c = 0; c < afterWidth; c += 1) {
    if (!newColumns.has(c)) steps.push({ type: "insertColumn", at: c });
  }
  const structural = steps.length > 0;

  // The grid after the structural steps: matched cells carry their old text, new ones are empty.
  const beforeRowOf = new Map(rowPairs.map(([r0, r1]) => [r1, r0]));
  const beforeColumnOf = new Map(columnPairs.map(([c0, c1]) => [c1, c0]));
  for (let r = 0; r < after.length; r += 1) {
    for (let c = 0; c < afterWidth; c += 1) {
      const r0 = beforeRowOf.get(r);
      const c0 = beforeColumnOf.get(c);
      const current = r0 !== undefined && c0 !== undefined ? before[r0][c0] : "";
      const target = after[r][c];
      if (normalizeCell(current) !== normalizeCell(target) || current.split("\n").length !== target.split("\n").length) {
        steps.push({ type: "setCell", row: r, column: c, text: target });
      }
    }
  }
  return { steps, structural };
}

/** Apply steps to an in-memory grid — what every host must end up with (used by tests and the web editor). */
export function applyTableSteps(rows: string[][], steps: TableStep[]): string[][] {
  const grid = rectangular(rows).map((row) => [...row]);
  for (const step of steps) {
    switch (step.type) {
      case "deleteRow":
        grid.splice(step.row, 1);
        break;
      case "deleteColumn":
        for (const row of grid) row.splice(step.column, 1);
        break;
      case "insertRow":
        grid.splice(step.at, 0, Array.from({ length: columnCount(grid) }, () => ""));
        break;
      case "insertColumn":
        if (!grid.length) grid.push([]);
        for (const row of grid) row.splice(step.at, 0, "");
        break;
      case "setCell":
        grid[step.row][step.column] = step.text;
        break;
    }
  }
  return grid;
}

/** A grid as a Markdown-style table for prompts (cell newlines shown as " / "). */
export function gridForPrompt(rows: string[][]): string {
  const cell = (text: string) => text.replace(/\r?\n/g, " / ").replace(/\|/g, "\\|").trim();
  const grid = rectangular(rows);
  if (!grid.length) {
    return "(empty table)";
  }
  const lines = grid.map((row) => `| ${row.map(cell).join(" | ")} |`);
  return lines.join("\n");
}

/** Validate a proposed grid: non-empty, rectangular after padding, within limits. Returns the cleaned grid or a reason. */
export function cleanGrid(value: unknown): { rows: string[][] } | { error: string } {
  if (!Array.isArray(value) || !value.length) {
    return { error: "rows must be a non-empty array of rows, each an array of cell strings." };
  }
  if (value.length > TABLE_MAX_ROWS) {
    return { error: `A table may have at most ${TABLE_MAX_ROWS} rows.` };
  }
  const rows: string[][] = [];
  for (const row of value) {
    if (!Array.isArray(row) || !row.length) {
      return { error: "Every row must be a non-empty array of cell strings." };
    }
    if (row.length > TABLE_MAX_COLUMNS) {
      return { error: `A table may have at most ${TABLE_MAX_COLUMNS} columns.` };
    }
    const cells: string[] = [];
    for (const cell of row) {
      if (typeof cell !== "string" && typeof cell !== "number") {
        return { error: "Cells must be strings." };
      }
      const text = String(cell).replace(/\r\n?/g, "\n");
      if (text.length > TABLE_CELL_LIMIT) {
        return { error: `A cell may hold at most ${TABLE_CELL_LIMIT} characters.` };
      }
      cells.push(text);
    }
    rows.push(cells);
  }
  return { rows: rectangular(rows) };
}

/** Validate the documentTables a client sends: well-formed grids within the limits. */
export function parseDocumentTables(value: unknown): { value: DocumentTable[] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { value: undefined };
  }
  if (!Array.isArray(value) || value.length > TABLE_LIMIT) {
    return { error: `documentTables must be a list of at most ${TABLE_LIMIT} tables.` };
  }
  const tables: DocumentTable[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      return { error: "documentTables entries must be objects." };
    }
    const table = entry as Partial<DocumentTable>;
    if (!Number.isInteger(table.index) || (table.index as number) < 0) {
      return { error: "documentTables entries need a non-negative integer index." };
    }
    const grid = Array.isArray(table.rows) && !table.rows.length ? { rows: [] } : cleanGrid(table.rows);
    if ("error" in grid) {
      return { error: `documentTables[${table.index}].rows: ${grid.error}` };
    }
    tables.push({
      index: table.index as number,
      rows: grid.rows,
      paragraphIndex: Number.isInteger(table.paragraphIndex) ? table.paragraphIndex : null,
      context: typeof table.context === "string" ? table.context.slice(0, 500) : null,
      ...(table.irregular === true ? { irregular: true } : {})
    });
  }
  return { value: tables };
}
