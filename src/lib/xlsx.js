// A minimal .xlsx writer — one sheet, inline strings, no dependency.
//
// WHY hand-rolled: an .xlsx is a ZIP of XML parts, and this extension already
// ships a ZIP writer (lib/zipWriter.js) for the media archives. The reference
// extension (IG Sorter) bundles ExcelJS for the same feature, which is most of its
// 970 KB payload — next to onnxruntime and ffmpeg-wasm, that is a dependency this
// bundle does not need to carry for a spreadsheet with no formulas.
//
// NOT implemented: styling beyond a frozen header, formulas, multiple sheets, and
// embedded images. IG Sorter embeds the thumbnail in each row; here the thumbnail
// travels as a hyperlink column instead — the picture is one click away and the
// file stays a few KB instead of a few MB.
import { buildZip } from "./zipWriter.js";

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

// Excel refuses to open a file containing raw control characters — a single stray
// 0x07 in a caption is enough for "we found a problem with some content". They are
// dropped rather than escaped: &#7; is just as illegal inside a sheet.
// The class is written in ESCAPES on purpose: it used to contain the raw bytes
// themselves (NUL included), which survives only as long as nothing in the
// toolchain normalises the file. Same character set, safe to copy and diff.
const stripControl = (s) => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
const esc = (s) => stripControl(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** 0 → "A", 25 → "Z", 26 → "AA" — spreadsheet column names are base-26 bijective. */
export function colName(i) {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function cell(ref, value) {
  if (value == null || value === "") return "";
  if (isNum(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

/**
 * `cols` is [{ key, label }]; `rows` are plain records. Numbers stay numbers so
 * the spreadsheet can sort and sum them — a views column exported as text is
 * useless, which is the whole reason to export at all.
 */
export function sheetXml(cols, rows) {
  const header = cols.map((c, i) => cell(`${colName(i)}1`, c.label || c.key)).join("");
  const body = rows
    .map((r, ri) => {
      const cells = cols.map((c, ci) => cell(`${colName(ci)}${ri + 2}`, r[c.key])).join("");
      return `<row r="${ri + 2}">${cells}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`
  );
}

/** The parts of the archive, in the order a reader expects to find them. */
export function xlsxParts(cols, rows, sheetName = "Posts") {
  return [
    {
      name: "[Content_Types].xml",
      text:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `</Types>`,
    },
    {
      name: "_rels/.rels",
      text:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      text:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `</Relationships>`,
    },
    { name: "xl/worksheets/sheet1.xml", text: sheetXml(cols, rows) },
  ];
}

/** The finished workbook, as bytes ready for a download. */
export function buildXlsx(cols, rows, sheetName = "Posts") {
  const enc = new TextEncoder();
  // `data`, not `bytes` — ZipBuilder.add(name, data) reads that key, and an entry
  // whose payload lands under the wrong name is written as a zero-byte file.
  return buildZip(xlsxParts(cols, rows, sheetName).map((p) => ({ name: p.name, data: enc.encode(p.text) })));
}
