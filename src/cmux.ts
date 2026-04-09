import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";
import * as net from "net";
import { randomUUID } from "crypto";
import * as fs from "fs";

const execAsync = promisify(execCb);
import { homedir } from "os";
import { join } from "path";
import { getPreferenceValues } from "@raycast/api";

const SOCKET_PATH =
  process.env.CMUX_SOCKET_PATH || join(homedir(), "Library/Application Support/cmux/cmux.sock");

const ENV = {
  ...process.env,
  PATH: `/Applications/cmux.app/Contents/Resources/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
};

function getPassword(): string {
  const { cmuxPassword } = getPreferenceValues<{ cmuxPassword?: string }>();
  return cmuxPassword || "";
}

// ─── Socket: single connection, multiple requests ───────────

function socketBatch(
  requests: Array<{ method: string; params: Record<string, unknown> }>,
): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const pw = getPassword();
    const socket = net.createConnection({ path: SOCKET_PATH });
    const results = new Map<string, unknown>();
    const needAuth = !!pw;
    const totalExpected = requests.length + (needAuth ? 1 : 0);
    let received = 0;
    let buffer = "";

    socket.on("connect", () => {
      // Send auth + all requests in one burst
      if (needAuth) {
        socket.write(
          JSON.stringify({ id: "__auth__", method: "auth", params: { password: pw } }) + "\n",
        );
      }
      for (const req of requests) {
        const id = randomUUID();
        req._id = id;
        socket.write(JSON.stringify({ id, method: req.method, params: req.params }) + "\n");
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();

      // Parse newline-delimited JSON responses
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        if (!part.trim()) continue;
        try {
          const res = JSON.parse(part);
          received++;
          if (res.id !== "__auth__") {
            results.set(res.id, res.ok ? res.result : null);
          }
          if (received >= totalExpected) {
            socket.end();
            // Map back to request index
            const mapped = new Map<string, unknown>();
            for (const req of requests) {
              mapped.set(req._id as string, results.get(req._id as string));
            }
            resolve(mapped);
          }
        } catch {
          /* partial JSON in this chunk */
        }
      }

      // Also try parsing the remaining buffer (response might not end with \n)
      if (buffer.trim()) {
        try {
          const res = JSON.parse(buffer);
          received++;
          buffer = "";
          if (res.id !== "__auth__") {
            results.set(res.id, res.ok ? res.result : null);
          }
          if (received >= totalExpected) {
            socket.end();
            const mapped = new Map<string, unknown>();
            for (const req of requests) {
              mapped.set(req._id as string, results.get(req._id as string));
            }
            resolve(mapped);
          }
        } catch {
          /* incomplete */
        }
      }
    });

    socket.on("error", (err) => reject(new Error(`cmux socket: ${err.message}`)));
    socket.setTimeout(5000, () => {
      socket.end();
      // Return whatever we have
      const mapped = new Map<string, unknown>();
      for (const req of requests) {
        mapped.set(req._id as string, results.get(req._id as string));
      }
      resolve(mapped);
    });
  });
}

// ─── CLI ────────────────────────────────────────────────────

function cmuxPrefix(): string {
  const pw = getPassword();
  return pw ? `cmux --password ${pw}` : "cmux";
}

function run(args: string): string {
  return execSync(`${cmuxPrefix()} ${args}`, { encoding: "utf-8", timeout: 5000, env: ENV }).trim();
}

// ─── Types ──────────────────────────────────────────────────

export interface Surface {
  surfaceId: string;
  type: "terminal" | "browser";
  title: string;
  workspaceId: string;
  workspaceName: string;
}

export interface ScanResult {
  surface: Surface;
  screen: string;
  lastOutput: string;
  fullOutput: string;
  rawScreen: string;
  state: SessionState;
}

// ─── Known non-Claude titles ────────────────────────────────

const SKIP_TITLES = /^(nvim|lazygit|vim|nano|htop|top|yarn |npm |node |docker)/i;

// ─── Main scan (tree CLI + socket batch reads) ──────────────

export async function scanIdle(): Promise<ScanResult[]> {
  // Step 1: parse tree (one CLI call — fast)
  const tree = run("tree --all");

  const surfaces: Surface[] = [];
  let wsId = "";
  let wsName = "";

  for (const line of tree.split("\n")) {
    const wsMatch = line.match(/workspace\s+(workspace:\d+)\s+"([^"]+)"/);
    if (wsMatch) {
      wsId = wsMatch[1];
      wsName = wsMatch[2];
      continue;
    }
    const wsMatch2 = line.match(/workspace\s+(workspace:\d+)/);
    if (wsMatch2 && !wsMatch) {
      wsId = wsMatch2[1];
      wsName = wsId;
      continue;
    }
    const sfMatch = line.match(/surface\s+(surface:\d+)\s+\[(\w+)\]\s+"([^"]*)"/);
    if (sfMatch) {
      surfaces.push({
        surfaceId: sfMatch[1],
        type: sfMatch[2] as "terminal" | "browser",
        title: sfMatch[3],
        workspaceId: wsId,
        workspaceName: wsName,
      });
    }
  }

  // Step 2: filter candidates
  const candidates = surfaces.filter(
    (s) => s.type === "terminal" && !SKIP_TITLES.test(s.title),
  );
  if (candidates.length === 0) return [];

  // Step 3: read all screens in parallel (Node.js Promise.all)
  const screens = await readScreensParallel(candidates);

  // Step 4: detect waiting sessions (idle or permission prompt)
  const results: ScanResult[] = [];
  for (const surface of candidates) {
    const screen = screens.get(surface.surfaceId);
    if (!screen) continue;
    const state = detectClaudeState(screen, surface.title);
    if (state) {
      // For permission state, show raw screen so options are visible
      const full = state === "permission" ? getPermissionContent(screen) : getFullOutput(screen);
      results.push({
        surface,
        screen,
        lastOutput: getLastOutput(screen),
        fullOutput: full,
        rawScreen: screen,
        state,
      });
    }
  }

  return results;
}

// ─── CLI fallback for screen reading ────────────────────────

async function readScreensParallel(candidates: Surface[]): Promise<Map<string, string>> {
  const prefix = cmuxPrefix();
  const results = await Promise.all(
    candidates.map(async (s) => {
      try {
        const { stdout } = await execAsync(
          `${prefix} read-screen --workspace ${s.workspaceId} --surface ${s.surfaceId} --lines 50`,
          { env: ENV, timeout: 5000 },
        );
        return { id: s.surfaceId, screen: stdout.trim() };
      } catch {
        return { id: s.surfaceId, screen: "" };
      }
    }),
  );

  const map = new Map<string, string>();
  for (const r of results) {
    if (r.screen) map.set(r.id, r.screen);
  }
  return map;
}

// ─── New session ────────────────────────────────────────────

export function newSession(cwd?: string): void {
  const cwdFlag = cwd ? ` --cwd ${JSON.stringify(cwd)}` : "";
  run(`new-workspace${cwdFlag} --command claude`);
}

// ─── Actions ────────────────────────────────────────────────

export function focusSurface(surfaceId: string, workspaceId: string): void {
  run(`workspace-action --workspace ${workspaceId} --action select`);
  run(`focus-surface --surface ${surfaceId}`);
}

export function sendText(surfaceId: string, workspaceId: string, text: string): void {
  const prefix = cmuxPrefix();
  const ws = `--workspace ${workspaceId} --surface ${surfaceId}`;
  execSync(`${prefix} send ${ws} ${JSON.stringify(text)} && ${prefix} send-key ${ws} enter`, {
    encoding: "utf-8",
    timeout: 5000,
    env: ENV,
  });
}

// ─── Detection ──────────────────────────────────────────────

const PROMPT_RE = /❯/;
const SEPARATOR_RE = /─{10,}/;
const BUSY_PATTERNS = [/Running…/, /Running\.\.\./, /Generating/, /Thinking/, /⎿\s+Running/];

// Permission/confirmation prompt patterns (specific to Claude Code permission dialogs)
const PERMISSION_RE = /Do you want to proceed\?|requested permissions?|❯\s*\d+\.\s*Yes/i;

export type SessionState = "idle" | "permission" | "busy";

/**
 * Detect Claude Code session state.
 * Returns "idle", "permission", "busy", or null if not a Claude session.
 */
// Claude Code titles start with braille spinner/status characters
const CLAUDE_TITLE_RE = /^[⠁⠂⠃⠄⠅⠆⠇⠈⠉⠊⠋⠌⠍⠎⠏⠐⠑⠒⠓⠔⠕⠖⠗⠘⠙⠚⠛⠜⠝⠞⠟⠠⠡⠢⠣⠤⠥⠦⠧⠨⠩⠪⠫⠬⠭⠮⠯⠰⠱⠲⠳⠴⠵⠶⠷⠸⠹⠺⠻⠼⠽⠾⠿✳✶◐◑◒◓⣾⣽⣻⢿⡿⣟⣯⣷▝▞▖▘▗▚▐▌]/;

export function detectClaudeState(screen: string, title?: string): SessionState | null {
  const lines = screen.split("\n");
  const fullText = lines.join("\n");

  // Case 0 (highest priority): permission prompt — check entire screen
  // Permission dialogs change the UI layout, so check before any other detection
  if (PERMISSION_RE.test(fullText)) {
    return "permission";
  }

  // Check 1: separator lines in bottom 8 (Claude Code UI active)
  const bottom = lines.slice(-8);
  const hasSeparator = bottom.some((l) => SEPARATOR_RE.test(l));

  // Check 2: title looks like Claude Code
  const hasClaudeTitle = title ? CLAUDE_TITLE_RE.test(title) : false;

  // Must pass at least one check
  if (!hasSeparator && !hasClaudeTitle) return null;

  // Exclude exited sessions: last 3 lines should NOT have a shell prompt
  const last3 = lines.slice(-3).join("\n");
  const user = process.env.USER || process.env.LOGNAME || "";
  if (/\$\s*$/.test(last3) || (user && new RegExp(`${user}\\s+~/`).test(last3))) return null;

  // Case 2: idle ❯ prompt (empty, waiting for new command)
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }

  if (promptIdx !== -1) {
    const afterPrompt = lines[promptIdx].substring(lines[promptIdx].indexOf("❯") + 1).trim();
    const isEmpty = !/^[\w\dㄱ-ㅎㅏ-ㅣ가-힣/!@#]/.test(afterPrompt);
    if (isEmpty) {
      const above = lines.slice(Math.max(0, promptIdx - 8), promptIdx).join("\n");
      if (!BUSY_PATTERNS.some((p) => p.test(above))) {
        return "idle";
      }
    }
  }

  // Case 3: it's a Claude session but busy
  return "busy";
}

export function getLastOutput(screen: string): string {
  const lines = screen.split("\n");

  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }

  const meaningful: string[] = [];
  const start = Math.max(0, promptIdx - 10);
  for (let i = start; i < promptIdx; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !/^[─━]+$/.test(trimmed)) {
      meaningful.push(trimmed);
    }
  }

  return meaningful.slice(-3).join(" ").slice(0, 120) || "(no output)";
}

/**
 * Extract just the permission request block from the screen.
 * Finds the last tool request (⏺ or tool name) and shows only that part.
 */
export function getPermissionContent(screen: string): string {
  const lines = screen.split("\n");

  // Find the last ⏺ marker (tool request start) — scan from bottom
  let blockStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/⏺/.test(lines[i])) {
      blockStart = i;
      break;
    }
  }
  if (blockStart === -1) blockStart = Math.max(0, lines.length - 12);

  // Collect lines from block start, skip separators and status bar
  const meaningful: string[] = [];
  for (let i = blockStart; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^[─━]+/.test(trimmed)) continue;
    if (/^\[.*(?:Opus|Sonnet|Haiku)/.test(trimmed)) continue;
    if (/Snarkbriar/.test(trimmed)) continue;
    if (/^❯\s*$/.test(trimmed)) continue;
    meaningful.push(lines[i]);
  }
  return meaningful.join("\n").trim() || "(no output)";
}

/**
 * Extract the LAST Claude response (from last ⏺ marker to the ❯ prompt).
 */
export function getFullOutput(screen: string): string {
  const lines = screen.split("\n");

  // Find the last ❯ prompt (empty one = idle)
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_RE.test(lines[i])) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx <= 0) return "(no output)";

  // Find the last ⏺ response marker before the prompt
  let responseStart = -1;
  for (let i = promptIdx - 1; i >= 0; i--) {
    if (/⏺/.test(lines[i])) {
      responseStart = i;
      break;
    }
  }
  if (responseStart === -1) responseStart = 0;

  // Collect lines between ⏺ and ❯, skip separators
  const meaningful: string[] = [];
  for (let i = responseStart; i < promptIdx; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && !/^[─━]+/.test(trimmed)) {
      meaningful.push(lines[i]);
    }
  }

  return meaningful.join("\n").trim() || "(no output)";
}

// ─── Skill scanner ──────────────────────────────────────────

export interface SkillInfo {
  value: string;
  title: string;
}

/**
 * Scan .claude/skills/ directories for available skills.
 * Reads SKILL.md frontmatter for name and description.
 */
export function scanSkills(): SkillInfo[] {
  const skills: SkillInfo[] = [{ value: "", title: "(Type manually)" }];

  // Find project root from cmux tree (cwd of the first workspace)
  const projectRoots = new Set<string>();
  try {
    const tree = run("tree --all");
    for (const line of tree.split("\n")) {
      const wsMatch = line.match(/workspace\s+workspace:\d+\s+"([^"]+)"/);
      if (wsMatch) {
        let p = wsMatch[1];
        if (p.startsWith("\u2026")) p = join(homedir(), p.slice(1));
        if (fs.existsSync(join(p, ".claude/skills"))) projectRoots.add(p);
      }
    }
  } catch {
    /* */
  }

  // Also scan global ~/.claude/skills/
  const globalSkillsDir = join(homedir(), ".claude/skills");
  if (fs.existsSync(globalSkillsDir)) projectRoots.add("__global__");

  // Recursively scan a skills directory (handles nested dirs like omc-learned/pr-review/)
  function scanDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const skillFile = join(dir, d.name, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, "utf-8").slice(0, 500);
            const nameMatch = content.match(/name:\s*(.+)/);
            const descMatch = content.match(/description:\s*(.+)/);
            const name = nameMatch ? nameMatch[1].trim() : d.name;
            const desc = descMatch ? descMatch[1].trim().slice(0, 50) : "";
            const value = `/${name}`;
            if (!skills.some((s) => s.value === value)) {
              skills.push({ value, title: `/${name}${desc ? ` \u2014 ${desc}` : ""}` });
            }
          } catch {
            const value = `/${d.name}`;
            if (!skills.some((s) => s.value === value)) {
              skills.push({ value, title: `/${d.name}` });
            }
          }
        } else {
          // Check subdirectories (e.g., omc-learned/pr-review/)
          scanDir(join(dir, d.name));
        }
      }
    } catch {
      /* */
    }
  }

  // Scan each project's .claude/skills/ + global
  for (const root of projectRoots) {
    const skillsDir = root === "__global__" ? globalSkillsDir : join(root, ".claude/skills");
    scanDir(skillsDir);
  }

  // Built-in + plugin skills
  const builtins: SkillInfo[] = [
    // Claude Code built-in
    { value: "/commit", title: "/commit \u2014 Create commit" },
    { value: "/compact", title: "/compact \u2014 Compact context" },
    { value: "/clear", title: "/clear \u2014 Clear conversation" },
    { value: "/update-config", title: "/update-config \u2014 Configure settings" },
    { value: "/keybindings-help", title: "/keybindings-help \u2014 Customize keybindings" },
    { value: "/simplify", title: "/simplify \u2014 Simplify code" },
    { value: "/loop", title: "/loop \u2014 Run on recurring interval" },
    { value: "/schedule", title: "/schedule \u2014 Scheduled remote agents" },
    { value: "/claude-api", title: "/claude-api \u2014 Build with Claude API" },
    // oh-my-claudecode
    { value: "/build-fix", title: "/build-fix \u2014 Fix build errors" },
    { value: "/plan", title: "/plan \u2014 Create plan" },
    { value: "/analyze", title: "/analyze \u2014 Deep analysis" },
    { value: "/deepsearch", title: "/deepsearch \u2014 Codebase search" },
    { value: "/research", title: "/research \u2014 Parallel research" },
    { value: "/autopilot", title: "/autopilot \u2014 Autonomous execution" },
    { value: "/ultrawork", title: "/ultrawork \u2014 Parallel agents" },
    { value: "/ultrapilot", title: "/ultrapilot \u2014 Parallel autopilot" },
    { value: "/ralph", title: "/ralph \u2014 Loop until complete" },
    { value: "/ralph-init", title: "/ralph-init \u2014 Initialize PRD" },
    { value: "/team", title: "/team \u2014 Coordinated agents" },
    { value: "/pipeline", title: "/pipeline \u2014 Sequential agent chaining" },
    { value: "/ecomode", title: "/ecomode \u2014 Token-efficient mode" },
    { value: "/code-review", title: "/code-review \u2014 Code review" },
    { value: "/security-review", title: "/security-review \u2014 Security review" },
    { value: "/tdd", title: "/tdd \u2014 Test-driven development" },
    { value: "/deepinit", title: "/deepinit \u2014 Deep codebase init" },
    { value: "/note", title: "/note \u2014 Save note" },
    { value: "/doctor", title: "/doctor \u2014 Diagnose OMC issues" },
    { value: "/learner", title: "/learner \u2014 Extract learned skill" },
    { value: "/help", title: "/help \u2014 OMC help" },
    { value: "/release", title: "/release \u2014 Release workflow" },
    { value: "/cancel", title: "/cancel \u2014 Cancel active mode" },
    { value: "/swarm", title: "/swarm \u2014 Coordinated agents (legacy)" },
    { value: "/psm", title: "/psm \u2014 Project Session Manager" },
    { value: "/trace", title: "/trace \u2014 Agent flow trace" },
    { value: "/review", title: "/review \u2014 Plan review" },
    { value: "/ralplan", title: "/ralplan \u2014 Plan consensus" },
    { value: "/ultraqa", title: "/ultraqa \u2014 QA cycling workflow" },
    { value: "/omc-setup", title: "/omc-setup \u2014 Setup OMC" },
    { value: "/hud", title: "/hud \u2014 Configure HUD" },
    { value: "/mcp-setup", title: "/mcp-setup \u2014 Configure MCP servers" },
    { value: "/skill-creator", title: "/skill-creator \u2014 Create/edit skills" },
    { value: "/git-master", title: "/git-master \u2014 Git expert" },
    { value: "/frontend-ui-ux", title: "/frontend-ui-ux \u2014 UI/UX designer" },
    { value: "/writer-memory", title: "/writer-memory \u2014 Writer memory system" },
    // claude-hud
    { value: "/claude-hud:setup", title: "/claude-hud:setup \u2014 Setup HUD" },
    { value: "/claude-hud:configure", title: "/claude-hud:configure \u2014 Configure HUD" },
    // planning-with-files
    { value: "/planning-with-files:plan", title: "/planning-with-files:plan \u2014 File-based planning" },
    // slack
    { value: "/slack:standup", title: "/slack:standup \u2014 Standup update" },
    { value: "/slack:find-discussions", title: "/slack:find-discussions \u2014 Find discussions" },
    { value: "/slack:draft-announcement", title: "/slack:draft-announcement \u2014 Draft announcement" },
    { value: "/slack:summarize-channel", title: "/slack:summarize-channel \u2014 Summarize channel" },
    { value: "/slack:channel-digest", title: "/slack:channel-digest \u2014 Channel digest" },
  ];

  const existing = new Set(skills.map((s) => s.value));
  for (const b of builtins) {
    if (!existing.has(b.value)) skills.push(b);
  }

  return skills;
}
