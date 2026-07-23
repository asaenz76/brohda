import { describe, expect, it } from "vitest";
import { extractMentionedUsernames } from "@/lib/mentions";

describe("extractMentionedUsernames", () => {
  it("extracts a single mention", () => {
    expect(extractMentionedUsernames("hey @bob check this out")).toEqual(["bob"]);
  });

  it("lowercases and dedupes repeated mentions", () => {
    expect(extractMentionedUsernames("@Bob and @bob and @BOB")).toEqual(["bob"]);
  });

  it("extracts multiple distinct mentions in order of first appearance", () => {
    expect(extractMentionedUsernames("@alice ping @bob and @carol")).toEqual(["alice", "bob", "carol"]);
  });

  it("ignores handles shorter than 3 characters", () => {
    expect(extractMentionedUsernames("@ab is too short")).toEqual([]);
  });

  it("does not treat an email address as a mention", () => {
    expect(extractMentionedUsernames("contact user@example.com for help")).toEqual([]);
  });

  it("returns an empty array when there are no mentions", () => {
    expect(extractMentionedUsernames("no handles here")).toEqual([]);
  });

  it("stops a mention at punctuation, not just whitespace", () => {
    expect(extractMentionedUsernames("thanks @bob!")).toEqual(["bob"]);
  });
});
