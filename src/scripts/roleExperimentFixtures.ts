// Fixed inputs for the role experiments.
//
// CHECKED IN, not fetched live, on purpose: a live fetch hands every run
// different source material, and two runs of a comparison that used different
// evidence cannot be compared at all. Live-material comparisons belong in
// `npm run test:model-ab`, which exists for exactly that.
//
// Three episode SITUATIONS, because dialogue models fail differently depending on
// what the scene asks for. A model that handles an evidence-dense argument well
// can still flatten a character-revealing exchange into analysis, or kill a
// comic rhythm with essay sentences. One scenario would hide that.

export interface EpisodeSituation {
  key: "evidence_heavy" | "character_revealing" | "fast_humorous";
  label: string;
  /** What this situation is testing for. */
  tests: string;
  episodeTitle: string;
  targetDuration: number;
  topicsPrompts: string;
  /** Prior-movement transcript, so continuity is part of the comparison. */
  previousMovement: string;
  /** Relationship/argument state carried in. */
  continuityState: string;
}

export const PERSONA_PROMPT = `You are writing dialogue for "Take Machine", a two-host sports debate podcast.

ZABALA — Bernadette "Line Two" Zabala. Former talk-radio call screener. Structural, procedural, keeps receipts, distrusts narrative. Speaks in short declaratives and asks one precise question too many. Never raises her voice; lands the knife quietly.

MULKEY — Dutch "Attendance" Mulkey. Ex-minor-league promotions guy. Sentimental, anecdotal, inflates his own numbers, changes the subject when cornered. Long looping sentences, sudden specificity when he is telling the truth.

HOW REAL PODCAST SPEECH WORKS
Write spoken language, not prose. No greetings, no episode summary, no signposting.`;

export const HOST_NAMES = ["Zabala", "Mulkey"];

