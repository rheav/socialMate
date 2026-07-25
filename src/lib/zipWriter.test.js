import { describe, it, expect } from "vitest";
import {
  crc32,
  dosDateTime,
  ZipBuilder,
  buildZip,
  concatParts,
  ZIP_SIG_LOCAL,
  ZIP_SIG_CENTRAL,
  ZIP_SIG_EOCD,
  ZIP_FLAG_UTF8,
} from "./zipWriter.js";

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);
const u32 = (buf, at) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(at, true);
const u16 = (buf, at) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(at, true);
const FIXED = new Date(2026, 6, 25, 16, 40, 12); // 2026-07-25 16:40:12 local

describe("crc32", () => {
  it("matches the published CRC-32/ISO-HDLC check vectors", () => {
    expect(crc32(bytes(""))).toBe(0);
    expect(crc32(bytes("a"))).toBe(0xe8b7be43);
    expect(crc32(bytes("abc"))).toBe(0x352441c2);
    // The canonical "check" value of the CRC-32 catalogue entry.
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });

  it("is chainable: crc32(b, crc32(a)) === crc32(a+b)", () => {
    expect(crc32(bytes("56789"), crc32(bytes("1234")))).toBe(crc32(bytes("123456789")));
  });

  it("handles bytes above 0x7f (the table index must stay unsigned)", () => {
    const raw = new Uint8Array([0xff, 0x80, 0x00, 0x7f, 0xc3, 0xa9]);
    expect(crc32(raw)).toBe(0xf4900a51); // cross-checked against python zlib.crc32
    expect(crc32(raw)).toBeLessThanOrEqual(0xffffffff);
    expect(crc32(raw)).toBeGreaterThanOrEqual(0);
  });
});

describe("dosDateTime", () => {
  it("packs the date and time into the MS-DOS fields", () => {
    const { time, date } = dosDateTime(FIXED);
    expect(date >> 9).toBe(2026 - 1980);
    expect((date >> 5) & 0x0f).toBe(7);
    expect(date & 0x1f).toBe(25);
    expect(time >> 11).toBe(16);
    expect((time >> 5) & 0x3f).toBe(40);
    expect((time & 0x1f) * 2).toBe(12); // 2-second resolution
  });

  it("clamps pre-1980 dates to 1980-01-01 (DOS has no room for them)", () => {
    expect(dosDateTime(new Date(1970, 0, 1))).toEqual({ time: 0, date: (1 << 5) | 1 });
    expect(dosDateTime(new Date(1979, 11, 31, 23, 59, 59))).toEqual({ time: 0, date: (1 << 5) | 1 });
  });

  it("treats a missing or invalid date as 'now'", () => {
    const now = dosDateTime(new Date());
    expect(dosDateTime(undefined)).toEqual(now);
    expect(dosDateTime(new Date("nope"))).toEqual(now);
    expect(dosDateTime("2026-07-25")).toEqual(now); // a string is not a Date
  });
});

