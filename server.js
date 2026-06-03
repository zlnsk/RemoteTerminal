
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { WebSocketServer } = require("ws");
const { Client: SshClient } = require("ssh2");
const { expressProxySecret, timingEqual } = require("shared-auth/proxy-secret");

const PORT = parseInt(process.env.PORT || "3021", 10);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_PATH = "/Remote/Terminal";
const KEY_PATH = process.env.SSH_KEY_PATH || path.join(__dirname, "keys/id_ed25519");
const KNOWN_HOSTS_PATH = process.env.KNOWN_HOSTS_PATH || path.join(__dirname, "known_hosts");

const TARGETS = {
  "pt-pve": { label: "pt-pve", host: "10.0.21.15", port: 22, user: "lca", hue: 260 },
  "pl-wschowa": { label: "pl-wschowa", host: "100.91.78.84", port: 22, user: "lca", hue: 200, via: "pt-pve" },
  "pt-parede": { label: "pt-parede", host: "10.0.21.1", port: 22, user: "root", hue: 30 },
  "es-limpias": { label: "es-limpias", host: "100.76.240.4", port: 22, user: "root", hue: 160, via: "pt-pve" },
};

const SSH_KEY = fs.readFileSync(KEY_PATH);
const KNOWN_HOSTS = parseKnownHosts(fs.readFileSync(KNOWN_HOSTS_PATH, "utf8"));

function parseKnownHosts(raw) {
  const map = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [hosts, algo, key] = t.split(/\s+/);
    if (!hosts || !algo || !key) continue;
    for (const h of hosts.split(",")) {
      const arr = map.get(h) || [];
      arr.push({ algo, key });
      map.set(h, arr);
    }
  }
  return map;
}

function verifyHostKey(targetHost, remoteKey) {
  const entries = KNOWN_HOSTS.get(targetHost) || [];
  const gotKey = Buffer.isBuffer(remoteKey)
    ? remoteKey.toString("base64")
    : (remoteKey && remoteKey.data ? Buffer.from(remoteKey.data).toString("base64") : "");
  
  if (entries.length === 0) {
    console.error(`[remote-terminal] no known_hosts entry for ${targetHost} — refusing connection`);
    return false;
  }
  return entries.some((e) => e.key === gotKey);
}

const app = express();
app.disable("x-powered-by");
app.use(expressProxySecret());

app.get(BASE_PATH + "/api/targets", (_req, res) => {
  const out = {};
  for (const [id, t] of Object.entries(TARGETS)) out[id] = { label: t.label, hue: t.hue, via: t.via || null };
  res.json({ targets: out });
});

const PUBLIC_DIR = path.join(__dirname, "public");
app.use(BASE_PATH + "/vendor/xterm", express.static(path.join(__dirname, "node_modules/@xterm/xterm")));
app.use(BASE_PATH + "/vendor/addon-fit", express.static(path.join(__dirname, "node_modules/@xterm/addon-fit")));
app.use(BASE_PATH + "/vendor/addon-web-links", express.static(path.join(__dirname, "node_modules/@xterm/addon-web-links")));
app.use(BASE_PATH + "/vendor/addon-webgl", express.static(path.join(__dirname, "node_modules/@xterm/addon-webgl")));
app.use(BASE_PATH + "/vendor/addon-unicode11", express.static(path.join(__dirname, "node_modules/@xterm/addon-unicode11")));
app.use(BASE_PATH + "/vendor/addon-search", express.static(path.join(__dirname, "node_modules/@xterm/addon-search")));
app.use(BASE_PATH + "/vendor/addon-clipboard", express.static(path.join(__dirname, "node_modules/@xterm/addon-clipboard")));
app.use(BASE_PATH, express.static(PUBLIC_DIR, { extensions: ["html"] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PROXY_SECRET = process.env.PROXY_SECRET || "";
if (!PROXY_SECRET) {
  console.error("FATAL: PROXY_SECRET is not set. Refusing to start — WebSocket auth would be bypassed.");
  process.exit(1);
}
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== BASE_PATH + "/ws") {
    socket.destroy();
    return;
  }
  if (!timingEqual(req.headers["x-proxy-secret"], PROXY_SECRET)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleSession(ws, url.searchParams.get("target"));
  });
});

const activeByTarget = new Map(); 

function sshConnectOpts(target, sock) {
  return {
    host: sock ? undefined : target.host,
    port: sock ? undefined : target.port,
    sock: sock || undefined,
    username: target.user,
    privateKey: SSH_KEY,
    readyTimeout: 15000,
    keepaliveInterval: 20000,
    keepaliveCountMax: 3,
    hostVerifier: (key) => verifyHostKey(target.host, key),
  };
}

