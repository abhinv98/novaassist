const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// Commands that are NEVER allowed
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo\s+rm/,
  /mkfs/,
  /dd\s+if=/,
  /(?<![12])>\s*\/dev\/(?!null)/,
  /chmod\s+777\s+\//,
  /:(){ :\|:& };:/,
];

function isCommandSafe(command) {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return false;
    }
  }
  return true;
}

function executeCommand(command) {
  return new Promise((resolve, reject) => {
    if (!isCommandSafe(command)) {
      reject(new Error(`Blocked unsafe command: ${command}`));
      return;
    }

    console.log(`🖥️  Executing: ${command}`);

    exec(command, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          success: false,
          command,
          error: error.message,
          stderr: stderr.trim(),
        });
      } else {
        resolve({
          success: true,
          command,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      }
    });
  });
}

function takeScreenshot(outputPath = "/tmp/nova_screenshot.png") {
  return executeCommand(`screencapture -x ${outputPath}`);
}

function openApp(appName) {
  return executeCommand(`open -a "${appName}"`);
}

function osascript(script) {
  const escaped = script.replace(/'/g, "'\\''");
  return executeCommand(`osascript -e '${escaped}'`);
}

// ─── Chrome Profile Support ─────────────────────────────────

function getChromeProfiles() {
  const localStatePath = path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "Local State"
  );

  try {
    const data = JSON.parse(fs.readFileSync(localStatePath, "utf-8"));
    const infoCache = data.profile?.info_cache || {};

    const profiles = [];
    for (const [dirName, info] of Object.entries(infoCache)) {
      profiles.push({
        directory: dirName,
        name: info.name || dirName,
        shortcut_name: info.shortcut_name || info.name || dirName,
        gaia_name: info.gaia_given_name || info.gaia_name || "",
        email: info.user_name || "",
      });
    }
    return profiles;
  } catch (err) {
    console.error("Failed to read Chrome profiles:", err.message);
    return [];
  }
}

function findChromeProfile(query) {
  const profiles = getChromeProfiles();
  let q = query.toLowerCase().trim();

  const aliases = {
    "certifies": "ecultify",
    "eclipse": "ecultify",
    "equality": "ecultify",
    "e cultify": "ecultify",
    "echo fi": "ecultify",
    "cultivate": "ecultify",
    "cult": "ecultify",
  };
  if (aliases[q]) q = aliases[q];

  // Exact match first
  const exact = profiles.find(
    (p) =>
      p.name.toLowerCase() === q ||
      p.shortcut_name.toLowerCase() === q ||
      p.gaia_name.toLowerCase() === q ||
      p.email.toLowerCase() === q
  );
  if (exact) return exact;

  // Fuzzy match — check if query is contained in any field
  const fuzzy = profiles.find(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.shortcut_name.toLowerCase().includes(q) ||
      p.gaia_name.toLowerCase().includes(q) ||
      p.email.toLowerCase().includes(q)
  );
  if (fuzzy) return fuzzy;

  return null;
}

function openChromeWithProfile(profileQuery) {
  const profile = findChromeProfile(profileQuery);

  if (!profile) {
    const allProfiles = getChromeProfiles();
    const names = allProfiles.map((p) => p.name).join(", ");
    return Promise.resolve({
      success: false,
      command: `open chrome profile: ${profileQuery}`,
      error: `Profile "${profileQuery}" not found. Available profiles: ${names}`,
    });
  }

  console.log(`🔍 Matched profile: "${profile.name}" (dir: ${profile.directory})`);
  return executeCommand(
    `open -a "Google Chrome" --args --profile-directory="${profile.directory}"`
  );
}

function listChromeProfiles() {
  const profiles = getChromeProfiles();
  return profiles
    .map((p) => `  • ${p.name} (${p.email || "no email"}) → ${p.directory}`)
    .join("\n");
}

// ─── Chrome Tab Management ──────────────────────────────────

