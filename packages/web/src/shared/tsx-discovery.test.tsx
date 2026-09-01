import { describe, expect, it } from "vitest";

describe("Vitest TSX discovery", () => {
  it("collects adjacent TSX tests through the repository configuration", () => {
    const element = <span data-source="tsx">discovered</span>;
    expect(element.props).toMatchObject({ "data-source": "tsx", children: "discovered" });
  });
});
