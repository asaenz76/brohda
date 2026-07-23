import { describe, expect, it } from "vitest";
import { formatCents, parseDollarsToCents, parsePercentToBps, formatBps } from "@/lib/utils/money";

describe("formatCents", () => {
  it("formats whole dollars", () => {
    expect(formatCents(1000)).toBe("$10.00");
  });

  it("formats cents", () => {
    expect(formatCents(1050)).toBe("$10.50");
  });

  it("formats zero", () => {
    expect(formatCents(0)).toBe("$0.00");
  });
});

describe("parseDollarsToCents", () => {
  it("parses a whole dollar amount", () => {
    expect(parseDollarsToCents("10")).toBe(1000);
  });

  it("parses one decimal place", () => {
    expect(parseDollarsToCents("10.5")).toBe(1050);
  });

  it("parses two decimal places", () => {
    expect(parseDollarsToCents("10.50")).toBe(1050);
  });

  it("parses a single-cent amount without float drift", () => {
    expect(parseDollarsToCents("0.01")).toBe(1);
  });

  it("trims surrounding whitespace", () => {
    expect(parseDollarsToCents("  10.00  ")).toBe(1000);
  });

  it("rejects zero", () => {
    expect(parseDollarsToCents("0")).toBeNull();
    expect(parseDollarsToCents("0.00")).toBeNull();
  });

  it("rejects negative amounts", () => {
    expect(parseDollarsToCents("-5")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(parseDollarsToCents("10.555")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("")).toBeNull();
  });
});

describe("parsePercentToBps", () => {
  it("parses a whole percentage", () => {
    expect(parsePercentToBps("10")).toBe(1000);
  });

  it("parses a fractional percentage", () => {
    expect(parsePercentToBps("2.5")).toBe(250);
  });

  it("allows 0% (a legitimate house fee)", () => {
    expect(parsePercentToBps("0")).toBe(0);
  });

  it("allows exactly 100%", () => {
    expect(parsePercentToBps("100")).toBe(10000);
  });

  it("rejects more than 100%", () => {
    expect(parsePercentToBps("100.5")).toBeNull();
    expect(parsePercentToBps("101")).toBeNull();
  });

  it("rejects negative percentages", () => {
    expect(parsePercentToBps("-1")).toBeNull();
  });

  it("rejects more than two decimal places", () => {
    expect(parsePercentToBps("10.555")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parsePercentToBps("abc")).toBeNull();
    expect(parsePercentToBps("")).toBeNull();
  });
});

describe("formatBps", () => {
  it("formats a whole percentage", () => {
    expect(formatBps(1000)).toBe("10%");
  });

  it("formats a fractional percentage", () => {
    expect(formatBps(250)).toBe("2.5%");
  });

  it("formats zero", () => {
    expect(formatBps(0)).toBe("0%");
  });

  it("formats two decimal places when needed", () => {
    expect(formatBps(1234)).toBe("12.34%");
  });
});
