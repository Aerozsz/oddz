import type { SpeakingPart, WritingTask } from "./types";

export const writing: WritingTask[] = [
  {
    id: "task1",
    title: "Writing Task 1",
    minutes: 20,
    minWords: 150,
    prompt: [
      "The graph below shows the percentage of electricity generated from renewable sources in four countries between 2000 and 2025.",
      "Summarise the information by selecting and reporting the main features, and make comparisons where relevant.",
      "Write at least 150 words.",
    ],
    chart: {
      title: "Electricity generated from renewable sources (% of total), 2000–2025",
      yLabel: "%",
      years: [2000, 2005, 2010, 2015, 2020, 2025],
      series: [
        { name: "Portugal", values: [30, 22, 50, 48, 58, 71] },
        { name: "Germany", values: [6, 10, 17, 30, 44, 55] },
        { name: "Australia", values: [9, 9, 9, 14, 24, 38] },
        { name: "Japan", values: [10, 11, 10, 15, 20, 26] },
      ],
      note: "Figures adapted for practice purposes.",
    },
  },
  {
    id: "task2",
    title: "Writing Task 2",
    minutes: 40,
    minWords: 250,
    prompt: [
      "Some people believe that unpaid community service, such as helping in hospitals or cleaning public spaces, should be a compulsory part of secondary school education.",
      "To what extent do you agree or disagree?",
      "Give reasons for your answer and include any relevant examples from your own knowledge or experience.",
      "Write at least 250 words.",
    ],
  },
];

export const speaking: SpeakingPart[] = [
  {
    id: "part1",
    title: "Part 1 — Introduction and interview",
    intro: "The examiner will ask you some questions about yourself and familiar topics. Answer each question in 2–4 sentences. This part lasts about 4–5 minutes.",
    topics: [
      { topic: "Your home", questions: ["Let's talk about where you live. Do you live in a house or an apartment?", "What do you like most about your home?", "Is there anything you would like to change about it?", "Do you think you will live in the same place in five years' time?"] },
      { topic: "Reading", questions: ["Now let's talk about reading. Do you enjoy reading?", "What kinds of things do you usually read?", "Did you read a lot when you were a child?", "Do you prefer reading on paper or on a screen? Why?"] },
    ],
  },
  {
    id: "part2",
    title: "Part 2 — Long turn",
    intro: "You will be given a topic card. You have one minute to prepare and make notes, then you should speak for one to two minutes.",
    cue: {
      topic: "Describe a skill that took you a long time to learn.",
      points: ["what the skill is", "when and how you learned it", "what difficulties you had while learning it"],
      closing: "and explain how you feel about this skill now.",
    },
    prepSeconds: 60,
    talkSeconds: 120,
    followUp: "Do you think you will teach this skill to anyone else?",
  },
  {
    id: "part3",
    title: "Part 3 — Discussion",
    intro: "The examiner will ask you more abstract questions linked to the Part 2 topic. Give longer, developed answers with reasons and examples. This part lasts about 4–5 minutes.",
    topics: [
      { topic: "Learning skills", questions: ["What skills do you think are most important for young people to learn today?", "Is it better to learn a skill from a teacher or by yourself, for example from online videos?", "Why do some people give up when they are learning something new?"] },
      { topic: "Skills and work", questions: ["How have the skills employers want changed in recent years?", "Do you think schools prepare students well enough for the world of work?", "In the future, will people need to keep learning new skills throughout their lives? Why?"] },
    ],
  },
];
