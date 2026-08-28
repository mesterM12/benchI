import { describe, expect, it } from "vitest";
import { redactRetainedContent } from "./index.js";

describe("secret retention boundary", () => {
  it("redacts every secret occurrence and reports detected disclosure", () => {
    const retained = redactRetainedContent(Buffer.from("token=super-secret-token\nsuper-secret-token"), [Buffer.from("super-secret-token")]);

    expect(retained).toEqual({ bytes: Buffer.from("token=[REDACTED]\n[REDACTED]"), disclosed: true });
  });

  it("leaves content unchanged when no secret value is present", () => {
    const bytes = Buffer.from("safe event");

    expect(redactRetainedContent(bytes, [Buffer.from("super-secret-token")])).toEqual({ bytes, disclosed: false });
  });
});
