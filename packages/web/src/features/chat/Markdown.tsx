import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children: label, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{label}</a>,
        img: ({ alt }) => <span className="markdown-image-placeholder">[图片：{alt || "未命名"}]</span>
      }}
    >{children}</ReactMarkdown>
  </div>;
}
