export type Opt = { key: string; text: string };

export type Item =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string }
  | { kind: "gap"; n: number; before?: string; after?: string }
  | { kind: "mcq"; n: number; prompt: string; options: Opt[] }
  | { kind: "multi"; ns: number[]; prompt: string; options: Opt[] }
  | { kind: "select"; n: number; prompt: string }
  | { kind: "tfng"; n: number; prompt: string };

export type Group = {
  id: string;
  range: string;
  instructions: string;
  title?: string;
  /** Options shared by every "select" item in the group (matching tasks). */
  options?: Opt[];
  optionsTitle?: string;
  /** TRUE/FALSE/NOT GIVEN or YES/NO/NOT GIVEN */
  tfng?: "TFNG" | "YNNG";
  /** Render gap items as a boxed form / notes sheet */
  boxed?: boolean;
  items: Item[];
};

export type ScriptLine = { s: string; t: string };

export type ListeningPart = {
  id: string;
  title: string;
  context: string;
  speakers: Record<string, { gender: "f" | "m"; pitch?: number; rate?: number }>;
  script: ScriptLine[];
  /** Number of script lines (set when the script itself is withheld from the client). */
  lines?: number;
  groups: Group[];
};

export type Passage = {
  id: string;
  title: string;
  subtitle?: string;
  paragraphs: { label?: string; text: string }[];
  groups: Group[];
};

export type WritingTask = {
  id: "task1" | "task2";
  title: string;
  minutes: number;
  minWords: number;
  prompt: string[];
  chart?: {
    title: string;
    yLabel: string;
    years: number[];
    series: { name: string; values: number[] }[];
    note?: string;
  };
};

export type SpeakingPart =
  | { id: "part1"; title: string; intro: string; topics: { topic: string; questions: string[] }[] }
  | { id: "part2"; title: string; intro: string; cue: { topic: string; points: string[]; closing: string }; prepSeconds: number; talkSeconds: number; followUp: string }
  | { id: "part3"; title: string; intro: string; topics: { topic: string; questions: string[] }[] };

export type QuestionType =
  | "form-completion"
  | "multiple-choice"
  | "matching"
  | "note-completion"
  | "true-false-not-given"
  | "yes-no-not-given"
  | "matching-headings"
  | "summary-completion"
  | "matching-features"
  | "sentence-endings";

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  "form-completion": "Form completion",
  "multiple-choice": "Multiple choice",
  matching: "Matching",
  "note-completion": "Note completion",
  "true-false-not-given": "True / False / Not Given",
  "yes-no-not-given": "Yes / No / Not Given",
  "matching-headings": "Matching headings",
  "summary-completion": "Summary completion",
  "matching-features": "Matching features",
  "sentence-endings": "Sentence endings",
};

export type KeyEntry = {
  answers: string[];
  type: QuestionType;
  /** Set for "choose TWO" questions: all question numbers that share the answer set. */
  set?: number[];
  /** Part / passage number, for breakdowns. */
  part: number;
};

export type SectionName = "listening" | "reading" | "writing" | "speaking";
