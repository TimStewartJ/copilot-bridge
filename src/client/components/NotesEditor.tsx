import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
          className="w-full px-3 py-2 bg-[#1a1a2e] text-gray-200 border border-[#2a2a4a] rounded-md text-sm font-mono resize-y focus:outline-none focus:border-indigo-500"
          placeholder="Write notes in markdown..."
        />
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white text-xs rounded-md transition-colors"
          >
            Save
          </button>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-xs transition-colors"
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
        className="text-xs text-gray-600 hover:text-gray-400 px-3 py-2 transition-colors"
      >
        Click to add notes...
      </button>
    );
  }

  return (
    <div
      onClick={handleEdit}
      className="cursor-pointer px-3 py-2 bg-[#2a2a4a] rounded-md hover:bg-[#333366] transition-colors prose prose-invert prose-sm max-w-none
        prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1
        prose-pre:bg-[#1a1a2e] prose-pre:rounded-md prose-pre:p-2
        prose-code:text-indigo-300"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
    </div>
  );
}
