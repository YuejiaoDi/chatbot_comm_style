// server.js — Node18+ fetch (CommonJS)
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");

dotenv.config();
const dialogues = require("./4_types_bots");

const app = express();
const corsOptions = {
  origin: function (origin, callback) {
    // allow curl/postman or same-origin
    if (!origin) return callback(null, true);

    // ✅ allow Netlify（你的前端域名）
    if (origin === "https://chatbotexp.netlify.app") return callback(null, true);

    // ✅ 如果你以后 Netlify 换了站点名，也可以保留这个兜底
    if (origin.endsWith(".netlify.app")) return callback(null, true);

    // allow Qualtrics
    if (origin.includes("qualtrics.com") || origin.includes("qualtricsusercontent.com")) {
      return callback(null, true);
    }

    // allow local dev
    if (origin.startsWith("http://localhost")) return callback(null, true);

    // otherwise block
    return callback(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors(corsOptions));
// ✅ 关键：preflight(OPTIONS) 也必须走同一套 corsOptions
app.options("*", cors(corsOptions));


// =====================
// 0) Definitions placeholders
// =====================
const DEFINITIONS = {
  collaborative:
    "<<DEFINITION: focus on shared problem solving and co-construction on the decision-making>>",
  directive:
    "<<DEFINITION:focus on instructive, prescriptive, authoritative, and dominant language that tells participants what to do.  >>",
  emotionalSupport: "<<DEFINITION: showing care, concern, and interest in conversations>>",
  noEmotionalSupport: "<<DEFINITION: no emotional support language>>",
};

// =====================
// 1) Session store
// =====================
const sessions = new Map();

// 4-condition pool for random assignment
const CONDITION_POOL = [
  "collaborative_noES",
  "directive_noES_type2",
  "collaborative_ES",
  "directive_ES_type4",
];

function getSessionId(req) {
  // allow sessionId from body or query (useful for Qualtrics)
  const b = req.body || {};
  return String(b.sessionId || req.query.sessionId || "test");
}

function normalize(text) {
  return String(text || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// =====================
// ES sentences (Type3 follow-ups only)
// =====================
const ES_SENTENCES = {
  worried: "It's understandable to feel worried about this situation.",
  understand: "I understand.",
  timeToFigure: "It’s usual to take some time to figure out what doesn’t quite fit.",
  makesSense: "That makes sense.",
  concern: "I understand your concern.",
  reasonableSingle: "It's a reasonable question.",
  reasonableMulti: "These are reasonable questions.",
};

// Detect follow-up intent by pragmatic function (NOT by grammar form)
function pickESForType3Followup(userText, session) {
  const raw = String(userText || "").trim();
  const t = normalize(raw);

  // --- helpers ---
  const qMarks = (raw.match(/\?/g) || []).length;

  // A) Directive elaboration requests: user is directing expansion of an option
  // e.g., "tell me more about the second one", "give an example for option A"
  const isDirectiveElaboration =
    /\b(tell\s+me\s+more|more\s+details?|more\s+information|expand\s+on|elaborate\s+on|go\s+deeper|give\s+(me\s+)?(an\s+)?example|examples?)\b/i.test(
      t
    );

  // B) Need/constraint/preference (you already extract these into memory, but we also detect directly)
  const hasNeedOrConstraint =
    /\b(my\s+real\s+need\s+is|what\s+i\s+really\s+need\s+is|i\s+need|i\s+want|i\s+prefer|i\s+don'?t\s+want|i\s+do\s+not\s+want)\b/i.test(
      t
    ) ||
    !!extractUserNeed(raw) ||
    !!extractUserPreference(raw);

  // C) Inability / difficulty / "how to do it" (can be declarative OR interrogative)
  const hasStrongInability =
    /\b(i\s+can'?t|i\s+cannot|doesn'?t\s+work|won'?t\s+work|impossible|no\s+way|i\s+have\s+no\s+idea|i\s+don'?t\s+know\s+how)\b/i.test(
      t
    );

  const hasMildDifficulty =
    /\b(not\s+sure\s+how|not\s+sure|unsure|confused|stuck|hard\s+to)\b/i.test(t);

  // D) Questioning stance (true question): asking for evaluation/clarification, not directing expansion
  // We EXCLUDE directive elaboration even if it "sounds like a request".
  const startsLikeQuestion =
    /^(what|why|how|which|who|when|where|can|could|would|should|is|are|do|does)\b/i.test(t);

  const hasQuestionIntent =
    /\b(what\s+do\s+you\s+mean|meaning|clarify|define|definition|why|how|which|what\s+is|what\s+are|what\s+should\s+i\s+do|which\s+one|how\s+can\s+i)\b/i.test(
      t
    );

  const isQuestioningStance =
    !isDirectiveElaboration && (qMarks > 0 || startsLikeQuestion || hasQuestionIntent);

  // Multiple-questions: only for questioning stance
  const qWordCount = (t.match(/\b(what|why|how|which|who|when|where)\b/gi) || []).length;
  const isMultipleQuestions = isQuestioningStance && (qMarks >= 2 || qWordCount >= 2);

  // E) Distress/worry (optional narrow trigger for sentence #1)
  const hasWorried = /\b(worried|anxious|anxiety|panic)\b/i.test(t);

  // --- priority order (top wins) ---
  if (isMultipleQuestions) {
    return { es: ES_SENTENCES.reasonableMulti, forbidReasonable: false };
  }

  // Directive elaboration: do NOT use reasonable question
  if (isDirectiveElaboration) {
    return { es: ES_SENTENCES.makesSense, forbidReasonable: true };
  }

  // Strong inability/difficulty: use "time to figure out"
  if (hasStrongInability) {
    return { es: ES_SENTENCES.timeToFigure, forbidReasonable: true };
  }

  // Needs/constraints: "concern"
  if (hasNeedOrConstraint) {
    return { es: ES_SENTENCES.concern, forbidReasonable: true };
  }

  // Mild difficulty
  if (hasMildDifficulty) {
    return { es: ES_SENTENCES.makesSense, forbidReasonable: true };
  }

  // Worried: only if explicitly worried/anxious/panic (narrow)
  if (hasWorried) {
    return { es: ES_SENTENCES.worried, forbidReasonable: true };
  }

  // True question (single)
  if (isQuestioningStance) {
    return { es: ES_SENTENCES.reasonableSingle, forbidReasonable: false };
  }

  // Default
  return { es: ES_SENTENCES.understand, forbidReasonable: true };
}

// =====================
// Slot 2 stressor phrase helpers (general; NO reason)
// =====================
function cleanIssuePhrase(issue) {
  let s = String(issue || "").trim();
  if (!s) return "";

  // remove common stress wrappers
  s = s.replace(/^i['’]?\s*m\s+(really\s+)?(so\s+)?(stressed|stressful|worried|anxious)\s+about\s+/i, "");
  s = s.replace(/^i\s+am\s+(really\s+)?(so\s+)?(stressed|stressful|worried|anxious)\s+about\s+/i, "");
  s = s.replace(/^about\s+/i, "");

  // remove possessive determiners
  s = s.replace(/\b(my|your|our|his|her|their)\b\s+/gi, "");

  // strip trailing punctuation
  s = s.replace(/[.?!]\s*$/g, "");

  // normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// =====================
// Slot0 topic extractor (for Slot1 & Slot2 reuse)
// =====================
function extractTopicFromSlot0(userText) {
  let s = String(userText || "").trim();
  if (!s) return "";

  // Keep the part before explanations (e.g., semicolon)
  s = s.split(/;\s*/)[0];

  // Remove stress statements
  s = s.replace(/\bis\s+(really\s+)?(so\s+)?(very\s+)?(stressed|stressful|worried|anxious)\b.*$/i, "");
  s = s.replace(/\bi['’]?\s*m\s+(really\s+)?(so\s+)?(very\s+)?(stressed|stressful|worried|anxious)\b.*$/i, "");
  s = s.replace(/\bi\s+am\s+(really\s+)?(so\s+)?(very\s+)?(stressed|stressful|worried|anxious)\b.*$/i, "");

  // Clean punctuation
  s = s.replace(/[.?!]\s*$/g, "").trim();

  // Remove leading "about"
  s = s.replace(/^about\s+/i, "").trim();

  return s;
}

// =====================
// Topic language normalization helper
// =====================
function normalizeTopicPhrase(topic) {
  let t = String(topic || "").trim();
  if (!t) return "";

  // Fix common verb + material noun errors
  const verbNounFixes = [
    { re: /\bquit(ting)?\s+smoke\b/i, replace: "quitting smoking" },
    { re: /\bstop(ping)?\s+smoke\b/i, replace: "stopping smoking" },
    { re: /\bavoid(ing)?\s+smoke\b/i, replace: "avoiding smoking" },
  ];

  for (const { re, replace } of verbNounFixes) {
    if (re.test(t)) {
      return t.replace(re, replace);
    }
  }

  return t;
}

function classifyQuestionForFollowup(userText) {
  const raw = String(userText || "").trim();
  const t = normalize(raw);

  // (a) question marks
  const qMarks = (raw.match(/\?/g) || []).length;

  // (b) starts like a direct question (even without ?)
  const startsLikeQuestion =
    /^(what|why|how|which|who|when|where|can|could|would|should|is|are|do|does)\b/i.test(t);

  // (c) common “question intent” phrases even if not at start
  // e.g., "tell me how to...", "can you explain...", "what is X"
  const hasQuestionIntent =
    /\b(can\s+you|could\s+you|would\s+you|please\s+explain|explain|clarify|define|definition|meaning|what\s+is|what\s+are|how\s+to|how\s+can\s+i|what\s+should\s+i\s+do|which\s+one)\b/i.test(
      t
    );

  const isQuestion = qMarks > 0 || startsLikeQuestion || hasQuestionIntent;

  if (!isQuestion) {
    return { isQuestion: false, isMultiple: false, forcedES: null };
  }

  // ---- Multiple-question detection ----
  // 1) >=2 question marks
  if (qMarks >= 2) {
    return { isQuestion: true, isMultiple: true, forcedES: "These are reasonable questions." };
  }

  // 2) more than one question-word appears
  const qWordCount = (t.match(/\b(what|why|how|which|who|when|where)\b/gi) || []).length;
  if (qWordCount >= 2) {
    return { isQuestion: true, isMultiple: true, forcedES: "These are reasonable questions." };
  }

  // 3) two question clauses joined by "and/or" (works even with one ? at end)
  // e.g., "Which workshops... and how can I..."
  const hasAndOr = /\b(and|or)\b/i.test(t);
  if (hasAndOr && (qWordCount >= 1 || startsLikeQuestion)) {
    // rough but practical: if it has a connector + question structure, treat as multiple
    // Example: "Which ... and how ..."
    if (
      /\b(what|why|how|which|who|when|where)\b.*\b(and|or)\b.*\b(what|why|how|which|who|when|where)\b/i.test(
        t
      )
    ) {
      return { isQuestion: true, isMultiple: true, forcedES: "These are reasonable questions." };
    }
  }

  // default: single question
  return { isQuestion: true, isMultiple: false, forcedES: "It’s a reasonable question." };
}

function buildSlot2Target(session) {
  // We ONLY use the stressor itself (from Slot0 issue), NOT the reason (Slot1 whyStressful)
  const issueRaw = session?.memory?.issue || "";
  const issue = cleanIssuePhrase(issueRaw);
  const t = normalize(issue);

  if (!issue) return "your academic issue";

  // --- General mappings to make the phrase short + task-focused ---
  // exams/tests/quizzes
  if (/\b(final|midterm|exam|test|quiz)\b/i.test(t)) {
    return `preparing for ${issue}`;
  }

  // assignments/homework/problem sets
  if (/\b(assignment|homework|problem\s*set|pset|lab|worksheet)\b/i.test(t)) {
    return `completing ${issue}`;
  }

  // papers/essays/thesis/dissertation
  if (/\b(paper|essay|thesis|dissertation|proposal|literature\s*review|report)\b/i.test(t)) {
    return `working on ${issue}`;
  }

  // presentations/speeches
  if (/\b(presentation|presenting|speech|talk)\b/i.test(t)) {
    return `preparing for ${issue}`;
  }

  // deadlines (generic)
  if (/\bdeadline|due\s+date\b/i.test(t)) {
    return `meeting the deadline for ${issue}`;
  }

  // group work
  if (/\bgroup\s*project|team\s*project|group\s*work\b/i.test(t)) {
    return `managing ${issue}`;
  }

  // grades (generic)
  if (/\bgrade|gpa\b/i.test(t)) {
    return "improving your grade";
  }

  // fallback
  return issue;
}

// =====================
// Slot1 topic extractor (so Slot2 can reuse Slot1 keyword/topic)
// =====================
function extractTopicFromSlot1(botText) {
  const t = String(botText || "").trim();
  if (!t) return "";

  let m =
    t.match(/what\s+makes\s+(?:the\s+|your\s+)?(.+?)\s+stressful\b/i) ||
    t.match(/makes\s+(?:the\s+|your\s+)?(.+?)\s+stressful\b/i);

  if (m && m[1]) {
    return m[1].trim().replace(/[?.!]+$/g, "");
  }
  return "";
}

function pickRandomConditionId() {
  const i = Math.floor(Math.random() * CONDITION_POOL.length);
  return CONDITION_POOL[i];
}

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      started: false,
      done: false,
      crisis: false,
      slotIndex: 0,
      conditionId: null,
      history: [],

      memory: {
        issue: "",
        whyStressful: "",
        tried: "",

        slotTopic: "",

        lastBotOptions: { A: "", B: "", C: "" },
        lastBotSuggestion: "",

        userNeed: "",
        userPreference: "",

        adviceHistory: [],
      },
    });
  }
  return sessions.get(sessionId);
}

// =====================
// 2) Safety: crisis detection (English only)
// =====================
function containsCrisisLanguage(text) {
  const t = normalize(text);
  if (!t) return false;

  const regexes = [
    /\b(suicide|suicidal)\b/i,
    /\bkill\s+myself\b/i,
    /\b(end|take)\s+my\s+life\b/i,
    /\bself[-\s]?harm\b/i,
    /\bhurt\s+myself\b/i,
    /\bi\s+want\s+to\s+die\b/i,
    /\bcan'?t\s+go\s+on\b/i,
  ];

  if (regexes.some((r) => r.test(t))) return true;

  if (/\bi\s+want\s+to\b/i.test(t) && /\b(die|kill\s+myself|end\s+my\s+life)\b/i.test(t)) {
    return true;
  }
  return false;
}

function crisisResponse() {
  return (
    "I’m really sorry you’re going through this. I can’t help with self-harm, but you can get support right now:\n" +
    "- If you are in the U.S./Canada, call or text 988 (Suicide & Crisis Lifeline)\n" +
    "- If you are outside the U.S., find local numbers via your country’s emergency services\n" +
    "- If you are in immediate danger, call your local emergency number\n"
  );
}

// =====================
// 2.5) REPAIR / CLARIFICATION (added; minimal intrusion)
// =====================
function isClarificationRequest(text) {
  const t = normalize(text);
  if (!t) return false;

  const regexes = [
    /\bwhat\s+do\s+you\s+mean\b/i,
    /\bwhat('?s| is| does)?\s+(that|this|it)?\s*(mean|meaning)\b/i,
    /\bi\s*(do\s*not|don'?t)\s*(understand|get\s*it|get)\b/i,
    /\bi'?m\s*(confused|lost|not\s+sure)\b/i,
    /\b(can|could)\s+you\s+(explain|clarify|elaborate)\b/i,
    /\bplease\s+(explain|clarify)\b/i,
    /\bwhat\s+should\s+i\s+(answer|say|respond)\b/i,
    /\bhow\s+should\s+i\s+(answer|respond)\b/i,
  ];

  if (regexes.some((r) => r.test(t))) return true;

  const short = t.length <= 30;
  const hasQ = t.includes("?");
  const startsWithQWord = /^(what|why|how|which|huh|sorry|pardon)\b/i.test(t);
  if (short && (hasQ || startsWithQWord)) return true;

  return false;
}

function clarificationReplyForSlot(condition, slotId, type) {
  const slot = condition?.slots?.[slotId];

  if (slotId === 0) {
    return (
      "I mean: please briefly describe one academic-related issue that has been stressful for you recently (for example, assignments, deadlines, exams, or group work). " +
      (slot?.fixedBotText || "")
    );
  }
  if (slotId === 1) {
    return (
      "I mean: what specifically makes that issue stressful for you (for example, time pressure, uncertainty, or expectations)? " +
      "Could you tell me more about what makes it stressful for you?"
    );
  }
  if (slotId === 2) {
    const prefix = type === "type1" ? "Ok. " : "";
    return (
      "I mean: what solutions to the specific issue you just described (the main stressor) have you considered or tried so far, such as ways to address it or prepare for it. " +
      `${prefix}What solutions have you considered or tried so far?`
    );
  }

  if (slotId === 3) {
    return "I mean: you can say yes to get advice, or you can end the conversation.";
  }
  return "Could you clarify what part is unclear, and then answer the question I asked?";
}

// =====================
// 3) End-state detection (HARD STOP)
// =====================
function replyIndicatesDone(reply) {
  const t = normalize(reply);
  return (
    t.includes("you have reached the end of the conversation") ||
    t.includes("(this is the end of our conversation.)")
  );
}

// User explicit end intent
function isEndIntent(userText, prevBotSlotId) {
  const t = normalize(userText);
  if (!t) return false;

  const explicitWords = ["end", "stop", "exit", "quit", "leave", "terminate"];
  const explicitRe = new RegExp(`\\b(${explicitWords.join("|")})\\b`, "i");

  if ((prevBotSlotId === 2 || prevBotSlotId === 3) && explicitRe.test(t)) {
    return true;
  }

  const refuseAdvicePhrases = [
    "no advice",
    "i don't want advice",
    "i do not want advice",
    "don't give advice",
    "do not give advice",
    "i want to end",
    "i want to stop",
    "let's end",
  ];
  if (refuseAdvicePhrases.some((p) => t.includes(p))) return true;

  if ((t === "no" || t === "nope") && (prevBotSlotId === 2 || prevBotSlotId === 3)) {
    return true;
  }

  return false;
}

// =====================
// 4) Need / Preference extraction (simple, practical)
// =====================
function extractUserNeed(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const cues = [
    /my real need is (.+)/i,
    /what i really need is (.+)/i,
    /actually[, ]+i need (.+)/i,
    /actually[, ]+i want (.+)/i,
    /i need (.+)/i,
    /i want (.+)/i,
    /the real problem is (.+)/i,
    /the main issue is (.+)/i,
  ];

  for (const re of cues) {
    const m = raw.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function extractUserPreference(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const cues = [
    /i don'?t want (.+)/i,
    /i do not want (.+)/i,
    /i can'?t (.+)/i,
    /i cannot (.+)/i,
    /that doesn'?t work (.+)?/i,
    /that does not work (.+)?/i,
  ];

  for (const re of cues) {
    const m = raw.match(re);
    if (m && m[0]) return m[0].trim();
  }
  return "";
}

function mergePreference(oldPref, newPref) {
  const a = String(oldPref || "").trim();
  const b = String(newPref || "").trim();
  if (!b) return a;
  if (!a) return b;
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  if (b.length >= a.length) return b;
  return `${a} | ${b}`;
}

function updateMemoryFromUserAnswer(session, prevBotSlotId, userText) {
  if (prevBotSlotId === 0) {
    session.memory.issue = userText;

    const topic = extractTopicFromSlot0(userText);
    if (topic) session.memory.slotTopic = topic;
  }

  if (prevBotSlotId === 1) session.memory.whyStressful = userText;
  if (prevBotSlotId === 2) session.memory.tried = userText;

  const need = extractUserNeed(userText);
  if (need) session.memory.userNeed = need;

  const pref = extractUserPreference(userText);
  if (pref) session.memory.userPreference = mergePreference(session.memory.userPreference, pref);
}

// =====================
// 5) Parse bot suggestions for novelty memory
// =====================
function parseOptionsABC(botText) {
  const t = String(botText || "");
  const out = { A: "", B: "", C: "" };

  const a = t.match(/-\s*First,\s*([\s\S]*?)(?=\n-\s*Next,|\n-\s*Then,|$)/i);
  const b = t.match(/-\s*Next,\s*([\s\S]*?)(?=\n-\s*Then,|$)/i);
  const c = t.match(/-\s*Then,\s*([\s\S]*?)(?=$)/i);
  if (a && a[1]) out.A = a[1].trim().replace(/\s+$/g, "");
  if (b && b[1]) out.B = b[1].trim().replace(/\s+$/g, "");
  if (c && c[1]) out.C = c[1].trim().replace(/\s+$/g, "");

  if (!out.A && !out.B && !out.C) {
    const na = t.match(
      /One option you could consider is\s*([\s\S]*?)(?=Another option is|A third option is|What do you think|$)/i
    );
    const nb = t.match(/Another option is\s*([\s\S]*?)(?=A third option is|What do you think|$)/i);
    const nc = t.match(/A third option is\s*([\s\S]*?)(?=What do you think|$)/i);
    if (na && na[1]) out.A = na[1].trim();
    if (nb && nb[1]) out.B = nb[1].trim();
    if (nc && nc[1]) out.C = nc[1].trim();
  }

  for (const k of ["A", "B", "C"]) {
    out[k] = String(out[k] || "").trim().replace(/[“”"]/g, "").trim();
  }
  return out;
}

function parseSingleSuggestion(botText) {
  const t = String(botText || "").trim();
  if (!t) return "";

  const m1 = t.match(
    /let[’']?s\s+think\s+about\s+another\s+solution\.\s*([\s\S]*?)\s*what do you think about this\?/i
  );
  if (m1 && m1[1]) return m1[1].trim();

  const m2 = t.match(/apply the following approach:\s*([\s\S]*?)\s*$/i);
  if (m2 && m2[1]) return m2[1].trim();

  const m3 = t.match(
    /i understand\.\s*if the previous options are not effective,\s*apply the following approach:\s*([\s\S]*?)\s*$/i
  );
  if (m3 && m3[1]) return m3[1].trim();

  return "";
}

function extractOptionsFromAdvice(botText) {
  const t = String(botText || "").trim();
  if (!t) return [];

  const opts = [];
  const abc = parseOptionsABC(t);
  if (abc.A) opts.push(abc.A);
  if (abc.B) opts.push(abc.B);
  if (abc.C) opts.push(abc.C);

  const single = parseSingleSuggestion(t);
  if (single) opts.push(single);

  return opts.filter(Boolean);
}

function pushAdviceHistory(session, botText) {
  const arr = extractOptionsFromAdvice(botText);
  if (arr.length) {
    session.memory.adviceHistory.push(...arr);
    if (session.memory.adviceHistory.length > 30) {
      session.memory.adviceHistory = session.memory.adviceHistory.slice(-30);
    }
  }
}

// =====================
// 6) OpenAI call
// =====================
async function callOpenAI(payload) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`OpenAI request failed: ${r.status} ${errText}`);
  }

  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? "[no reply]";
}

// =====================
// 7) Routes
// =====================
app.get("/", (req, res) => res.send("API is running"));

app.get("/debug", (req, res) => {
  res.json({
    version: "SLOT2_HARDCODE_TEST_20260113_v3",
    pool: CONDITION_POOL,
  });
});

// View chat history (JSON)
app.get("/history/:sessionId", (req, res) => {
  const session = sessions.get(String(req.params.sessionId));
  if (!session) return res.status(404).json({ error: "session_not_found" });
  return res.json({
    sessionId: String(req.params.sessionId),
    conditionId: session.conditionId,
    done: session.done,
    crisis: session.crisis,
    history: session.history,
    memory: session.memory,
  });
});

// Download chat history (plain text)
app.get("/download/:sessionId.txt", (req, res) => {
  const sessionId = String(req.params.sessionId);
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).send("session_not_found");

  const lines = [];
  lines.push(`sessionId: ${sessionId}`);
  lines.push(`conditionId: ${session.conditionId || ""}`);
  lines.push(`done: ${session.done}`);
  lines.push("");

  for (const h of session.history) {
    const ts = h.ts ? new Date(h.ts).toISOString() : "";
    lines.push(
      `[${ts}] ${h.role.toUpperCase()}${
        h.slotId !== null && h.slotId !== undefined ? ` (slot ${h.slotId})` : ""
      }:`
    );
    lines.push(h.text);
    lines.push("");
  }

  const txt = lines.join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="chat_history_${sessionId}.txt"`);
  return res.send(txt);
});

// Main chat endpoint
app.post("/chat", async (req, res) => {
  const body = req.body || {};
  const userText = String(body.user || "").trim();

  const sessionId = getSessionId(req);
  const session = getOrCreateSession(sessionId);

  // ---- Assign conditionId ----
  const requestedConditionId = body.conditionId || req.query.conditionId || null;
  if (requestedConditionId) session.conditionId = String(requestedConditionId);
  if (!session.conditionId) session.conditionId = pickRandomConditionId();

  const condition = dialogues[session.conditionId];
  if (!condition) {
    return res.status(500).json({ error: `Condition not found: ${session.conditionId}` });
  }

  // ---- HARD STOP states ----
  if (session.crisis) {
    return res.json({
      reply: crisisResponse(),
      done: true,
      sessionId,
      slotId: null,
      conditionId: session.conditionId,
    });
  }
  if (session.done) {
    return res.json({
      reply: "Conversation ended.",
      done: true,
      sessionId,
      slotId: null,
      conditionId: session.conditionId,
    });
  }

  // ---- First entry: send Slot 0 fixed text ----
  if (!session.started) {
    session.started = true;
    session.slotIndex = 0;

    const slot0 = condition.slots[0];
    const reply = slot0.fixedBotText;

    session.history.push({ role: "assistant", slotId: 0, text: reply, ts: Date.now() });

    return res.json({
      reply,
      slotId: 0,
      done: false,
      sessionId,
      conditionId: session.conditionId,
    });
  }

  if (!userText) {
    return res.status(400).json({ error: "Empty user message" });
  }

  // ---- crisis check ----
  if (containsCrisisLanguage(userText)) {
    session.crisis = true;
    session.done = true;

    const reply = crisisResponse();
    session.history.push({ role: "user", slotId: null, text: userText, ts: Date.now() });
    session.history.push({ role: "assistant", slotId: null, text: reply, ts: Date.now() });

    return res.json({ reply, done: true, sessionId, slotId: null, conditionId: session.conditionId });
  }

  // Determine prev bot slotId
  const prevIndex = session.slotIndex;
  const prevBotSlotId = condition.slotOrder[prevIndex];

  // end intent
  if (isEndIntent(userText, prevBotSlotId)) {
    session.done = true;
    const reply = "You have reached the end of the conversation. Thank you for your participation.";

    session.history.push({ role: "user", slotId: prevBotSlotId, text: userText, ts: Date.now() });
    session.history.push({ role: "assistant", slotId: null, text: reply, ts: Date.now() });

    return res.json({ reply, done: true, sessionId, slotId: null, conditionId: session.conditionId });
  }

  // =====================
  // REPAIR GATE (added; does NOT advance slot)
  // =====================
  const type = condition?.factors?.type;
  const isType2or4 = type === "type2" || type === "type4";
  const isType1or3 = type === "type1" || type === "type3";
  const skipRepair = isType2or4 ? prevBotSlotId >= 3 : isType1or3 ? prevBotSlotId >= 4 : false;

  if (!skipRepair && isClarificationRequest(userText)) {
    const repair = clarificationReplyForSlot(condition, prevBotSlotId, type);

    session.history.push({ role: "user", slotId: prevBotSlotId, text: userText, ts: Date.now() });
    session.history.push({ role: "assistant", slotId: prevBotSlotId, text: repair, ts: Date.now() });

    return res.json({
      reply: repair,
      done: false,
      sessionId,
      slotId: prevBotSlotId,
      conditionId: session.conditionId,
      repaired: true,
    });
  }
  // =====================

  // store user answer + update memory
  session.history.push({ role: "user", slotId: prevBotSlotId, text: userText, ts: Date.now() });
  updateMemoryFromUserAnswer(session, prevBotSlotId, userText);

  // move to next slot
  session.slotIndex += 1;
  const currentSlotId = condition.slotOrder[session.slotIndex];

  if (currentSlotId === undefined) {
    session.done = true;
    return res.json({
      reply: "Conversation ended.",
      done: true,
      sessionId,
      slotId: null,
      conditionId: session.conditionId,
    });
  }

  const slot = condition.slots[currentSlotId];

  // =====================
  // HARD-CODE Slot 2 question for collaborative Type1 & Type3
  // =====================
  const botStyle = condition?.factors?.style;

  if (currentSlotId === 2 && botStyle === "collaborative" && (type === "type1" || type === "type3")) {
    const rawTopic = String(session?.memory?.slotTopic || "").trim();
    const normalizedTopic = normalizeTopicPhrase(rawTopic);

    // -------- normalize topic wording --------
    let normalized = normalizedTopic;

    // normalize bare "smoke"
    if (/^smoke$/i.test(normalized)) {
      normalized = "smoking";
    }

    // remove leading determiners if any
    normalized = normalized.replace(/^(the|a|an)\s+/i, "").trim();

    // -------- decide whether to add "the" --------
    let topic = normalized;

    // if NOT a gerund phrase (e.g., not "quitting smoking"), add "the"
    if (normalized && !/^\w+ing\b/i.test(normalized)) {
      topic = `the ${normalized}`;
    }

    // fallback
    if (!topic) {
      topic = "your academic issue";
    }

    // --- Type3 Slot2: pick ONE emotional-support sentence (uncertainty-aware) ---
    const tUser = normalize(userText);

    const wordCount = tUser.split(/\s+/).filter(Boolean).length;

    const hasElaborationStructure =
      wordCount >= 12 ||
      /\b(because|since|so|that’s why|it's that|first|second|also|and|most importantly)\b/i.test(
        tUser
      );

    const hasUncertaintyCue =
      /\b(i\s*(do\s*not|don't)\s*know|idk|not\s*sure|maybe|i guess|kind of)\b/i.test(tUser);

    const isUncertain = hasUncertaintyCue && !hasElaborationStructure;

    const isQuestion = /\?/.test(userText) || /^(what|why|how|which|can|could|do|does|is|are)\b/i.test(tUser);

    const isDistress =
      /\b(distress(ed)?|anxious|anxiety|worried|panic|craving|withdrawal|uncomfortable|upset|can'?t\s+focus|irritable)\b/i.test(
        tUser
      );

    const slot2UncertaintyBank = ["That’s okay.", "It can be hard to put it into words.", "No worries if you’re not sure."];

    const slot2DistressBank = ["It is fine to feel that way. Anyone in your situation would find it stressful."];

    const slot2QuestionBank = ["It’s a reasonable question."];

    const slot2NeutralBank = ["I understand.", "That makes sense."];

    let bank = slot2NeutralBank;

    if (isUncertain) {
      bank = slot2UncertaintyBank;
    } else if (isDistress) {
      bank = slot2DistressBank;
    } else if (isQuestion) {
      bank = slot2QuestionBank;
    }

    const es = bank[Math.floor(Math.random() * bank.length)];

    const reply =
      type === "type3"
        ? `${es} What solutions have you considered or tried so far to deal with ${topic}?`
        : `What solutions have you considered or tried so far to deal with ${topic}?`;

    session.history.push({
      role: "assistant",
      slotId: currentSlotId,
      text: reply,
      ts: Date.now(),
    });

    return res.json({
      reply,
      slotId: currentSlotId,
      done: false,
      sessionId,
      conditionId: session.conditionId,
      memory: session.memory,
      hardcoded: true,
    });
  }
  // =====================

  // ---- Build definition + memory blocks ----
  const style = condition?.factors?.style || "";
  const emotionalSupport = !!condition?.factors?.emotionalSupport;

  const definitionBlock = `Definitions (placeholders):
- Collaborative: ${DEFINITIONS.collaborative}
- Directive: ${DEFINITIONS.directive}
- Emotional support: ${DEFINITIONS.emotionalSupport}
- No emotional support: ${DEFINITIONS.noEmotionalSupport}

Current bot factors:
- type: ${type}
- style: ${style}
- emotionalSupport: ${emotionalSupport}
`;

  const noRepeatBlock = session.memory.adviceHistory?.length
    ? `DO NOT repeat or paraphrase any of these previous suggestions (including the same core action with different wording):
${session.memory.adviceHistory
  .slice(-12)
  .map((s, i) => `${i + 1}) ${s}`)
  .join("\n")}`
    : "No previous suggestions have been given yet.";

  const needBlock = session.memory.userNeed
    ? `User clear need (prioritize if your slot rules allow adjustment):
"${session.memory.userNeed}"`
    : "User clear need: [none provided].";

  const preferenceBlock = session.memory.userPreference
    ? `User constraints/preferences:
"${session.memory.userPreference}"`
    : "User constraints/preferences: [none provided].";

  const lastOptionsBlock =
    session.memory.lastBotOptions &&
    (session.memory.lastBotOptions.A || session.memory.lastBotOptions.B || session.memory.lastBotOptions.C)
      ? `Last options shown to the user:
- Option A: ${session.memory.lastBotOptions.A || "[missing]"}
- Option B: ${session.memory.lastBotOptions.B || "[missing]"}
- Option C: ${session.memory.lastBotOptions.C || "[missing]"}`
      : "Last options shown to the user: [none].";

  const lastSuggestionBlock = session.memory.lastBotSuggestion
    ? `Last single suggestion you gave:
"${session.memory.lastBotSuggestion}"`
    : "Last single suggestion you gave: [none].";

  const memoryBlock = `User memory:
- Issue: ${session.memory.issue || "[missing]"}
- Why stressful: ${session.memory.whyStressful || "[missing]"}
- Tried so far: ${session.memory.tried || "[missing]"}

${needBlock}

${preferenceBlock}

${lastOptionsBlock}

${lastSuggestionBlock}

Novelty rule:
${noRepeatBlock}
`;

  const recentTurns = session.history
    .slice(-10)
    .map(
      (h) =>
        `${h.role.toUpperCase()}${
          h.slotId !== null && h.slotId !== undefined ? ` (slot ${h.slotId})` : ""
        }: ${h.text}`
    )
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are an experimental chatbot for a research study. You MUST follow the current slot instruction strictly and output exactly what it requires. Do not add extra sentences.",
    },
    { role: "system", content: definitionBlock },
    { role: "system", content: `CURRENT SLOT ${currentSlotId} (${slot.name}):\n${slot.instruction}` },
    { role: "system", content: memoryBlock },
    { role: "user", content: `Recent chat:\n${recentTurns}\n\nCurrent user message:\n${userText}` },
  ];

  // ===== SLOT 5 STRICT GUARD: prevent false "purely positive" ending =====
  if (type === "type3" && currentSlotId === 5) {
    const t = normalize(userText);

    const hasConcern =
      /\b(but|however|though|sometimes|except)\b/i.test(t) ||
      /\b(no time|not enough time|don'?t have enough time|doesn'?t have enough time)\b/i.test(t) ||
      /\b(can'?t|cannot|hard|difficult|problem|issue|concern)\b/i.test(t);

    if (hasConcern) {
      messages.splice(messages.length - 1, 0, {
        role: "system",
        content:
          "SLOT 5 STRICT GUARD: The user message includes concerns/constraints. Therefore the response is NOT purely positive. You MUST NOT apply rule 1a (the ending sentence). Follow rule 3a/4a/5a/Fallback as appropriate.",
      });
    }
  }

  // ===== SLOT 6 STRICT GUARD: prevent false "reject-all" (2b) =====
  if (type === "type3" && currentSlotId === 6) {
    const t = normalize(userText);

    const mentionsSpecificOption =
      /\b(first|second|third|option\s*[abc]|option\s*[123]|a\b|b\b|c\b)\b/i.test(t) ||
      /\b(the first one|the second one|the third one)\b/i.test(t);

    const hasConstraint =
      /\b(no time|not enough time|don'?t have enough time|doesn'?t have enough time)\b/i.test(t) ||
      /\b(can'?t|cannot|hard|difficult)\b/i.test(t);

    if (mentionsSpecificOption || hasConstraint) {
      messages.splice(messages.length - 1, 0, {
        role: "system",
        content:
          "SLOT 6 STRICT GUARD: The user mentions a specific option and/or a constraint. Therefore you MUST NOT apply rule 2b (reject-all). Use rule 3b/4b/5b/Fallback as appropriate.",
      });
    }
  }

  // =====================
  // Type3 follow-up slots 5/6/7: SERVER adds EXACTLY ONE ES sentence
  // =====================
  if (type === "type3" && [5, 6, 7].includes(currentSlotId)) {
    const picked = pickESForType3Followup(userText, session);
    if (!session.memory) session.memory = {};
    session.memory._type3ESPrefix = picked.es;

    const EXACT_END =
      "I’m glad to hear that. You’ve done a good job thinking about your situation so far. I wish you all the best. (This is the end of our conversation.)";

    // IMPORTANT: we do NOT globally forbid ES, because 1a/1b/1c and 2a/2b/2c
    // require fixed sentences that can be emotional-support-like.
    // Instead we instruct:
    // - If rule 1x: output EXACT_END only.
    // - If rule 2x: output only the fixed 2x pattern.
    // - Otherwise (3/4/5/Fallback): do NOT output any ES sentence; server will inject one.
    messages.splice(messages.length - 1, 0, {
      role: "system",
      content:
        "TYPE3 FOLLOW-UP SERVER POLICY:\n" +
        `- If you apply rule 1a/1b/1c, output EXACTLY this sentence and nothing else:\n"${EXACT_END}"\n` +
        "- If you apply rule 2a/2b/2c (reject-all), output EXACTLY ONE of these starts and then the fixed question:\n" +
        '"I\'m sorry to hear that. Could you tell me which parts you think should be revised?"\n' +
        '"It’s usual to take some time to figure out what doesn’t quite fit. Could you tell me which parts you think should be revised?"\n' +
        "- Otherwise (rules 3/4/5/Fallback), DO NOT output any emotional-support sentence at all. Start directly with the required content. The SERVER will add exactly one emotional-support sentence.",
    });
  }

  // =====================
// Type4 follow-up slots 3/4/5: SERVER adds EXACTLY ONE ES sentence
// (Use SAME selection standard as Type3 via pickESForType3Followup)
// =====================
if (type === "type4" && [3, 4, 5].includes(currentSlotId)) {
  const picked = pickESForType3Followup(userText, session);
  if (!session.memory) session.memory = {};
  session.memory._type4ESPrefix = picked.es;

  messages.splice(messages.length - 1, 0, {
    role: "system",
    content:
      "TYPE4 FOLLOW-UP SERVER POLICY:\n" +
      "- An emotional-support sentence will be added by the SERVER.\n" +
      "- Therefore, you MUST NOT output any emotional-support sentence.\n" +
      "- Start directly with the required directive content.\n" +
      "- Your first sentence MUST start with an imperative verb (as required by the slot).\n",
  });
}

  try {
    const payload = {
      model: "gpt-4o-mini",
      messages,
      temperature: 0.2,
    };

    let reply = await callOpenAI(payload);

    // ✅ Inject EXACTLY ONE ES sentence for Type3 slots 5/6/7 (GUARDED)
    if (type === "type3" && [5, 6, 7].includes(currentSlotId)) {
      let raw = String(reply || "").trim();

      const EXACT_END =
        "I’m glad to hear that. You’ve done a good job thinking about your situation so far. I wish you all the best. (This is the end of our conversation.)";

      // 1a/1b/1c exact ending sentence only -> DO NOT inject
      if (raw === EXACT_END) {
        reply = raw;
      } else {
        // 2a/2b/2c fixed pattern: model already contains exactly-one ES + fixed question
        const isFixed2x =
          /^(I'm sorry to hear that\.|It’s usual to take some time to figure out what doesn’t quite fit\.)\s+/i.test(
            raw
          ) && /\bwhich parts you think should be revised\?\s*$/i.test(raw);

        if (isFixed2x) {
          reply = raw; // do not inject
        } else {
          const es = (session.memory && session.memory._type3ESPrefix) || ES_SENTENCES.understand;

          // strip any accidental ES that the model output at the beginning
          const forbidden = Object.values(ES_SENTENCES).filter(Boolean);
          for (const f of forbidden) {
            const re = new RegExp(
              "^" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:[.!?])?\\s*",
              "i"
            );
            raw = raw.replace(re, "");
          }

          // also strip common accidental prefix
          raw = raw.replace(/^I understand(?:[.!?])?\s*/i, "").trim();

          reply = `${es} ${raw}`.trim();
        }
      }

      if (session.memory) delete session.memory._type3ESPrefix;
    }

    // ✅ Inject EXACTLY ONE ES sentence for Type4 slots 3/4/5 (GUARDED)
if (type === "type4" && [3, 4, 5].includes(currentSlotId)) {
  let raw = String(reply || "").trim();

  // --- ending bypass: if model output is the exact ending, DO NOT inject ---
  // Use a robust check to tolerate straight/curly apostrophes.
  const isType4Ending =
    /^\s*I['’]m glad to hear that\.\s*You['’]ve done a good job thinking about your situation so far\.\s*I wish you all the best\.\s*\(This is the end of our conversation\.\)\s*$/i.test(
      raw
    ) ||
    /^\s*It['’]s good to hear that\.\s*\(This is the end of our conversation\.\)\s*$/i.test(raw);

  if (isType4Ending) {
    reply = raw; // dictionary 1a/1b/1c stays untouched
  } else {
    const es = (session.memory && session.memory._type4ESPrefix) || ES_SENTENCES.understand;

    // strip any accidental ES that the model output at the beginning
    const forbidden = Object.values(ES_SENTENCES).filter(Boolean);
    for (const f of forbidden) {
      const re = new RegExp(
        "^" + f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:[.!?])?\\s*",
        "i"
      );
      raw = raw.replace(re, "");
    }

    // extra strip for common accidental prefix
    raw = raw.replace(/^I understand(?:[.!?])?\s*/i, "").trim();

    reply = `${es} ${raw}`.trim();
  }

  if (session.memory) delete session.memory._type4ESPrefix;
}

    // NEW: if this is Slot 1, capture the keyword/topic used in Slot 1 for Slot 2 reuse
    if (currentSlotId === 1) {
      const topic = extractTopicFromSlot1(reply);
      if (topic) session.memory.slotTopic = topic;
    }

    // update memory from bot reply
    const abc = parseOptionsABC(reply);
    if (abc.A || abc.B || abc.C) {
      session.memory.lastBotOptions = abc;
    }

    const single = parseSingleSuggestion(reply);
    if (single) {
      session.memory.lastBotSuggestion = single;
    }

    pushAdviceHistory(session, reply);

    // save assistant reply
    session.history.push({
      role: "assistant",
      slotId: currentSlotId,
      text: reply,
      ts: Date.now(),
    });

    // HARD END
    if (replyIndicatesDone(reply)) {
      session.done = true;
      return res.json({
        reply,
        slotId: currentSlotId,
        done: true,
        sessionId,
        conditionId: session.conditionId,
        memory: session.memory,
      });
    }

    return res.json({
      reply,
      slotId: currentSlotId,
      done: false,
      sessionId,
      conditionId: session.conditionId,
      memory: session.memory,
    });
  } catch (e) {
    console.error("Server caught error:", e);
    return res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
