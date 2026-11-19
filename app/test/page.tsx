import type { Metadata } from "next";
import TestApp from "@/components/test/TestApp";
import { listening, reading, speaking, writing, TEST_META } from "@/lib/test";
import { SITE } from "@/lib/site";

export const metadata: Metadata = { title: "Take the test", robots: { index: false } };

export default function TestPage() {
  // Only question content is sent to the browser; the answer key stays on the server.
  const listeningPublic = listening.map((p) => ({ ...p, script: [] as typeof p.script, lines: p.script.length }));
  return <TestApp content={{ listening: listeningPublic, reading, writing, speaking, timing: TEST_META.timing, siteName: SITE.name, teacher: SITE.teacher }} />;
}
