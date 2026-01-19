const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const debugEl = document.getElementById("debug");
const typingTpl = document.getElementById("typing-template");

const API_URL = "http://localhost:3000/chat";

const TYPING_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 先写死，之后可以换成自动生成 / Qualtrics 传
let sessionId = "ui_" + crypto.randomUUID();
let conditionId = "collaborative_noES";
const DEBUG = false; // 想隐藏就改成 false

if (DEBUG) {
  debugEl.style.display = "block";
  debugEl.textContent = `sessionId: ${sessionId} | conditionId: ${conditionId}`;
}

function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addTypingBubble() {
  const node = typingTpl.content.firstElementChild.cloneNode(true);
  chatEl.appendChild(node);
  chatEl.scrollTop = chatEl.scrollHeight;
  return node;
}

async function sendToServer(userText) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      conditionId,
      user: userText,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || "Server error");
  }

  return res.json(); // { reply, slotId, done, ... }
}

// ✅ Page load: get Slot 0 automatically (no typing indicator)
(async function init() {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, conditionId }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || "Init server error");
    }

    const data = await res.json();
    addBubble(data.reply, "bot"); // ✅ slot0 直接显示
  } catch (err) {
    console.error(err);
    addBubble("⚠️ Could not load the first message.", "bot");
  }
})();

async function handleSend() {
  const text = inputEl.value.trim();
  if (!text) return;

  addBubble(text, "user");
  inputEl.value = "";
  inputEl.focus();

  try {
    const serverPromise = sendToServer(text);
    await sleep(500);

    const typingBubble = addTypingBubble();

    const data = await Promise.all([serverPromise, sleep(TYPING_DELAY_MS)]).then(([d]) => d);

    typingBubble.textContent = data.reply;

    if (data.done) {
      inputEl.disabled = true;
      sendBtn.disabled = true;
    }
  } catch (err) {
    addBubble("⚠️ Error connecting to server.", "bot");
    console.error(err);
  }
}

sendBtn.addEventListener("click", handleSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSend();
});
