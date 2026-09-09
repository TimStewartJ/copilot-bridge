export type SearchScope = "global" | "task" | "session";
export type SearchKind = "all" | "chat" | "task" | "doc";

export interface BridgeSearchRequest {
  q: string;
  scope?: SearchScope;
  taskId?: string;
  sessionId?: string;
  kind?: SearchKind;
  limit?: number;
  /** Pages matching messages in session scope; grouped results in other scopes. */
  offset?: number;
}

export interface SearchMessageMatch {
  sourceEventId: string;
  role: "user" | "assistant";
  timestamp?: string;
  snippet: string;
}

export interface SearchChatHit {
  sessionId: string;
  title: string;
  taskId?: string;
  taskTitle?: string;
  archived: boolean;
  matches: SearchMessageMatch[];
  matchCount: number;
}

export interface SearchTaskHit {
  taskId: string;
  title: string;
  snippet: string;
  archived: boolean;
}

export interface SearchDocHit {
  path: string;
  title: string;
  snippet: string;
}

export interface SearchSection<T> {
  items: T[];
  total: number;
}

export interface BridgeSearchResponse {
  chats: SearchSection<SearchChatHit>;
  tasks: SearchSection<SearchTaskHit>;
  docs: SearchSection<SearchDocHit>;
  coverage: {
    state: "ready" | "indexing" | "partial";
    indexedSessions: number;
    totalSessions: number;
    errors: string[];
  };
}
