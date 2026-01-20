const chatEl = document.getElementById("chat");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const debugEl = document.getElementById("debug");
const typingTpl = document.getElementById("typing-template");

const API_URL = "https://chatbot-comm.onrender.com/chat";
const TYPING_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ====== sessionId: 用 Qualtrics 的 ResponseID ======
const params = new URLSearchParams(window.location.search);
const responseIdFromUrl = params.get("responseId");

let sessionId =
  responseIdFromUrl && responseIdFromUrl.trim()
    ? responseIdFromUrl.trim() // ✅ Qualtrics ResponseID
    : "ui_" + crypto.randomUUID(); // fallback（本地测试用）
// =========================================

// server 随机分配（前端不再传 conditionId）
let conditionId = "(pending)";

const DEBUG = false; // 想隐藏就改成 false

function renderDebug(extra = "") {
  if (!DEBUG) return;
  debugEl.style.display = "block";
  debugEl.textContent = `sessionId: ${sessionId} | conditionId: ${conditionId}` + (extra ? ` | ${extra}` : "");
}

renderDebug();

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatEl.scrollTop = chatEl.scrollHeight;
    requestAnimationFrame(() => {
      chatEl.scrollTop = chatEl.scrollHeight;
    });
  });
}

function addBubble(text, who) {
  const div = document.createElement("div");
  div.className = `bubble ${who}`;
  div.textContent = text;
  chatEl.appendChild(div);
  scrollToBottom();  
}

function addTypingBubble() {
  const node = typingTpl.content.firstElementChild.cloneNode(true);
  chatEl.appendChild(node);
  scrollToBottom();   
  return node;
}

async function sendToServer(userText) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      user: userText,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || "Server error");
  }

  return res.json(); // { reply, slotId, done, conditionId, ... }
}

// ✅ Page load: get Slot 0 automatically (retry on cold start; no scary error)
(async function init() {
  // Show a neutral loading message (NOT an error)
  addBubble("Loading...", "bot");

  let attempts = 0;

  while (attempts < 20) {
    try {
      attempts += 1;

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });

      if (!res.ok) {
        await sleep(2000);
        continue;
      }

      const data = await res.json();

      // Update conditionId (from server)
      conditionId = data.conditionId || conditionId;

      if (DEBUG) {
        debugEl.style.display = "block";
        debugEl.textContent = `sessionId: ${sessionId} | conditionId: ${conditionId}`;
      }

      // Replace the "Loading..." bubble with real first message
      const lastBubble = chatEl.querySelector(".bubble.bot:last-child");
      if (lastBubble) lastBubble.textContent = data.reply;
      else addBubble(data.reply, "bot");
      scrollToBottom();

      return; // ✅ success
    } catch (err) {
      await sleep(2000);
    }
  }

  // If still failing after retries, keep it neutral
  const lastBubble = chatEl.querySelector(".bubble.bot:last-child");
  if (lastBubble) {
    lastBubble.textContent =
      "Loading is taking longer than usual. Please wait a moment and do not refresh.";
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

    // 更新 conditionId（保险：如果 init 失败，但这里成功了，也能拿到）
    conditionId = data.conditionId || conditionId;
    renderDebug();

    typingBubble.textContent = data.reply;
    scrollToBottom();

    if (data.done) {
      inputEl.disabled = true;
      sendBtn.disabled = true;
    }
  } catch (err) {
    console.error(err);
    addBubble("⚠️ Error connecting to server.", "bot");
    renderDebug(`send failed: ${String(err)}`);
  }
}

sendBtn.addEventListener("click", handleSend);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSend();
});
