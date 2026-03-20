import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

interface NotesEditorProps {
  value: string;
  onSave: (notes: string) => void;
}

export default function NotesEditor({ value, onSave }: NotesEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const handleEdit = () => {
    setDraft(value);
    setEditing(true);
  };

  const handleSave = () => {
    onSave(draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          rows={8}
          className="w-full px-3 py-2 bg-bg-primary text-text-primary border border-border rounded-md text-sm font-mono resize-y focus:outline-none focus:border-accent"
          placeholder="Write notes in markdown..."
        />
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs rounded-md transition-colors"
          >
            Save
          </button>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-text-muted hover:text-text-primary text-xs transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (!value) {
    return (
      <button
        onClick={handleEdit}
        className="text-xs text-text-faint hover:text-text-muted px-3 py-2 transition-colors"
      >
        Click to add notes...
      </button>
    );
  }

  return (
    <div
      onClick={handleEdit}
      className="cursor-pointer px-3 py-2 bg-bg-surface rounded-md hover:bg-bg-hover transition-colors prose prose-invert prose-sm max-w-none
        prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1
        prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
        prose-pre:bg-bg-primary prose-pre:rounded-md prose-pre:p-2
        prose-code:text-accent
        prose-a:text-accent prose-a:no-underline hover:prose-a:underline"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{value}</ReactMarkdown>
    </div>
  );
}
