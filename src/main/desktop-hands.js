const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// Commands that are NEVER allowed
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /sudo\s+rm/,
  /mkfs/,
  /dd\s+if=/,
  />\s*\/dev\//,
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

async function getChromeTabs() {
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

module.exports = {
  executeCommand,
  takeScreenshot,
  openApp,
  osascript,
  isCommandSafe,
  getChromeProfiles,
  findChromeProfile,
  openChromeWithProfile,
  listChromeProfiles,
  getChromeTabs,
  getActiveTabInfo,
  closeTab,
  switchToTab,
  newTab,
};