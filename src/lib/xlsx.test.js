import { describe, it, expect } from "vitest";
import { sheetXml, xlsxParts, colName } from "./xlsx.js";

describe("colName", () => {
  it("counts columns the way a spreadsheet does", () => {
    expect(colName(0)).toBe("A");
    expect(colName(25)).toBe("Z");
    expect(colName(26)).toBe("AA");
    expect(colName(27)).toBe("AB");
  });
});

describe("sheetXml", () => {
  const cols = [
    { key: "code", label: "Código" },
    { key: "views", label: "Views" },
  ];

  it("writes a header row and one row per record", () => {
    const xml = sheetXml(cols, [{ code: "ABC", views: 12 }, { code: "DEF", views: 3 }]);
    expect(xml).toContain('<row r="1"');
    expect(xml).toContain("Código");
    expect(xml).toContain('<row r="3"');
  });

  it("writes numbers as numbers, so a spreadsheet can sort and sum them", () => {
    const xml = sheetXml(cols, [{ code: "ABC", views: 1200 }]);
    expect(xml).toContain('<c r="B2"><v>1200</v></c>'); // no t="inlineStr"
  });

  it("escapes what would otherwise break the XML", () => {
    const xml = sheetXml(cols, [{ code: 'a<b & "c"', views: null }]);
    expect(xml).toContain("a&lt;b &amp; &quot;c&quot;");
    expect(xml).not.toContain('a<b & "c"');
  });

  it("strips control characters Excel refuses to open", () => {
    // A caption carrying a stray  makes Excel declare the whole file corrupt.
    const xml = sheetXml(cols, [{ code: "ab", views: null }]);
    expect(xml).toContain("ab");
    expect(xml).not.toContain("");
  });

  it("leaves a missing value as an empty cell, not the text 'null'", () => {
    const xml = sheetXml(cols, [{ code: "ABC" }]);
    expect(xml).not.toContain("null");
  });

  it("freezes the header so it stays put while scrolling", () => {
    expect(sheetXml(cols, [])).toContain("frozen");
  });
});

describe("xlsxParts", () => {
  it("emits the parts a reader needs to open the file", () => {
    const names = xlsxParts([{ key: "a", label: "A" }], [{ a: 1 }]).map((p) => p.name);
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
  });

  it("hands back text, ready for the zip writer", () => {
    const parts = xlsxParts([{ key: "a", label: "A" }], [{ a: 1 }]);
    expect(typeof parts[0].text).toBe("string");
  });
});

describe("buildXlsx", () => {
  it("produces a real archive, not an empty one", async () => {
    const { buildXlsx } = await import("./xlsx.js");
    const bytes = buildXlsx([{ key: "a", label: "A" }], [{ a: 42 }]);
    expect(bytes.length).toBeGreaterThan(600); // five XML parts, not five empty entries
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("xl/worksheets/sheet1.xml");
    expect(text).toContain("<v>42</v>"); // the row actually made it into the archive
  });
});