export const SITUATIONS: EpisodeSituation[] = [
  {
    key: "evidence_heavy",
    label: "Evidence-heavy disagreement",
    tests:
      "Can the model argue from a dense fact set without fabricating a number, and keep two positions distinct while both cite the same evidence?",
    episodeTitle: "The Aldana option",
    targetDuration: 10,
    topicsPrompts: `
Topic #1: Should a 3-1 team fire the coordinator who built its only losing quarter?
Sport/League: Football / NFL
Main Angle: The Ridgeline Foxes are 3-1 but their defense allowed 24 points in the fourth quarter of Week 4 alone.
Why It Matters RIGHT NOW: Ownership meets Thursday; the coordinator's contract option date is Friday.
Strongest Debate Question: Does one collapsed quarter justify firing the person who built four winning ones?
Zabala Debate Stance: Process over outcome — the fourth-quarter scheme was identical to the three that worked; the sample is one quarter.
Mulkey Debate Stance: Perception is the product — a fanbase that watched a 17-point lead die does not care about sample size.
Key Grounded Facts: [
  {"text":"Ridgeline is 3-1 after four games.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Ridgeline allowed 24 points in the fourth quarter of Week 4.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Ridgeline led 24-7 entering the fourth quarter of Week 4.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"high"},
  {"text":"Coordinator Ray Aldana has a contract option that must be exercised Friday.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"high"},
  {"text":"Aldana's units ranked 6th in points allowed over the prior two seasons.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"medium"},
  {"text":"Ownership scheduled a football-operations meeting for Thursday.","evidenceRefs":[{"type":"newsItem","id":"news-2"}],"confidence":"high"},
  {"text":"Ridgeline's defense faced 19 fourth-quarter snaps in Week 4.","evidenceRefs":[{"type":"newsItem","id":"news-1"}],"confidence":"medium"},
  {"text":"Two starting cornerbacks left the Week 4 game before the fourth quarter.","evidenceRefs":[{"type":"injury","id":"inj-1"}],"confidence":"high"}
]
On-Air Talking Points: [{"text":"A 17-point fourth-quarter lead evaporated in twelve minutes.","evidenceRefs":[{"type":"newsItem","id":"news-1"}]}]
Suggested Counter-arguments: [{"host":"Zabala","claim":"One quarter is not a body of evidence."},{"host":"Mulkey","claim":"The option date, not the film, is what forces this."}]
Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ["Aldana has already been told he is being let go."]
`,
    previousMovement: `ZABALA: Nineteen snaps. That's the entire body of evidence you're firing a man over.
MULKEY: Nineteen snaps that ended a season, potentially—
ZABALA: Potentially. Say the quiet part.`,
    continuityState: JSON.stringify(
      {
        emotionalTemperature: "warming",
        unresolvedThreads: ["Does the option date, not the film, decide this?"],
        positionShifts: [],
        callbacksAvailable: ["nineteen snaps"],
        relationshipChange: "Zabala has caught Mulkey hedging and has not let it go.",
      },
      null,
      2
    ),
  },
  {
    key: "character_revealing",
    label: "Emotional / character-revealing disagreement",
    tests:
      "Can the model let a disagreement expose something personal without collapsing into therapy-speak, and keep the two voices asymmetric when the scene is quiet?",
    episodeTitle: "The attendance number",
    targetDuration: 8,
    topicsPrompts: `
Topic #1: Is a minor-league franchise that inflates its attendance lying, or selling?
Sport/League: Baseball / Minor League
Main Angle: The Calder Bats reported 6,492 at a game a league audit put at 5,200.
Why It Matters RIGHT NOW: The league's new reporting rule takes effect next month.
Strongest Debate Question: Where is the line between promotion and a lie?
Zabala Debate Stance: A number stated as fact is a claim, and a claim that is wrong is a lie regardless of intent.
Mulkey Debate Stance: Every promotions department he ever worked in rounded up, and the rounding is what kept the lights on.
Key Grounded Facts: [
  {"text":"The Calder Bats reported attendance of 6,492 for the June 14 game.","evidenceRefs":[{"type":"newsItem","id":"news-3"}],"confidence":"high"},
  {"text":"A league audit counted 5,200 attendees at the same game.","evidenceRefs":[{"type":"newsItem","id":"news-3"}],"confidence":"high"},
  {"text":"The league's mandatory turnstile-reporting rule takes effect July 1.","evidenceRefs":[{"type":"newsItem","id":"news-4"}],"confidence":"high"},
  {"text":"Mulkey worked in Calder's promotions department from 2009 to 2014.","evidenceRefs":[{"type":"newsItem","id":"news-4"}],"confidence":"high"}
]
On-Air Talking Points: [{"text":"A 1,292-seat gap between the announcement and the audit.","evidenceRefs":[{"type":"newsItem","id":"news-3"}]}]
Suggested Counter-arguments: [{"host":"Zabala","claim":"Intent does not change whether a number is true."},{"host":"Mulkey","claim":"The gap is the job, not the crime."}]
Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ["Calder's front office has been fined."]
`,
    previousMovement: `MULKEY: I've announced a number I knew was wrong. More than once.
ZABALA: I know.
MULKEY: You've never asked me about it.`,
    continuityState: JSON.stringify(
      {
        emotionalTemperature: "settling",
        unresolvedThreads: ["Why has Zabala never asked Mulkey about his own inflated numbers?"],
        positionShifts: ["Mulkey has admitted, unprompted, to doing the thing under discussion."],
        callbacksAvailable: ["you've never asked me about it"],
        relationshipChange: "Mulkey has exposed himself and is waiting to see what Zabala does with it.",
      },
      null,
      2
    ),
  },
  {
    key: "fast_humorous",
    label: "Fast, humorous sports discussion",
    tests:
      "Can the model hold a comic rhythm — short turns, interruptions, a callback that lands — without stapling jokes on or writing essay sentences?",
    episodeTitle: "The mascot suspension",
    targetDuration: 6,
    topicsPrompts: `
Topic #1: A mascot got a two-game suspension. Is that a real punishment?
Sport/League: Basketball / NBA
Main Angle: The Harlow Comets' mascot was suspended two games for firing a t-shirt cannon at a referee.
Why It Matters RIGHT NOW: The mascot is appealing.
Strongest Debate Question: Can you suspend a costume?
Zabala Debate Stance: There is a person in there, and a person can be disciplined; the costume is irrelevant.
Mulkey Debate Stance: The mascot IS the institution, and suspending it punishes children.
Key Grounded Facts: [
  {"text":"The Harlow Comets' mascot received a two-game suspension.","evidenceRefs":[{"type":"newsItem","id":"news-5"}],"confidence":"high"},
  {"text":"The suspension followed a t-shirt cannon being fired toward a referee.","evidenceRefs":[{"type":"newsItem","id":"news-5"}],"confidence":"high"},
  {"text":"The mascot's appeal is scheduled for review.","evidenceRefs":[{"type":"newsItem","id":"news-5"}],"confidence":"medium"}
]
On-Air Talking Points: [{"text":"Two games, one cannon.","evidenceRefs":[{"type":"newsItem","id":"news-5"}]}]
Suggested Counter-arguments: [{"host":"Zabala","claim":"The costume is not the defendant."},{"host":"Mulkey","claim":"Try explaining a suspended mascot to a seven-year-old."}]
Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ["The referee was injured."]
`,
    previousMovement: `ZABALA: Two games.
MULKEY: For a cannon!
ZABALA: For a cannon aimed at a man whose job is to be aimed at.`,
    continuityState: JSON.stringify(
      {
        emotionalTemperature: "hot",
        unresolvedThreads: ["Is the person or the costume being punished?"],
        positionShifts: [],
        callbacksAvailable: ["for a cannon"],
        relationshipChange: "They are enjoying themselves and are about to overshoot.",
      },
      null,
      2
    ),
  },
];

