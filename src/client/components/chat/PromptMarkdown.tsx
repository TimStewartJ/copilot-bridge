import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import CodeBlock from "../CodeBlock";
import { APP_PROSE } from "../shared/prose-classes";

interface PromptMarkdownProps {
  content: string;
  /**
   * Text from outside the agent (an MCP server asking for input) is shown exactly as sent: a
   * prompt that asks the reader to act must not be able to dress a link up as something else.
   */
  trusted: boolean;
}

/** The body of a question the run is waiting on. The agent writes these in markdown. */
export default function PromptMarkdown({ content, trusted }: PromptMarkdownProps) {
  if (!trusted) {
    return (
      <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-primary">{content}</div>
    );
  }
  return (
    <div className={`ds-prose mt-1 max-w-none text-sm leading-6 text-text-primary ${APP_PROSE} prose-pre:bg-bg-surface prose-th:bg-bg-surface`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
