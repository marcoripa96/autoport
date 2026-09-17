import { describe, expect, it } from "bun:test";
import { interpolate } from "../src/interpolate.ts";
import { parseDotenv } from "../src/dotenv.ts";

const env = { SET: "value", EMPTY: "" };

describe("interpolate", () => {
  it("follows the compose spec", () => {
    const cases: [string, string][] = [
      ["${SET}", "value"],
      ["$SET/x", "value/x"],
      ["${MISSING:-fallback}", "fallback"],
      ["${EMPTY:-fallback}", "fallback"],
      ["${EMPTY-fallback}", ""],
      ["${MISSING-fallback}", "fallback"],
      ["$$literal", "$literal"],
      ["${MISSING}", ""],
    ];
    for (const [input, expected] of cases) expect(interpolate(input, env).value).toBe(expected);
  });

  it("reports names that had no value and no default", () => {
    expect(interpolate("${A}-${B:-x}-${C}", env).missing.sort()).toEqual(["A", "C"]);
    expect(interpolate("${SET}", env).missing).toEqual([]);
  });
});

describe("parseDotenv", () => {
  it("handles the shapes people actually write", () => {
    const parsed = parseDotenv(
      [
        "# comment",
        "PLAIN=value",
        'QUOTED="with spaces"',
        "SINGLE='raw $VALUE'",
        "export EXPORTED=yes",
        "WITH_EQUALS=a=b",
        "TRAILING=value # not a comment marker inside quotes",
        "",
        "not a line",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "value",
      QUOTED: "with spaces",
      SINGLE: "raw $VALUE",
      EXPORTED: "yes",
      WITH_EQUALS: "a=b",
      TRAILING: "value",
    });
  });
});