describe("ZipBuilder / buildZip byte structure", () => {
  it("writes a STORE local header with the UTF-8 flag and correct sizes", () => {
    const data = bytes("hello zip");
    const zip = buildZip([{ name: "a.txt", data }], { date: FIXED });

    expect(u32(zip, 0)).toBe(ZIP_SIG_LOCAL);
    expect(u16(zip, 4)).toBe(20); // version needed
    expect(u16(zip, 6)).toBe(ZIP_FLAG_UTF8); // bit 11 set → filenames are UTF-8
    expect(u16(zip, 8)).toBe(0); // method 0 = STORE
    expect(u32(zip, 14)).toBe(crc32(data));
    expect(u32(zip, 18)).toBe(data.length); // compressed size
    expect(u32(zip, 22)).toBe(data.length); // uncompressed size
    expect(u16(zip, 26)).toBe(5); // name length
    expect(u16(zip, 28)).toBe(0); // extra length
    expect(new TextDecoder().decode(zip.subarray(30, 35))).toBe("a.txt");
    // STORE means the payload follows the header verbatim.
    expect(Array.from(zip.subarray(35, 35 + data.length))).toEqual(Array.from(data));
  });

  it("writes one central-directory record per entry, pointing back at its local header", () => {
    const a = bytes("first");
    const b = bytes("second entry");
    const zip = buildZip([{ name: "a.txt", data: a }, { name: "b.txt", data: b }], { date: FIXED });

    const eocdAt = zip.length - 22;
    expect(u32(zip, eocdAt)).toBe(ZIP_SIG_EOCD);
    const total = u16(zip, eocdAt + 10);
    const cdSize = u32(zip, eocdAt + 12);
    const cdOffset = u32(zip, eocdAt + 16);
    expect(total).toBe(2);
    expect(u16(zip, eocdAt + 8)).toBe(2); // entries on this disk
    expect(cdOffset + cdSize).toBe(eocdAt); // the CD sits directly before the EOCD

    // First central record.
    expect(u32(zip, cdOffset)).toBe(ZIP_SIG_CENTRAL);
    expect(u16(zip, cdOffset + 8)).toBe(ZIP_FLAG_UTF8);
    expect(u16(zip, cdOffset + 10)).toBe(0); // STORE
    expect(u32(zip, cdOffset + 16)).toBe(crc32(a));
    expect(u32(zip, cdOffset + 20)).toBe(a.length);
    expect(u32(zip, cdOffset + 42)).toBe(0); // local header offset of entry 1

    // Second central record follows, and its offset really lands on a local header.
    const second = cdOffset + 46 + 5;
    expect(u32(zip, second)).toBe(ZIP_SIG_CENTRAL);
    const localB = u32(zip, second + 42);
    expect(u32(zip, localB)).toBe(ZIP_SIG_LOCAL);
    expect(localB).toBe(30 + 5 + a.length);
    expect(u32(zip, localB + 14)).toBe(crc32(b));
  });

  it("encodes accented names as UTF-8 bytes, not latin-1", () => {
    const zip = buildZip([{ name: "fb-Astra Valé-1.jpg", data: bytes("x") }], { date: FIXED });
    const nameLen = u16(zip, 26);
    const raw = zip.subarray(30, 30 + nameLen);
    expect(nameLen).toBe(20); // 19 characters, "é" costs 2 bytes
    expect(new TextDecoder("utf-8").decode(raw)).toBe("fb-Astra Valé-1.jpg");
    expect(Array.from(raw).some((b) => b === 0xc3)).toBe(true); // UTF-8 lead byte for é
  });

  it("produces an empty but valid archive when nothing was added", () => {
    const zip = buildZip([], { date: FIXED });
    expect(zip.length).toBe(22);
    expect(u32(zip, 0)).toBe(ZIP_SIG_EOCD);
    expect(u16(zip, 10)).toBe(0);
    expect(u32(zip, 12)).toBe(0); // central directory size
    expect(u32(zip, 16)).toBe(0); // central directory offset
  });

  it("streams as parts and only concatenates on demand", () => {
    const zip = new ZipBuilder({ date: FIXED });
    zip.add("a.bin", new Uint8Array([1, 2, 3]));
    zip.add("b.bin", new Uint8Array([4, 5]));
    expect(zip.count).toBe(2);
    expect(zip.byteLength).toBe(30 + 5 + 3 + (30 + 5 + 2));

    const parts = zip.finish();
    // 2 headers + 2 payloads + 2 central records + EOCD
    expect(parts.length).toBe(7);
    expect(parts.every((p) => p instanceof Uint8Array)).toBe(true);
    const flat = concatParts(parts);
    expect(flat.length).toBe(parts.reduce((n, p) => n + p.length, 0));
    expect(u32(flat, flat.length - 22)).toBe(ZIP_SIG_EOCD);
  });

  it("refuses to write an archive the base format cannot describe", () => {
    const zip = new ZipBuilder({ date: FIXED });
    zip.entries.length = 0xffff; // pretend the entry table is already full
    expect(() => zip.add("x", new Uint8Array(1))).toThrow(/65535/);

    const big = new ZipBuilder({ date: FIXED });
    big.offset = 0xffffffff;
    expect(() => big.add("x", new Uint8Array(1))).toThrow(/4 GB/);
  });
});