// ---------------------------------------------------------------- verification

/**
 * SEEDED VERIFICATION SET with ground truth, covering every category the task
 * requires. `shouldFlag: true` means a real defect a verifier must catch;
 * `shouldFlag: false` means legitimate speech that a trigger-happy verifier
 * wrongly fails.
 *
 * False positives matter as much as false negatives here: an overactive verifier
 * rewrites valid dialogue, which damages the show while looking like diligence.
 */
export interface SeededLine {
  lineIndex: number;
  speakerName: string;
  text: string;
  isFactualClaim: boolean;
  tone: string;
  isInterruption?: boolean;
  shouldFlag: boolean;
  /** Which required category this line exercises. */
  category:
    | "supported_fact"
    | "contradicted_fact"
    | "unsupported_fact"
    | "reasonable_inference"
    | "opinion"
    | "prediction"
    | "rhetorical_exaggeration"
    | "character_violation"
    | "continuity_violation"
    | "duplicate_argument"
    | "correct_numerical_claim"
    | "incorrect_numerical_claim"
    | "unsafe_claim";
  note: string;
}

export const VERIFICATION_EVIDENCE = [
  "news-1: Ridgeline is 3-1 after four games. Ridgeline allowed 24 points in the fourth quarter of Week 4 after leading 24-7 entering it. Ridgeline's defense faced 19 fourth-quarter snaps in Week 4.",
  "news-2: Coordinator Ray Aldana has a contract option that must be exercised Friday. Aldana's units ranked 6th in points allowed over the prior two seasons. Ownership scheduled a football-operations meeting for Thursday.",
  "inj-1: Two starting cornerbacks left the Week 4 game before the fourth quarter.",
];

export const VERIFICATION_UNSAFE_CLAIMS = ["Aldana has already been told he is being let go."];

