import {
  BookOpen,
  Bot,
  Clock,
  Database,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  Image,
  ListTodo,
  MessageCircleQuestionMark,
  MousePointerClick,
  Paperclip,
  Rocket,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolIconName } from "../../lib/tool-presentation";

const TOOL_ICONS: Record<ToolIconName, LucideIcon> = {
  terminal: SquareTerminal,
  file: FileText,
  "file-plus": FilePlus,
  "file-pen": FilePen,
  search: Search,
  "folder-search": FolderSearch,
  globe: Globe,
  sparkles: Sparkles,
  database: Database,
  question: MessageCircleQuestionMark,
  agent: Bot,
  book: BookOpen,
  tasks: ListTodo,
  clock: Clock,
  pointer: MousePointerClick,
  image: Image,
  paperclip: Paperclip,
  rocket: Rocket,
  tool: Wrench,
};

export default function ToolIcon({ name, size = 14, className }: {
  name: ToolIconName;
  size?: number;
  className?: string;
}) {
  const Icon = TOOL_ICONS[name];
  return <Icon size={size} className={className} aria-hidden="true" />;
}