function connectWithJump(target, cb) {
  if (!target.via) {
    const ssh = new SshClient();
    ssh.on("ready", () => cb(null, { ssh, jump: null }));
    ssh.on("error", (e) => cb(e));
    ssh.connect(sshConnectOpts(target));
    return;
  }
  const jumpTarget = TARGETS[target.via];
  if (!jumpTarget) return cb(new Error(`unknown jump target: ${target.via}`));
  const jump = new SshClient();
  jump.on("ready", () => {
    jump.forwardOut("127.0.0.1", 0, target.host, target.port, (err, stream) => {
      if (err) { try { jump.end(); } catch {} return cb(err); }
      const ssh = new SshClient();
      ssh.on("ready", () => cb(null, { ssh, jump }));
      ssh.on("error", (e) => { try { jump.end(); } catch {} cb(e); });
      ssh.connect(sshConnectOpts(target, stream));
    });
  });
  jump.on("error", (e) => cb(new Error(`jump via ${target.via}: ${e.message}`)));
  jump.connect(sshConnectOpts(jumpTarget));
}

function handleSession(ws, targetId) {
  const target = TARGETS[targetId];
  if (!target) {
    sendJson(ws, { type: "error", msg: `unknown target: ${targetId}` });
    ws.close();
    return;
  }

  const prev = activeByTarget.get(targetId);
  if (prev) {
    try {
      sendJson(prev.ws, { type: "status", state: "kicked", msg: "replaced by a newer connection" });
      prev.ws.close(4000, "takeover");
    } catch {}
    try { prev.ssh.end(); } catch {}
    try { prev.jump && prev.jump.end(); } catch {}
    activeByTarget.delete(targetId);
  }

  sendJson(ws, { type: "status", state: "connecting", target: targetId });

  let stream = null;
  let closed = false;
  let entry = { ws, ssh: null, jump: null };
  activeByTarget.set(targetId, entry);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!stream) return;
    if (msg.type === "stdin" && typeof msg.data === "string") {
      stream.write(msg.data);
    } else if (msg.type === "resize") {
      const cols = Number(msg.cols) || 80;
      const rows = Number(msg.rows) || 24;
      try { stream.setWindow(rows, cols, 0, 0); } catch {}
    } else if (msg.type === "ping") {
      sendJson(ws, { type: "pong", t: msg.t });
    }
  });

  ws.on("close", () => {
    closed = true;
    if (activeByTarget.get(targetId) === entry) activeByTarget.delete(targetId);
    try { entry.ssh && entry.ssh.end(); } catch {}
    try { entry.jump && entry.jump.end(); } catch {}
  });

  connectWithJump(target, (err, pair) => {
    if (err) {
      sendJson(ws, { type: "error", msg: "ssh: " + err.message });
      try { ws.close(); } catch {}
      if (activeByTarget.get(targetId) === entry) activeByTarget.delete(targetId);
      return;
    }
    if (closed) {
      try { pair.ssh.end(); } catch {}
      try { pair.jump && pair.jump.end(); } catch {}
      return;
    }
    entry.ssh = pair.ssh;
    entry.jump = pair.jump;
    sendJson(ws, { type: "status", state: "authenticated" });

    const tmuxSession = 'webterm-' + targetId.replace(/[^A-Za-z0-9_-]/g,'_');
    const remoteCmd = "exec tmux -2 new-session -A -s " + tmuxSession;
    pair.ssh.exec(remoteCmd, { pty: { term: "xterm-256color", cols: 120, rows: 32 } }, (err, s) => {
      if (err) {
        sendJson(ws, { type: "error", msg: "shell failed: " + err.message });
        try { pair.ssh.end(); } catch {}
        try { pair.jump && pair.jump.end(); } catch {}
        return;
      }
      stream = s;
      sendJson(ws, { type: "status", state: "ready" });
      s.on("data", (d) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "stdout", data: d.toString("utf8") })));
      s.stderr.on("data", (d) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "stdout", data: d.toString("utf8") })));
      s.on("close", () => {
        sendJson(ws, { type: "status", state: "closed" });
        try { pair.ssh.end(); } catch {}
        try { pair.jump && pair.jump.end(); } catch {}
        try { ws.close(); } catch {}
      });
    });

    pair.ssh.on("error", (e) => {
      sendJson(ws, { type: "error", msg: "ssh: " + e.message });
      try { ws.close(); } catch {}
    });
    pair.ssh.on("end", () => {
      if (activeByTarget.get(targetId) === entry) activeByTarget.delete(targetId);
      try { pair.jump && pair.jump.end(); } catch {}
    });
  });
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

server.listen(PORT, HOST, () => {
  console.log(`RemoteTerminal listening on ${HOST}:${PORT} (base ${BASE_PATH})`);
  console.log(`Targets: ${Object.keys(TARGETS).join(", ")}`);
});
