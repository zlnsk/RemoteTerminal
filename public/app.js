 
(() => {
  const BASE = "/Remote/Terminal";

  const THEME = {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b70",
    selectionForeground: "#cdd6f4",
    black: "#45475a", brightBlack: "#585b70",
    red: "#f38ba8", brightRed: "#f38ba8",
    green: "#a6e3a1", brightGreen: "#a6e3a1",
    yellow: "#f9e2af", brightYellow: "#f9e2af",
    blue: "#89b4fa", brightBlue: "#89b4fa",
    magenta: "#f5c2e7", brightMagenta: "#f5c2e7",
    cyan: "#94e2d5", brightCyan: "#94e2d5",
    white: "#bac2de", brightWhite: "#a6adc8",
  };

  const el = {
    targets: document.getElementById("targets"),
    term: document.getElementById("terminal"),
    overlay: document.getElementById("overlay"),
    overlayTitle: document.getElementById("overlay-title"),
    overlaySub: document.getElementById("overlay-sub"),
    dot: document.getElementById("status-dot"),
    statusText: document.getElementById("status-text"),
    statusTarget: document.getElementById("status-target"),
    statusSize: document.getElementById("status-size"),
    btnPaste: document.getElementById("btn-paste"),
    btnCopy: document.getElementById("btn-copy"),
    btnFontPlus: document.getElementById("btn-font-plus"),
    btnFontMinus: document.getElementById("btn-font-minus"),
    btnSearch: document.getElementById("btn-search"),
    search: document.getElementById("search"),
    searchInput: document.getElementById("search-input"),
    searchPrev: document.getElementById("search-prev"),
    searchNext: document.getElementById("search-next"),
    searchClose: document.getElementById("search-close"),
  };

  let fontSize = parseInt(localStorage.getItem("rt.fontSize") || "14", 10);

  const term = new Terminal({
    fontFamily: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
    fontSize,
    fontWeight: 400,
    fontWeightBold: 700,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    cursorInactiveStyle: "outline",
    scrollback: 10000,
    allowProposedApi: true,
    allowTransparency: false,
    convertEol: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    smoothScrollDuration: 80,
    windowsPty: undefined,
    theme: THEME,
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = "11";
  const searchAddon = new SearchAddon.SearchAddon();
  term.loadAddon(searchAddon);
  try { term.loadAddon(new ClipboardAddon.ClipboardAddon()); } catch {}

  term.open(el.term);

  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (e) {
    console.warn("WebGL addon unavailable; falling back", e);
  }

  function safeFit() {
    const r = el.term.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return false;
    try { fitAddon.fit(); return true; } catch { return false; }
  }
  async function initialFit() {
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }
    
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!safeFit()) {
      
      let tries = 0;
      const iv = setInterval(() => {
        if (safeFit() || ++tries > 10) clearInterval(iv);
      }, 50);
    }
  }
  initialFit();

  let ws = null;
  let currentTarget = null;
  let targets = {};

  function wsUrl(target) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}${BASE}/ws?target=${encodeURIComponent(target)}`;
  }

  function setOverlay(kind, title, sub) {
    el.overlay.className = "overlay";
    if (!kind) { el.overlay.classList.remove("show"); return; }
    el.overlay.classList.add("show");
    if (kind !== "connecting") el.overlay.classList.add(kind);
    el.overlayTitle.textContent = title;
    el.overlaySub.textContent = sub || "";
  }

  function setStatus(kind, text) {
    el.dot.className = "dot";
    if (kind) el.dot.classList.add(kind);
    el.statusText.textContent = text;
  }

  function updateTargetBtn(id, cls) {
    const btn = el.targets.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!btn) return;
    btn.classList.remove("active", "connecting", "error");
    if (cls) btn.classList.add(cls);
  }

  function renderTargets() {
    el.targets.innerHTML = "";
    for (const [id, t] of Object.entries(targets)) {
      const b = document.createElement("button");
      b.className = "target-btn";
      b.dataset.id = id;
      b.innerHTML = `<span class="pulse"></span><span>${escapeHtml(t.label)}</span>`;
      b.addEventListener("click", () => connect(id));
      el.targets.appendChild(b);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  function connect(targetId) {
    if (ws && ws.readyState <= 1) {
      try { ws.close(); } catch {}
    }
    currentTarget = targetId;
    try { term.reset(); term.clear(); } catch {}
    for (const id of Object.keys(targets)) updateTargetBtn(id, null);
    updateTargetBtn(targetId, "connecting");
    setStatus("connecting", "connecting");
    setOverlay("connecting", `Connecting to ${targets[targetId].label}`, "Establishing SSH session");
    el.statusTarget.textContent = targets[targetId].label;

    ws = new WebSocket(wsUrl(targetId));
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      const { cols, rows } = term;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "stdout") {
        term.write(msg.data);
      } else if (msg.type === "status") {
        handleStatus(msg);
      } else if (msg.type === "error") {
        setStatus("error", "error");
        setOverlay("error", "Connection error", msg.msg || "");
        updateTargetBtn(currentTarget, "error");
      } else if (msg.type === "pong") {
        
      }
    });

    ws.addEventListener("close", (ev) => {
      if (ev.code === 4000) {
        setStatus("error", "taken over");
        setOverlay("error", "Replaced by newer connection", "This session was superseded by another tab/window.");
        updateTargetBtn(currentTarget, "error");
        return;
      }
      setStatus(null, "disconnected");
      setOverlay("error", "Disconnected", "The connection to the server was closed.");
      updateTargetBtn(currentTarget, null);
    });
  }

  function handleStatus(msg) {
    switch (msg.state) {
      case "connecting":
        setStatus("connecting", "connecting"); break;
      case "authenticated":
        setStatus("connecting", "authenticated"); break;
      case "ready":
        setStatus("ready", "ready");
        setOverlay(null);
        updateTargetBtn(currentTarget, "active");
        
        requestAnimationFrame(() => {
          safeFit();
          term.focus();
          const { cols, rows } = term;
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        });
        break;
      case "closed":
        setStatus(null, "closed");
        updateTargetBtn(currentTarget, null);
        break;
      case "kicked":
        setStatus("error", "kicked");
        setOverlay("error", "Session taken over", msg.msg || "");
        break;
    }
  }

  term.onData((data) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stdin", data }));
  });

  term.onResize(({ cols, rows }) => {
    el.statusSize.textContent = `${cols}×${rows}`;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows }));
  });

  async function copySelection() {
    const sel = term.getSelection();
    if (!sel) return false;
    try { await navigator.clipboard.writeText(sel); return true; }
    catch { return false; }
  }
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stdin", data: text }));
      return true;
    } catch { return false; }
  }

  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel && sel.length > 0 && document.hasFocus()) {
      navigator.clipboard.writeText(sel).catch(() => {});
    }
  });

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    const meta = ev.metaKey || ev.ctrlKey;
    if (!meta) return true;
    if (ev.key === "c" || ev.key === "C") {
      if (term.hasSelection()) { copySelection(); return false; }
      return true; 
    }
    if (ev.key === "v" || ev.key === "V") {
      
      return false;
    }
    if (ev.key === "f" || ev.key === "F") { toggleSearch(true); ev.preventDefault(); return false; }
    if (ev.key === "+" || ev.key === "=") { bumpFont(+1); return false; }
    if (ev.key === "-" || ev.key === "_") { bumpFont(-1); return false; }
    return true;
  });

  el.btnCopy.addEventListener("click", async () => {
    const ok = await copySelection();
    flashBtn(el.btnCopy, ok ? "Copied" : "Nothing selected");
  });
  el.btnPaste.addEventListener("click", async () => {
    const ok = await pasteFromClipboard();
    flashBtn(el.btnPaste, ok ? "Pasted" : "Clipboard empty/blocked");
  });

  function flashBtn(btn, label) {
    const span = btn.querySelector("span");
    if (!span) return;
    const prev = span.textContent;
    span.textContent = label;
    setTimeout(() => (span.textContent = prev), 900);
  }

  function bumpFont(delta) {
    fontSize = Math.max(10, Math.min(24, fontSize + delta));
    term.options.fontSize = fontSize;
    localStorage.setItem("rt.fontSize", String(fontSize));
    fitAddon.fit();
  }
  el.btnFontPlus.addEventListener("click", () => bumpFont(+1));
  el.btnFontMinus.addEventListener("click", () => bumpFont(-1));

  function toggleSearch(show) {
    el.search.hidden = !show;
    if (show) el.searchInput.focus();
  }
  el.btnSearch.addEventListener("click", () => toggleSearch(el.search.hidden));
  el.searchClose.addEventListener("click", () => toggleSearch(false));
  el.searchNext.addEventListener("click", () => searchAddon.findNext(el.searchInput.value));
  el.searchPrev.addEventListener("click", () => searchAddon.findPrevious(el.searchInput.value));
  el.searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") searchAddon[ev.shiftKey ? "findPrevious" : "findNext"](el.searchInput.value);
    else if (ev.key === "Escape") toggleSearch(false);
  });

  const ro = new ResizeObserver(() => safeFit());
  ro.observe(el.term);
  ro.observe(el.term.parentElement);
  window.addEventListener("resize", () => safeFit());

  fetch(BASE + "/api/targets", { credentials: "same-origin" })
    .then((r) => r.json())
    .then((data) => {
      targets = data.targets || {};
      renderTargets();
      const first = Object.keys(targets)[0];
      if (first) connect(first);
    })
    .catch((e) => {
      setOverlay("error", "Failed to load targets", String(e));
    });
})();
