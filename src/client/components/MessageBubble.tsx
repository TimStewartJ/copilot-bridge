import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../api";

interface MessageBubbleProps {
  message: ChatMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-4 py-3 bg-indigo-500 text-white rounded-2xl rounded-br-sm text-sm leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start min-w-0">
      <div className="max-w-[85%] min-w-0 break-words px-4 py-3 bg-[#2a2a4a] text-gray-200 rounded-2xl rounded-bl-sm text-sm leading-relaxed prose prose-invert prose-sm
        prose-pre:bg-[#1a1a2e] prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
        prose-code:text-indigo-300 prose-code:text-xs prose-code:font-mono
        prose-th:border prose-th:border-gray-600 prose-th:px-3 prose-th:py-1.5 prose-th:bg-[#1a1a2e]
        prose-td:border prose-td:border-gray-600 prose-td:px-3 prose-td:py-1.5
        prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
        prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline
        prose-headings:mt-3 prose-headings:mb-1
        prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
        prose-li:my-0.5">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
