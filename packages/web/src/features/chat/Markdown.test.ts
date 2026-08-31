import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.js";

const render = (source: string) => renderToStaticMarkup(createElement(Markdown, null, source));

describe("assistant Markdown", () => {
  it("renders common Markdown and GFM structures", () => {
    const html = render(`## Result

- [x] built
- **verified**

| Item | State |
| --- | --- |
| test | pass |

\`inline\`

\`\`\`ts
const ok = true;
\`\`\``);
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("<strong>verified</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain("language-ts");
  });

  it("does not inject raw HTML or load Markdown images", () => {
    const html = render(`<script>alert(1)</script>

![remote](https://example.invalid/private.png)

[safe](https://example.com)`);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("[图片：remote]");
    expect(html).toContain("target=\"_blank\"");
    expect(html).toContain("rel=\"noreferrer noopener\"");
  });
});
