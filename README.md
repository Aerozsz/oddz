# IELTS Mock Test

A full-length IELTS Academic mock test site for a private teacher. Students take a timed test (Listening, Reading, Writing, Speaking); the teacher reviews, grades and exports results from a password-protected dashboard.

All test content is original practice material written in the IELTS Academic format.

## Pages

| Path | Who | What |
|---|---|---|
| `/` | Students | Landing page: what's in the test, set-up checklist, FAQ |
| `/test` | Students | Details (name, age, time zone) → system check → Listening (35 min) → Reading (60 min) → Writing (60 min) → Speaking (recorded) → submit |
| `/admin` | Teacher | All attempts, status filters, search, sort, summary and detailed CSV exports |
| `/admin/s/:id` | Teacher | Per-student report: band scores, accuracy by question type, every answer, essays, speaking recordings, grading forms, notes, print/PDF |

## How scoring works

- **Listening & Reading** are marked automatically on the server using standard IELTS Academic raw-score-to-band tables. The answer key (`lib/test/key.ts`) never reaches the browser.
- **Writing**: the teacher scores each task on the four official criteria. Task band = average of the criteria; Writing band = (Task 1 + 2 × Task 2) / 3.
- **Speaking**: the teacher scores the four official criteria from the recordings.
- **Overall** = average of the four skills, rounded to the nearest half band. It is marked *provisional* until all four are graded.

## Exports

- **Summary CSV**: one row per student, with all band scores, raw scores, CEFR estimate, weakest question type and teacher notes.
- **Detailed CSV**: one row per question per student (student answer, correct answer, result), plus per-type accuracy, essays with word counts, speaking grades and notes.
- **Print / PDF**: a full report for each student, from the student page.

You can export everyone, or tick students in the table to export only those.

## Configuration

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin` |
| `SESSION_SECRET` | Random string used to sign the admin cookie |
| `BLOB_READ_WRITE_TOKEN` | Set automatically when a Vercel Blob store is connected. Results and recordings are stored **privately** there. Without it, data goes to `./.data` (local development only). |
| `NEXT_PUBLIC_SITE_NAME` | Optional: site name (default "IELTS Mock Test") |
| `NEXT_PUBLIC_TEACHER_NAME` | Optional: how students see you, e.g. "Ms Rivera" (default "your teacher") |

## Development

```bash
npm install
ADMIN_PASSWORD=dev SESSION_SECRET=dev npm run dev
```

## Notes

- Listening audio uses the browser's built-in text-to-speech, with different voices for different speakers. Chrome, Edge and Safari on desktop sound best.
- Speaking answers are recorded in the browser and uploaded after each part. If a student can't use a microphone, they can skip the recorded test so it can be done live.
- Progress is saved on the server as the student works, and also on their device, so a closed tab can be resumed on the same browser.
- To change the test, edit `lib/test/listening.ts`, `reading.ts`, `writing-speaking.ts` and the matching answers in `key.ts`.
