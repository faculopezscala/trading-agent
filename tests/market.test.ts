import { describe, expect, test } from "bun:test";
import {
  etParts,
  isMarketOpen,
  isTradingDay,
  marketCloseMinutes,
  parseTimeAt,
  todayET,
  MARKET_OPEN_MIN,
} from "../src/market.ts";

describe("etParts", () => {
  test("summer (EDT, UTC-4)", () => {
    const p = etParts(new Date("2026-06-10T14:00:00Z"));
    expect(p.date).toBe("2026-06-10");
    expect(p.hour).toBe(10);
    expect(p.minute).toBe(0);
    expect(p.weekday).toBe(3); // Wednesday
  });

  test("winter (EST, UTC-5)", () => {
    const p = etParts(new Date("2026-01-15T14:30:00Z"));
    expect(p.date).toBe("2026-01-15");
    expect(p.hour).toBe(9);
    expect(p.minute).toBe(30);
    expect(p.minutesOfDay).toBe(MARKET_OPEN_MIN);
  });

  test("midnight ET does not become hour 24", () => {
    const p = etParts(new Date("2026-06-10T04:00:00Z")); // 00:00 EDT
    expect(p.hour).toBe(0);
  });
});

describe("isTradingDay", () => {
  test("weekday is trading day", () => {
    expect(isTradingDay(etParts(new Date("2026-06-10T15:00:00Z")))).toBe(true);
  });
  test("saturday is not", () => {
    expect(isTradingDay(etParts(new Date("2026-06-13T15:00:00Z")))).toBe(false);
  });
  test("sunday is not", () => {
    expect(isTradingDay(etParts(new Date("2026-06-14T15:00:00Z")))).toBe(false);
  });
  test("Juneteenth 2026 holiday", () => {
    expect(isTradingDay(etParts(new Date("2026-06-19T15:00:00Z")))).toBe(false);
  });
  test("Thanksgiving 2026", () => {
    expect(isTradingDay(etParts(new Date("2026-11-26T15:00:00Z")))).toBe(false);
  });
});

describe("isMarketOpen", () => {
  test("open at exactly 9:30 ET", () => {
    expect(isMarketOpen(new Date("2026-06-10T13:30:00Z"))).toBe(true);
  });
  test("closed at 9:29 ET", () => {
    expect(isMarketOpen(new Date("2026-06-10T13:29:00Z"))).toBe(false);
  });
  test("closed at exactly 16:00 ET", () => {
    expect(isMarketOpen(new Date("2026-06-10T20:00:00Z"))).toBe(false);
  });
  test("open at 15:59 ET", () => {
    expect(isMarketOpen(new Date("2026-06-10T19:59:00Z"))).toBe(true);
  });
  test("closed on weekend mid-day", () => {
    expect(isMarketOpen(new Date("2026-06-13T15:00:00Z"))).toBe(false);
  });
  test("early close 2026-11-27: open 12:59 ET, closed 13:00 ET", () => {
    expect(isMarketOpen(new Date("2026-11-27T17:59:00Z"))).toBe(true); // EST
    expect(isMarketOpen(new Date("2026-11-27T18:00:00Z"))).toBe(false);
  });
  test("early close day reports 13:00 close", () => {
    expect(marketCloseMinutes(etParts(new Date("2026-11-27T15:00:00Z")))).toBe(13 * 60);
  });
});

describe("parseTimeAt", () => {
  test("valid times", () => {
    expect(parseTimeAt("09:30")).toBe(570);
    expect(parseTimeAt("16:00")).toBe(960);
    expect(parseTimeAt("0:05")).toBe(5);
  });
  test("invalid times", () => {
    expect(parseTimeAt("25:00")).toBeNull();
    expect(parseTimeAt("12:60")).toBeNull();
    expect(parseTimeAt("noon")).toBeNull();
    expect(parseTimeAt("")).toBeNull();
  });
});

describe("todayET", () => {
  test("rolls over at ET midnight, not UTC", () => {
    // 03:00 UTC on Jun 11 = 23:00 ET on Jun 10
    expect(todayET(new Date("2026-06-11T03:00:00Z"))).toBe("2026-06-10");
  });
});
