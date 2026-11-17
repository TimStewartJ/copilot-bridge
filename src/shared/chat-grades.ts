/** Which chats a view or grading run covers. Classifier, label and value names are open strings. */
export interface ChatGradesFilters {
  /** First and last local day (YYYY-MM-DD) a chat was active; open when absent. */
  from?: string;
  to?: string;
  /** Model ids (the model that did most of a chat's work); empty or absent means every model. */
  models?: string[];
  /** Include chats a trigger or schedule started. Off by default. */
  includeScheduled?: boolean;
}

/** Why a chat has no grade: no log, log too big, log the runtime rejected, or a failed call. */
export type ChatGradeSkipReason = "missing" | "too-large" | "invalid" | "error";

/** A model used in the date range, with how many chats in the range it did most of the work of. */
export interface ChatGradesModelOption {
  id: string;
  /** The catalog's name for the model (Copilot Fusion for `auto`), or its id. */
  name: string;
  chats: number;
}

/** The grading run. Kept in memory: a restart ends a run, saved grades stay. */
export interface ChatGradesRunStatus {
  running: boolean;
  /** Chats the current or last run set out to grade, and how many it has finished. */
  total: number;
  done: number;
  finishedAt?: string;
}

export interface ChatGradesValueCount {
  value: string;
  count: number;
}

/** One model's bar for one classifier. */
export interface ChatGradesModelSeries {
  model: string;
  /** Graded chats with at least one counted unit. */
  chats: number;
  /** Units counted (whatever the classifier's scope is); the sum of `values`. */
  units: number;
  /** Input and output tokens the judge models used for this classifier on these chats. */
  judgeTokens: number;
  values: ChatGradesValueCount[];
}

export interface ChatGradesClassifier {
  classifier: string;
  /** The unit counted: session, task, turn or prompt. */
  scope: string;
  /** The label key charted when the classifier reports several. */
  label: string;
  models: ChatGradesModelSeries[];
}

/** A graded chat behind the chart. Never transcript text. */
export interface ChatGradesChat {
  sessionId: string;
  title: string;
  model: string;
  /** The last local day (YYYY-MM-DD) in the range the chat was active, or "" when unknown. */
  date: string;
  /** Per classifier, the charted label's values in the chat's counted units. */
  labels: Record<string, string[]>;
}

export interface ChatGradesReport {
  classifiers: ChatGradesClassifier[];
  chats: ChatGradesChat[];
}

/** GET /api/chat-grades */
export interface ChatGradesView {
  matching: number;
  graded: number;
  /** Matching chats a run would grade: no grade yet, or the last attempt failed. */
  ungraded: number;
  /** Matching chats that could not be graded: no log, too large, or a log the runtime rejected. */
  skipped: number;
  models: ChatGradesModelOption[];
  run: ChatGradesRunStatus;
  report: ChatGradesReport;
}
