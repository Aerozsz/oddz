import type { QuestionType } from "./test/types";

export type Student = { name: string; age: number; timezone: string };

export type ItemResult = {
  n: number;
  part: number;
  type: QuestionType;
  given: string;
  correct: string;
  ok: boolean;
};

export type ObjectiveScore = {
  raw: number;
  band: number;
  items: ItemResult[];
};

export type WritingGrade = { ta: number; cc: number; lr: number; gra: number };
export type SpeakingGrade = { fc: number; lr: number; gra: number; p: number };

export type Recording = { part: string; path: string; contentType: string; durationSec: number; size: number; uploadedAt: string };

export type Attempt = {
  id: string;
  token: string;
  status: "in_progress" | "submitted";
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  student: Student;
  currentStage: string;
  userAgent?: string;
  listening?: { answers: Record<string, string>; startedAt?: string; finishedAt?: string; timeUp?: boolean };
  reading?: { answers: Record<string, string>; startedAt?: string; finishedAt?: string; timeUp?: boolean };
  writing?: { task1: string; task2: string; startedAt?: string; finishedAt?: string; timeUp?: boolean };
  speaking?: { recordings: Recording[]; skipped?: boolean; skipReason?: string; startedAt?: string; finishedAt?: string; prepNotes?: string };
  scores?: { listening?: ObjectiveScore; reading?: ObjectiveScore };
  grading?: {
    task1?: WritingGrade;
    task2?: WritingGrade;
    speaking?: SpeakingGrade;
    writingBand?: number;
    speakingBand?: number;
    notes?: string;
    gradedAt?: string;
  };
};

/** The subset of an attempt shown in lists and summary exports. */
export type AttemptSummary = {
  id: string;
  status: Attempt["status"];
  name: string;
  age: number;
  timezone: string;
  createdAt: string;
  submittedAt?: string;
  durationMin?: number;
  listening?: { raw: number; band: number };
  reading?: { raw: number; band: number };
  writing?: number;
  speaking?: number;
  overall?: number;
  provisional: boolean;
  weakest?: string;
  stage: string;
};
