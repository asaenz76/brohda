import { describe, expect, it } from "vitest";
import { normalizeMessageText, remainingCharacters } from "@/lib/messaging/text";

// The client mirror of the database's messaging_normalize_text (which is the authority; tests/integration/messaging.test.ts proves the database side). The two must agree on every case below.
describe("normalizeMessageText", () => {
  it("trims every kind of surrounding whitespace, including newlines and non-breaking spaces", () => {
    expect(normalizeMessageText("  hi  ")).toBe("hi");
    expect(normalizeMessageText("\n\n hi \t\n")).toBe("hi");
    expect(normalizeMessageText(" hi ")).toBe("hi");
    expect(normalizeMessageText("  \n \t ")).toBe("");
  });

  it("removes control characters but keeps newlines and tabs", () => {
    expect(normalizeMessageText("a\u0007b\u0001c")).toBe("abc");
    expect(normalizeMessageText("line one\nline two")).toBe("line one\nline two");
    expect(normalizeMessageText("a\u007fb")).toBe("ab");
  });

  it("collapses runs of blank lines to one", () => {
    expect(normalizeMessageText("a\n\n\n\n\nb")).toBe("a\n\nb");
    expect(normalizeMessageText("a\n\nb")).toBe("a\n\nb");
  });

  it("normalises Unicode to NFC", () => {
    expect(normalizeMessageText("é")).toBe("é");
  });

  it("leaves markup alone: it is stored as text and rendered as text, never as HTML", () => {
    expect(normalizeMessageText("<script>alert(1)</script> <b>bold</b>")).toBe("<script>alert(1)</script> <b>bold</b>");
  });
});

describe("remainingCharacters", () => {
  it("counts what will be stored, not what was typed", () => {
    expect(remainingCharacters("  hello  ", 10)).toBe(5);
    expect(remainingCharacters("x".repeat(12), 10)).toBe(-2);
  });
});
