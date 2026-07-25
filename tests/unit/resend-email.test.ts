import { describe, expect, it } from "vitest";
import { buildPoolPublishedEmail } from "@/lib/email/resend";

describe("buildPoolPublishedEmail", () => {
  it("builds a subject and body containing the question and link", () => {
    const { subject, html } = buildPoolPublishedEmail(
      "Who will win?",
      "https://brohda.com/pool/abc-123",
    );

    expect(subject).toBe("New pool: Who will win?");
    expect(html).toContain("Who will win?");
    expect(html).toContain('href="https://brohda.com/pool/abc-123"');
  });

  it("escapes HTML special characters in the question", () => {
    const { html, subject } = buildPoolPublishedEmail(
      `Will <script>alert("x")</script> & "quotes" win?`,
      "https://brohda.com/pool/xyz",
    );

    // The subject is plain text (never rendered as HTML), so it stays raw —
    // only the HTML body needs escaping.
    expect(subject).toContain("<script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;quotes&quot;");
  });
});