async function isChromeRunning() {
  const result = await executeCommand(
    "osascript -e 'application \"Google Chrome\" is running'"
  );
  return result.success && result.stdout?.trim() === "true";
}

async function getChromeTabs() {
  if (!(await isChromeRunning())) return [];
  const script = `
tell application "Google Chrome"
  set tabInfo to ""
  set windowCount to count of windows
  repeat with w from 1 to windowCount
    set tabCount to count of tabs of window w
    repeat with t from 1 to tabCount
      set tabTitle to title of tab t of window w
      set tabURL to URL of tab t of window w
      set tabInfo to tabInfo & tabTitle & "|||" & tabURL & "\\n"
    end repeat
  end repeat
  return tabInfo
end tell`;
  const escaped = script.replace(/'/g, "'\\''");
  const result = await executeCommand(`osascript -e '${escaped}'`);
  if (!result.success || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .filter((l) => l.includes("|||"))
    .map((l) => {
      const [title, url] = l.split("|||");
      return { title: (title || "").trim(), url: (url || "").trim() };
    });
}

async function getActiveTabInfo() {
  if (!(await isChromeRunning())) return { title: "", url: "", content: "" };
  const [titleResult, urlResult, textResult] = await Promise.all([
    executeCommand(
      'osascript -e \'tell application "Google Chrome" to get title of active tab of front window\''
    ),
    executeCommand(
      'osascript -e \'tell application "Google Chrome" to get URL of active tab of front window\''
    ),
    executeCommand(
      'osascript -e \'tell application "Google Chrome" to execute active tab of front window javascript "document.body.innerText.substring(0, 2000)"\''
    ),
  ]);
  return {
    title: titleResult.stdout || "",
    url: urlResult.stdout || "",
    content: textResult.stdout || "",
  };
}

async function closeTab() {
  return executeCommand(
    'osascript -e \'tell application "Google Chrome" to close active tab of front window\''
  );
}

async function switchToTab(query) {
  const tabs = await getChromeTabs();
  const q = query.toLowerCase().trim();

  const idx = parseInt(q, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= tabs.length) {
    return executeCommand(
      `osascript -e 'tell application "Google Chrome" to set active tab index of front window to ${idx}'`
    );
  }

  const matchIdx = tabs.findIndex(
    (t) =>
      t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
  );
  if (matchIdx >= 0) {
    return executeCommand(
      `osascript -e 'tell application "Google Chrome" to set active tab index of front window to ${matchIdx + 1}'`
    );
  }
  return { success: false, error: `No tab matching "${query}" found` };
}

async function newTab(url) {
  if (url) {
    const script = `tell application "Google Chrome"
activate
if (count of windows) = 0 then
make new window
set URL of active tab of front window to "${url}"
else
make new tab at end of tabs of front window with properties {URL:"${url}"}
end if
end tell`;
    const escaped = script.replace(/'/g, "'\\''");
    return executeCommand(`osascript -e '${escaped}'`);
  }
  return executeCommand(
    'osascript -e \'tell application "Google Chrome" to make new tab at end of tabs of front window\''
  );
}

// ─── App Launcher (Spotlight-powered) ────────────────────────

let appCache = null;
let appCacheTime = 0;
const APP_CACHE_TTL = 60000;

async function getInstalledApps() {
  if (appCache && Date.now() - appCacheTime < APP_CACHE_TTL) return appCache;
  const result = await executeCommand(
    'mdfind "kMDItemKind == \'Application\'" -onlyin /Applications -onlyin /System/Applications -onlyin ~/Applications'
  );
  if (!result.success || !result.stdout) return [];
  appCache = result.stdout.split("\n").filter(Boolean).map((p) => ({
    path: p,
    name: path.basename(p, ".app"),
  }));
  appCacheTime = Date.now();
  return appCache;
}

async function findAndOpenApp(query) {
  const q = query.toLowerCase().trim();

  const knownAliases = {
    "cursor": "Cursor",
    "code": "Visual Studio Code",
    "vscode": "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "chrome": "Google Chrome",
    "safari": "Safari",
    "terminal": "Terminal",
    "finder": "Finder",
    "notes": "Notes",
    "messages": "Messages",
    "slack": "Slack",
    "spotify": "Spotify",
    "discord": "Discord",
    "figma": "Figma",
    "notion": "Notion",
    "iterm": "iTerm",
    "iterm2": "iTerm",
    "postman": "Postman",
    "docker": "Docker",
    "xcode": "Xcode",
    "music": "Music",
    "mail": "Mail",
    "calendar": "Calendar",
    "photos": "Photos",
    "preview": "Preview",
    "activity monitor": "Activity Monitor",
    "system preferences": "System Preferences",
    "system settings": "System Settings",
    "whatsapp": "WhatsApp",
    "watsapp": "WhatsApp",
    "what's app": "WhatsApp",
    "telegram": "Telegram",
    "zoom": "zoom.us",
    "teams": "Microsoft Teams",
    "microsoft teams": "Microsoft Teams",
  };

  if (knownAliases[q]) {
    return executeCommand(`open -a "${knownAliases[q]}"`);
  }

  const apps = await getInstalledApps();
  const exact = apps.find((a) => a.name.toLowerCase() === q);
  if (exact) return executeCommand(`open "${exact.path}"`);

  const partial = apps.find((a) => a.name.toLowerCase().includes(q));
  if (partial) return executeCommand(`open "${partial.path}"`);

  const words = q.split(/\s+/);
  const multi = apps.find((a) => {
    const lower = a.name.toLowerCase();
    return words.every((w) => lower.includes(w));
  });
  if (multi) return executeCommand(`open "${multi.path}"`);

  return executeCommand(`open -a "${query}"`);
}

// ─── File Search (Spotlight) ─────────────────────────────────

async function findFiles(query, scope) {
  const scopeArg = scope ? `-onlyin "${scope}"` : "";
  const result = await executeCommand(
    `mdfind ${scopeArg} "${query}" | head -20`
  );
  if (!result.success || !result.stdout) {
    return { success: true, stdout: "No files found.", results: [] };
  }
  const files = result.stdout.split("\n").filter(Boolean);
  const formatted = files.map((f) => `  ${path.basename(f)}  →  ${f}`).join("\n");
  return {
    success: true,
    stdout: `Found ${files.length} result(s):\n${formatted}`,
    results: files,
  };
}

async function findFilesByName(name) {
  const result = await executeCommand(
    `mdfind "kMDItemFSName == '*${name}*'cd" | head -20`
  );
  if (!result.success || !result.stdout) {
    return { success: true, stdout: "No files found.", results: [] };
  }
  const files = result.stdout.split("\n").filter(Boolean);
  const formatted = files.map((f) => `  ${path.basename(f)}  →  ${f}`).join("\n");
  return {
    success: true,
    stdout: `Found ${files.length} result(s):\n${formatted}`,
    results: files,
  };
}

// ─── Apple Notes Integration ─────────────────────────────────

function escapeAppleScript(str) {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function createNote(title, body) {
  const safeTitle = escapeAppleScript(title);
  const safeBody = escapeAppleScript(body);
  const script = `tell application "Notes"
activate
tell account "iCloud"
make new note at folder "Notes" with properties {name:"${safeTitle}", body:"<h1>${safeTitle}</h1><br>${safeBody.replace(/\n/g, "<br>")}"}
end tell
end tell`;
  return osascript(script);
}

async function readNote(titleQuery) {
  const safeQ = escapeAppleScript(titleQuery);
  const script = `tell application "Notes"
set matchedNotes to {}
repeat with n in notes
if name of n contains "${safeQ}" then
set end of matchedNotes to {noteName:name of n, noteBody:plaintext of n}
if (count of matchedNotes) >= 1 then exit repeat
end if
end repeat
if (count of matchedNotes) = 0 then
return "NO_MATCH"
else
set r to item 1 of matchedNotes
return (noteName of r) & "|||" & (noteBody of r)
end if
end tell`;
  const result = await osascript(script);
  if (!result.success || !result.stdout || result.stdout === "NO_MATCH") {
    return { success: false, error: `No note matching "${titleQuery}" found.` };
  }
  const sep = result.stdout.indexOf("|||");
  return {
    success: true,
    title: sep >= 0 ? result.stdout.substring(0, sep) : titleQuery,
    body: sep >= 0 ? result.stdout.substring(sep + 3) : result.stdout,
    stdout: result.stdout.substring(sep >= 0 ? sep + 3 : 0),
  };
}

async function listNotes(limit = 10) {
  const script = `tell application "Notes"
set output to ""
set noteList to notes
set maxCount to ${limit}
if (count of noteList) < maxCount then set maxCount to (count of noteList)
repeat with i from 1 to maxCount
set n to item i of noteList
set output to output & (i as text) & ". " & name of n & "\\n"
end repeat
return output
end tell`;
  const result = await osascript(script);
  return {
    success: result.success,
    stdout: result.stdout || "No notes found.",
  };
}

async function appendToNote(titleQuery, textToAppend) {
  const safeQ = escapeAppleScript(titleQuery);
  const safeText = escapeAppleScript(textToAppend);
  const script = `tell application "Notes"
repeat with n in notes
if name of n contains "${safeQ}" then
set body of n to (body of n) & "<br>${safeText.replace(/\n/g, "<br>")}"
return "OK"
end if
end repeat
return "NO_MATCH"
end tell`;
  const result = await osascript(script);
  if (result.stdout === "NO_MATCH") {
    return { success: false, error: `No note matching "${titleQuery}" found.` };
  }
  return { success: true, stdout: `Appended to note "${titleQuery}".` };
}

// ─── Cursor IDE Integration ──────────────────────────────────

async function openInCursor(folderPath) {
  const resolved = folderPath.replace(/^~/, process.env.HOME);
  return executeCommand(`cursor "${resolved}"`);
}

async function createProjectAndOpen(name, parentDir, taskDescription) {
  const parent = (parentDir || "~/Desktop").replace(/^~/, process.env.HOME);
  const projectPath = path.join(parent, name);

  await executeCommand(`mkdir -p "${projectPath}"`);

  if (taskDescription) {
    fs.writeFileSync(path.join(projectPath, "TASK.md"), `# ${name}\n\n${taskDescription}\n`);
  }

  const openResult = await executeCommand(`cursor "${projectPath}"`);
  return {
    success: true,
    projectPath,
    stdout: `Project created at ${projectPath} and opened in Cursor.`,
    ...openResult,
  };
}

// ─── Finder Integration ──────────────────────────────────────

async function revealInFinder(filePath) {
  const resolved = filePath.replace(/^~/, process.env.HOME);
  return executeCommand(`open -R "${resolved}"`);
}

async function openInFinder(folderPath) {
  const resolved = folderPath.replace(/^~/, process.env.HOME);
  return executeCommand(`open "${resolved}"`);
}

// ─── Running Apps Context ────────────────────────────────────

async function getRunningApps() {
  const result = await executeCommand(
    "osascript -e 'tell application \"System Events\" to get name of every process whose background only is false'"
  );
  if (!result.success || !result.stdout) return [];
  return result.stdout.split(", ").map((s) => s.trim()).filter(Boolean);
}

// ─── Screen Agent (Computer Use) ─────────────────────────────

function _findPython() {
  const fs = require("fs");
  const candidates = [
    "/opt/anaconda3/bin/python3",
    "/usr/local/bin/python3",
    "/opt/homebrew/bin/python3",
    "/usr/bin/python3",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "python3";
}

function _scriptPath(name) {
  try {
    const { app } = require("electron");
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "python", name);
    }
  } catch (e) {}
  return path.join(__dirname, "..", "python", name);
}

function runScreenAgent(task, maxSteps = 10) {
  const { spawn } = require("child_process");
  const payload = JSON.stringify({ task, max_steps: maxSteps });

  return new Promise((resolve) => {
    const proc = spawn(_findPython(), [
      _scriptPath("screen_agent.py"),
      payload,
    ], {
      env: {
        ...process.env,
        AWS_REGION: process.env.AWS_REGION || "us-east-1",
      },
      timeout: 120000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      const lines = d.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("SCREEN_AGENT_LOG:")) {
          console.log("🖱️  " + line.replace("SCREEN_AGENT_LOG:", ""));
        }
      }
    });

    proc.on("close", (code) => {
      const resultLine = stdout.split("\n").find((l) => l.startsWith("SCREEN_AGENT_RESULT:"));
      if (resultLine) {
        try {
          const result = JSON.parse(resultLine.replace("SCREEN_AGENT_RESULT:", ""));
          resolve(result);
        } catch (e) {
          resolve({ success: false, error: "Failed to parse screen agent result" });
        }
      } else {
        resolve({ success: false, error: stderr || `Screen agent exited with code ${code}` });
      }
    });

    proc.on("error", (e) => {
      resolve({ success: false, error: e.message });
    });
  });
}

// ─── Describe Screen (AX element detection) ─────────────────

function runDescribeScreen() {
  const { spawn } = require("child_process");

  return new Promise((resolve) => {
    const proc = spawn(_findPython(), [
      _scriptPath("describe_screen.py"),
    ], {
      env: { ...process.env },
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const resultLine = stdout.split("\n").find((l) => l.startsWith("DESCRIBE_RESULT:"));
      if (resultLine) {
        try {
          resolve(JSON.parse(resultLine.replace("DESCRIBE_RESULT:", "")));
        } catch (e) {
          resolve({ elements_text: "Could not detect elements.", screenshot_path: "/tmp/nova_describe_screen.png", error: "Parse error" });
        }
      } else {
        resolve({ elements_text: "Could not detect elements.", screenshot_path: "/tmp/nova_describe_screen.png", error: stderr || `Exited with code ${code}` });
      }
    });

    proc.on("error", (e) => {
      resolve({ elements_text: "Could not detect elements.", screenshot_path: "", error: e.message });
    });
  });
}

// ─── Notification Agent ──────────────────────────────────────

function runNotificationAgent(minutes = 60) {
  const { spawn } = require("child_process");
  const payload = JSON.stringify({ minutes, limit: 20 });

  return new Promise((resolve) => {
    const proc = spawn(_findPython(), [
      _scriptPath("notification_agent.py"),
      payload,
    ], {
      env: { ...process.env },
      timeout: 15000,
    });

    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", () => {});

    proc.on("close", () => {
      const line = stdout.split("\n").find((l) => l.startsWith("NOTIFICATION_RESULT:"));
      if (line) {
        try {
          resolve(JSON.parse(line.replace("NOTIFICATION_RESULT:", "")));
        } catch (e) {
          resolve({ notifications: [], error: "Parse error" });
        }
      } else {
        resolve({ notifications: [], error: "No result" });
      }
    });

    proc.on("error", (e) => {
      resolve({ notifications: [], error: e.message });
    });
  });
}

module.exports = {
  executeCommand,
  takeScreenshot,
  openApp,
  osascript,
  isCommandSafe,
  isChromeRunning,
  getChromeProfiles,
  findChromeProfile,
  openChromeWithProfile,
  listChromeProfiles,
  getChromeTabs,
  getActiveTabInfo,
  closeTab,
  switchToTab,
  newTab,
  findAndOpenApp,
  findFiles,
  findFilesByName,
  createNote,
  readNote,
  listNotes,
  appendToNote,
  openInCursor,
  createProjectAndOpen,
  revealInFinder,
  openInFinder,
  getRunningApps,
  runScreenAgent,
  runDescribeScreen,
  runNotificationAgent,
};