export const SEEDED_LINES: SeededLine[] = [
  {
    lineIndex: 0,
    speakerName: "Zabala",
    text: "They're 3-1. That's the whole record, four games.",
    isFactualClaim: true,
    tone: "analytical",
    shouldFlag: false,
    category: "supported_fact",
    note: "Directly supported by news-1.",
  },
  {
    lineIndex: 1,
    speakerName: "Zabala",
    text: "Nineteen fourth-quarter snaps. That's the sample you're firing him over.",
    isFactualClaim: true,
    tone: "analytical",
    shouldFlag: false,
    category: "correct_numerical_claim",
    note: "19 snaps is exactly what news-1 says.",
  },
  {
    lineIndex: 2,
    speakerName: "Mulkey",
    text: "Aldana's units finished second in points allowed two years running.",
    isFactualClaim: true,
    tone: "incredulous",
    shouldFlag: true,
    category: "incorrect_numerical_claim",
    note: "Evidence says 6th, not 2nd. A verifier must catch the wrong figure.",
  },
  {
    lineIndex: 3,
    speakerName: "Mulkey",
    text: "They gave up thirty-one in that quarter and everybody watched it.",
    isFactualClaim: true,
    tone: "heated",
    shouldFlag: true,
    category: "unsupported_fact",
    note: "31 points appears nowhere in the evidence (the real figure is 24).",
  },
  {
    lineIndex: 4,
    speakerName: "Zabala",
    text: "They're 2-2, which is exactly the problem.",
    isFactualClaim: true,
    tone: "analytical",
    shouldFlag: true,
    category: "contradicted_fact",
    note: "Contradicts line 0 and the evidence outright.",
  },
  {
    lineIndex: 5,
    speakerName: "Zabala",
    text: "If the option date weren't Friday nobody would be having this conversation.",
    isFactualClaim: false,
    tone: "dismissive",
    shouldFlag: false,
    category: "reasonable_inference",
    note: "An inference drawn from a supported fact. Must NOT be failed.",
  },
  {
    lineIndex: 6,
    speakerName: "Mulkey",
    text: "I think they keep him, and I think it costs them the division.",
    isFactualClaim: false,
    tone: "reflective",
    shouldFlag: false,
    category: "prediction",
    note: "A prediction. Must NOT be treated as a factual error.",
  },
  {
    lineIndex: 7,
    speakerName: "Mulkey",
    text: "That defense was the worst thing I have seen in thirty years of football.",
    isFactualClaim: false,
    tone: "heated",
    shouldFlag: false,
    category: "rhetorical_exaggeration",
    note: "Obvious hyperbole in a debate show. Flagging it is a false positive.",
  },
  {
    lineIndex: 8,
    speakerName: "Zabala",
    text: "Firing a coordinator over one quarter is management by scoreboard.",
    isFactualClaim: false,
    tone: "dismissive",
    shouldFlag: false,
    category: "opinion",
    note: "Opinion, in character. Must NOT be failed.",
  },
  {
    lineIndex: 9,
    speakerName: "Mulkey",
    text: "Sources tell me he's already been informed he's gone.",
    isFactualClaim: true,
    tone: "excited",
    shouldFlag: true,
    category: "unsafe_claim",
    note: "Explicitly listed as an unusable claim, and dressed as sourced reporting.",
  },
  {
    lineIndex: 10,
    speakerName: "Zabala",
    text: "Nineteen fourth-quarter snaps. That's the sample you're firing him over.",
    isFactualClaim: true,
    tone: "analytical",
    shouldFlag: true,
    category: "duplicate_argument",
    note: "Verbatim repeat of line 1 — the same argument made twice.",
  },
  {
    lineIndex: 11,
    speakerName: "Zabala",
    text: "Honestly I don't care about the process, just fire somebody and let's move on.",
    isFactualClaim: false,
    tone: "dismissive",
    shouldFlag: true,
    category: "character_violation",
    note: "Zabala is the process host; this is Mulkey's position in her mouth.",
  },
  {
    lineIndex: 12,
    speakerName: "Mulkey",
    text: "Ownership meets Thursday, so the film has one more week to matter.",
    isFactualClaim: true,
    tone: "setup",
    shouldFlag: true,
    category: "continuity_violation",
    note: "Thursday precedes the Friday option date, so there is no extra week.",
  },
  {
    lineIndex: 13,
    speakerName: "Mulkey",
    text: "Two corners walked off before the fourth even started.",
    isFactualClaim: true,
    tone: "conceding",
    shouldFlag: false,
    category: "supported_fact",
    note: "Supported by inj-1. A verifier that misses this evidence will false-positive it.",
  },
];

export const VERIFICATION_CATEGORIES = [...new Set(SEEDED_LINES.map((l) => l.category))];
