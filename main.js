const { app, BrowserWindow, ipcMain, globalShortcut, screen, systemPreferences, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { classifyIntent, analyzeScreenshot, generateObservation, describeScreen, summarizeDocument, validateBedrockAccess } = require('./src/main/brain');
const {
  executeCommand, takeScreenshot, openChromeWithProfile, findChromeProfile,
  getChromeTabs, getActiveTabInfo, closeTab, switchToTab, newTab,
  findAndOpenApp, findFiles, findFilesByName,
  createNote, readNote, listNotes, appendToNote,
  openInCursor, createProjectAndOpen,
  revealInFinder, openInFinder, getRunningApps,
  runScreenAgent, runDescribeScreen, runNotificationAgent,
} = require('./src/main/desktop-hands');
const { execSync } = require('child_process');
const { loadMemories, storeMemory, recallMemories, formatMemoriesForContext } = require('./src/main/memory');

// ─── Config Management ───────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.novaassist');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Config load error:', e.message);
  }
  return {};
}

function saveConfig(config) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Config save error:', e.message);
  }
}

function isSetupComplete() {
  const config = loadConfig();
  return config.setupComplete === true;
}

function applyConfigToEnv() {
  const config = loadConfig();
  if (config.aws?.accessKeyId) process.env.AWS_ACCESS_KEY_ID = config.aws.accessKeyId;
  if (config.aws?.secretAccessKey) process.env.AWS_SECRET_ACCESS_KEY = config.aws.secretAccessKey;
  if (config.aws?.region) process.env.AWS_REGION = config.aws.region;
  if (config.picovoice?.accessKey) process.env.PICOVOICE_ACCESS_KEY = config.picovoice.accessKey;
}

let _pythonPath = null;
function getPythonPath() {
  if (_pythonPath) return _pythonPath;
  const config = loadConfig();
  if (config.pythonPath && fs.existsSync(config.pythonPath)) {
    _pythonPath = config.pythonPath;
    return _pythonPath;
  }
  const candidates = [
    '/opt/anaconda3/bin/python3',
    '/usr/local/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/bin/python3',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      _pythonPath = p;
      return _pythonPath;
    }
  }
  try {
    const which = execSync('which python3', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (which) { _pythonPath = which; return _pythonPath; }
  } catch (e) {}
  _pythonPath = 'python3';
  return _pythonPath;
}

function getPythonScriptPath(scriptName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', scriptName);
  }
  return path.join(__dirname, 'src', 'python', scriptName);
}

let mainWindow;
let overlayWindow = null;
let overlayBusy = false;
let wakeWordProcess = null;

// ─── Session State ───────────────────────────────────────────────────────────

let session = {
  openTabs: [],
  activeTab: { title: '', url: '', content: '' },
  lastCommand: '',
  lastResult: '',
  recentActions: [],
};

async function updateSessionContext() {
  try {
    const [tabs, active] = await Promise.all([
      getChromeTabs(),
      getActiveTabInfo(),
    ]);
    session.openTabs = tabs;
    session.activeTab = active;
  } catch (e) {
    console.error('updateSessionContext error:', e.message);
  }
}

function addRecentAction(text) {
  session.recentActions.push(text);
  if (session.recentActions.length > 10) session.recentActions.shift();
}

// ─── Instant Acknowledgment ──────────────────────────────────────────────────

function quickAck(text) {
  try {
    const escaped = text.replace(/"/g, '\\"');
    execSync(`say -v Samantha -r 210 "${escaped}"`, { timeout: 5000 });
  } catch (e) {
    console.error('quickAck error:', e.message);
  }
}

function speakAndWait(text) {
  try {
    let toSpeak = text;
    if (toSpeak.length > 500) {
      toSpeak = toSpeak.substring(0, 500) + '... and more.';
    }
    const escaped = toSpeak.replace(/"/g, '\\"').replace(/`/g, '').replace(/\$/g, '');
    execSync(`say -v Samantha -r 185 "${escaped}"`, { timeout: 120000 });
  } catch (e) {
    console.error('speakAndWait error:', e.message);
  }
}

// ─── Notes Manifest Parser ───────────────────────────────────────────────────

function parseNoteIntoTasks(noteBody) {
  if (!noteBody) return [];
  return noteBody
    .split(/\n/)
    .map((line) => line.replace(/^[\s\-\*•\d.)\]]+/, '').trim())
    .filter((line) => line.length > 2 && !line.startsWith('#'));
}

function getVoiceEnv() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
    AWS_REGION: process.env.AWS_REGION || 'us-east-1',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/opt/anaconda3/bin:/usr/bin:/bin',
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile('src/renderer/index.html');
  mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('crashed', (event, killed) => {
    console.error('RENDERER CRASHED — killed:', killed);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error('RENDERER PROCESS GONE —', details.reason, details.exitCode);
  });
}

// ─── Overlay Window ──────────────────────────────────────────────────────────

function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = new BrowserWindow({
    width: 340,
    height: 240,
    x: Math.round((width - 340) / 2),
    y: Math.round((height - 240) / 2),
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  overlayWindow.loadFile('src/renderer/overlay.html');
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlay();
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow.setPosition(
    Math.round((width - 340) / 2),
    Math.round((height - 240) / 2)
  );
  overlayWindow.showInactive();
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

function sendOverlayUpdate(data) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay-update', data);
  }
}

// ─── Shared action executor (used by both IPC handler and overlay pipeline) ──

async function executeAction(action) {
  switch (action.type) {
    case 'terminal_command': return executeCommand(action.value);
    case 'chrome_profile': return openChromeWithProfile(action.value);
    case 'chrome_tab': return openChromeTab(action.value);
    case 'chrome_js': {
      const jsCode = action.value.replace(/'/g, "\\'").replace(/"/g, '\\"');
      return executeCommand("osascript -e 'tell application \"Google Chrome\" to execute active tab of front window javascript \"" + jsCode + "\"'");
    }
    case 'chrome_read': {
      await updateSessionContext();
      const linksResult = await executeCommand('osascript -e \'tell application "Google Chrome" to execute active tab of front window javascript "Array.from(document.querySelectorAll(\\\"a\\\")).slice(0,30).map((a,i) => (i+1) + \\\". \\\" + a.textContent.trim().substring(0,60) + \\\" -> \\\" + a.href).join(\\\"\\\\n\\\")"\'');
      const pageContent = `Page: ${session.activeTab.title}\nURL: ${session.activeTab.url}\n\nNumbered links on page:\n${linksResult.stdout || 'none'}\n\nIMPORTANT: To click a link, use chrome_js with: window.location.href = 'THE_EXACT_URL_FROM_ABOVE'\nDo NOT use querySelector with :contains() — it does not work.\n\nContent preview:\n${session.activeTab.content}`;
      return { success: true, stdout: pageContent, description: 'Current page content' };
    }
    case 'chrome_close_tab': return closeTab();
    case 'chrome_switch_tab': return switchToTab(action.value);
    case 'chrome_newtab': return newTab(action.value || '');
    case 'browser_action': {
      const payload = JSON.stringify({ instruction: action.value, start_url: 'https://www.google.com', profile_dir: null });
      try {
        const out = execSync(getPythonPath() + " '" + getPythonScriptPath('browser_agent.py') + "' '" + payload.replace(/'/g, "'\\''") + "'", { timeout: 120000, maxBuffer: 5*1024*1024, encoding: 'utf-8' });
        const line = out.split('\n').find(l => l.startsWith('NOVA_RESULT:'));
        if (line) {
          const r = JSON.parse(line.replace('NOVA_RESULT:', ''));
          if (r.success && r.screenshot) {
            r.description = await analyzeScreenshot(r.screenshot, 'Describe the result of: "' + action.value + '". Be concise.');
          }
          return r;
        }
        return { success: false, error: 'No result from browser agent' };
      } catch (e) { return { success: false, error: e.message }; }
    }
    case 'screenshot': {
      const p = action.value || '/tmp/nova_screenshot.png';
      await takeScreenshot(p);
      const question = action._question || 'Describe what you see on this screen. Mention any visible messages, notifications, chat names, or unread indicators. Be specific and conversational.';
      const desc = await analyzeScreenshot(p, question);
      return { success: true, description: desc, screenshot: p };
    }

    // ─── App Launcher ──────────────────────────────────────────
    case 'open_app': {
      return findAndOpenApp(action.value);
    }

    // ─── File Search ───────────────────────────────────────────
    case 'find_files': {
      const parts = (action.value || '').split('|').map(s => s.trim());
      const query = parts[0];
      const scope = parts[1] || null;
      return findFiles(query, scope);
    }

    // ─── Apple Notes ───────────────────────────────────────────
    case 'notes_create': {
      const sep = (action.value || '').indexOf('|');
      const title = sep >= 0 ? action.value.substring(0, sep).trim() : 'Note';
      const body = sep >= 0 ? action.value.substring(sep + 1).trim() : action.value;
      return createNote(title, body.replace(/\\n/g, '\n'));
    }
    case 'notes_read': {
      const result = await readNote(action.value || '');
      if (result.success) {
        return { success: true, stdout: `${result.title}:\n${result.body}`, description: result.body };
      }
      return result;
    }
    case 'notes_list': {
      const limit = parseInt(action.value, 10) || 10;
      return listNotes(limit);
    }
    case 'notes_append': {
      const sep = (action.value || '').indexOf('|');
      const title = sep >= 0 ? action.value.substring(0, sep).trim() : '';
      const text = sep >= 0 ? action.value.substring(sep + 1).trim() : action.value;
      return appendToNote(title, text.replace(/\\n/g, '\n'));
    }
    case 'notes_execute': {
      const noteTitle = (action.value || '').trim();
      let noteResult;
      if (noteTitle) {
        noteResult = await readNote(noteTitle);
      } else {
        const notesList = await listNotes(1);
        const firstTitle = (notesList.stdout || '').replace(/^\d+\.\s*/, '').split('\n')[0].trim();
        noteResult = firstTitle ? await readNote(firstTitle) : { success: false, error: 'No notes found.' };
      }
      if (!noteResult.success) {
        return { success: false, error: noteResult.error || 'Could not read note.' };
      }

      const tasks = parseNoteIntoTasks(noteResult.body);
      if (tasks.length === 0) {
        return { success: true, stdout: 'Note was empty or had no actionable items.' };
      }

      const taskResults = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        sendOverlayUpdate({
          state: 'thinking',
          status: `Step ${i + 1}/${tasks.length}: ${task.length > 40 ? task.slice(0, 40) + '…' : task}`,
          transcript: '',
          step: i + 1,
          totalSteps: tasks.length,
        });
        quickAck(`Working on step ${i + 1}: ${task.length > 30 ? task.slice(0, 30) : task}`);
        try {
          const plan = await classifyIntent(task, session);
          const results = await executeActions(plan, task);
          taskResults.push({ task, plan, results, success: true });
          addRecentAction(`manifest[${i + 1}]: ${task}`);
        } catch (e) {
          taskResults.push({ task, success: false, error: e.message });
        }
      }

      const succeeded = taskResults.filter(r => r.success).length;
      return {
        success: true,
        stdout: `Executed ${succeeded}/${tasks.length} tasks from note "${noteResult.title}".`,
        description: `Completed ${succeeded} of ${tasks.length} tasks from your notes.`,
        manifestResults: taskResults,
      };
    }

    // ─── Cursor IDE ────────────────────────────────────────────
    case 'cursor_open': {
      return openInCursor(action.value);
    }
    case 'cursor_project': {
      const parts = (action.value || '').split('|').map(s => s.trim());
      const name = parts[0] || 'new-project';
      const parentDir = parts[1] || '~/Desktop';
      const taskDesc = parts[2] || '';
      return createProjectAndOpen(name, parentDir, taskDesc);
    }

    // ─── Screen Agent (Computer Use) ─────────────────────────
    case 'screen_agent': {
      const task = action.value || '';
      const maxSteps = action.max_steps || 10;
      quickAck('Working on it');
      hideOverlay();
      await new Promise(r => setTimeout(r, 500));
      const appMatch = task.match(/^(?:In |Open )?([\w\s]+?)[,.:]/i);
      if (appMatch) {
        const appName = appMatch[1].trim();
        await executeCommand(`osascript -e 'tell application "${appName}" to activate'`);
        await new Promise(r => setTimeout(r, 1000));
      }
      const agentResult = await runScreenAgent(task, maxSteps);
      return {
        success: agentResult.success,
        description: agentResult.summary || 'Screen agent finished.',
        stdout: agentResult.summary || '',
        screenshot: agentResult.screenshot || null,
        steps: agentResult.steps,
        history: agentResult.history,
      };
    }

    // ─── Finder ────────────────────────────────────────────────
    case 'finder_reveal': {
      const filePath = action.value || session.lastResult || '/tmp';
      return revealInFinder(filePath);
    }

    // ─── Notifications ─────────────────────────────────────────
    case 'check_notifications': {
      const minutes = parseInt(action.value, 10) || 60;
      const notifResult = await runNotificationAgent(minutes);
      if (notifResult.error) {
        return { success: false, error: notifResult.error, description: 'Sorry, I could not read your notifications. ' + notifResult.error };
      }
      const notifs = notifResult.notifications || [];
      if (notifs.length === 0) {
        return { success: true, description: 'You have no recent notifications.', stdout: 'No recent notifications.' };
      }
      const appCounts = {};
      notifs.forEach(n => { appCounts[n.app] = (appCounts[n.app] || 0) + 1; });
      const summary = Object.entries(appCounts).map(([app, count]) => `${count} from ${app}`).join(', ');
      const details = notifs.slice(0, 10).map(n => {
        const parts = [n.app];
        if (n.time) parts.push(`at ${n.time}`);
        if (n.title) parts.push(n.title);
        if (n.body) parts.push(n.body);
        return parts.join(': ');
      }).join('\n');
      return {
        success: true,
        description: `You have ${notifs.length} recent notifications: ${summary}. Here are the latest: ${details}`,
        stdout: details,
      };
    }

    // ─── Memory Recall ─────────────────────────────────────────
    case 'recall_memory': {
      const query = action.value || session.lastCommand || 'recent actions';
      const recalled = await recallMemories(query, 5).catch(() => []);
      if (recalled.length === 0) {
        return { success: true, description: "I don't have any relevant memories yet. As you use me more, I'll remember past interactions.", stdout: "No memories found." };
      }
      const memText = recalled.map((m, i) => `${i + 1}. ${m.timeAgo}: ${m.summary}`).join('\n');
      return { success: true, description: `Here's what I remember:\n${memText}`, stdout: memText };
    }

    // ─── Describe Screen ──────────────────────────────────────
    case 'describe_screen': {
      quickAck('Let me look at your screen');
      const detectResult = await runDescribeScreen();
      if (!detectResult.screenshot_path) {
        return { success: false, error: 'Could not capture screen', description: 'Sorry, I could not capture your screen.' };
      }
      const description = await describeScreen(detectResult.screenshot_path, detectResult.elements_text);
      return { success: true, description, screenshot: detectResult.screenshot_path };
    }

    // ─── Read Document ────────────────────────────────────────
    case 'read_document': {
      quickAck('Reading the document on your screen');
      const pages = [];
      for (let i = 0; i < 3; i++) {
        const pagePath = `/tmp/nova_doc_page_${i}.png`;
        await takeScreenshot(pagePath);
        pages.push(pagePath);
        if (i < 2) {
          await executeCommand('osascript -e \'tell application "System Events" to key code 121\'');
          await new Promise(r => setTimeout(r, 1200));
        }
      }
      const userQ = action.value ? `The user asks: "${action.value}". ` : '';
      const summary = await summarizeDocument(pages, userQ + 'Extract and summarize the text content visible across these document pages. Focus on key information, headings, and important data. Present it as a concise spoken summary.');
      return { success: true, description: summary, screenshot: pages[0] };
    }

    default: return { success: true };
  }
}

async function executeActions(plan, userInput) {
  const results = [];
  const actions = plan.actions || [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    // After opening a native app, wait for it to come to foreground before screenshot or screen agent
    if (i > 0 && actions[i - 1].type === 'open_app' && action.type === 'screenshot') {
      await new Promise(r => setTimeout(r, 2000));
      action._question = `The user asked: "${userInput}". The app "${actions[i - 1].value}" was just opened. Describe what you see — focus on any messages, DMs, notifications, unread chats, or relevant content. Read out names and message previews if visible. Be specific and conversational, as if telling a friend what's on the screen.`;
    }
    if (i > 0 && actions[i - 1].type === 'open_app' && action.type === 'screen_agent') {
      await new Promise(r => setTimeout(r, 2000));
      const appToFocus = actions[i - 1].value;
      await executeCommand(`osascript -e 'tell application "${appToFocus}" to activate'`);
      await new Promise(r => setTimeout(r, 1000));
    }

    const result = await executeAction(action);
    results.push(result);
    addRecentAction(`${action.type}: ${action.value || ''}`);

    if (action.type === 'chrome_read' && result.success) {
      const remaining = actions.slice(i + 1);
      if (remaining.some(a => a.value && a.value.includes('determined after'))) {
        console.log('📖 chrome_read: re-classifying with page context...');
        const newIntent = await classifyIntent(
          userInput + '\n\nCurrent page content:\n' + result.stdout,
          session
        );
        actions.length = i + 1;
        actions.push(...(newIntent.actions || []));
        plan.speak = newIntent.speak;
      }
    }
  }
  return results;
}

// ─── Global Shortcut Voice Pipeline ──────────────────────────────────────────

async function runOverlayVoicePipeline(listenMode = 'listen') {
  if (overlayBusy) {
    overlayBusy = false;
    hideOverlay();
    return;
  }

  overlayBusy = true;
  showOverlay();

  // Wait briefly for the overlay webContents to be ready
  await new Promise(r => setTimeout(r, 300));

  sendOverlayUpdate({ state: 'listening', status: 'Listening...', transcript: '' });
  console.log('🎙️  Overlay: listening...');

  try {
    const voiceResult = await listenForVoice(listenMode);

    if (!overlayBusy) return;

    if (voiceResult.error || !voiceResult.transcription?.trim()) {
      sendOverlayUpdate({ state: 'error', status: voiceResult.error || 'No speech detected', transcript: '' });
      await new Promise(r => setTimeout(r, 2000));
      hideOverlay();
      overlayBusy = false;
      return;
    }

    const text = voiceResult.transcription.trim();
    console.log('📝  Overlay heard:', text);

    // Instant acknowledgment — user hears "On it" immediately while brain thinks
    sendOverlayUpdate({ state: 'thinking', status: 'Got it — thinking...', transcript: text });
    quickAck('On it');

    await updateSessionContext();
    session.lastCommand = text;

    const recalled = await recallMemories(text).catch(() => []);
    const memoryContext = formatMemoriesForContext(recalled);
    if (memoryContext) {
      session.memoryContext = memoryContext;
    }

    sendOverlayUpdate({ state: 'thinking', status: 'Planning...', transcript: text });
    const plan = await classifyIntent(text, session);

    if (!overlayBusy) return;

    // Announce what we're about to do
    if (plan.speak) {
      sendOverlayUpdate({ state: 'thinking', status: plan.speak, transcript: '' });
    }

    const results = await executeActions(plan, text);

    if (!overlayBusy) return;

    // Phase 3: Observe — use screenshot analysis if available, otherwise generate observation
    sendOverlayUpdate({ state: 'thinking', status: 'Observing...', transcript: '' });

    const screenshotResult = results.find(r => r.screenshot && r.description);
    let observation;

    if (screenshotResult) {
      // A screenshot was taken and analyzed — use that as the observation directly
      observation = screenshotResult.description;
    } else {
      const chromeActionTypes = new Set(['chrome_tab', 'chrome_newtab', 'chrome_profile', 'chrome_read', 'chrome_js', 'chrome_close_tab', 'chrome_switch_tab', 'browser_action']);
      const involvesChromeActions = (plan.actions || []).some(a => chromeActionTypes.has(a.type));

      if (involvesChromeActions) {
        await updateSessionContext();
      }

      const runningApps = await getRunningApps();
      const actionsLog = (plan.actions || []).map(a => `${a.type}: ${a.value || ''}`).join('\n');

      let contextSummary;
      if (involvesChromeActions) {
        contextSummary = `Active tab: ${session.activeTab.title} — ${session.activeTab.url}\nOpen tabs: ${session.openTabs.map(t => t.title).join(', ')}\nRunning apps: ${runningApps.slice(0, 15).join(', ')}\nPage content: ${session.activeTab.content.substring(0, 1000)}`;
      } else {
        contextSummary = `Running apps: ${runningApps.slice(0, 15).join(', ')}\nNote: No Chrome actions were performed — do NOT describe Chrome state.`;
      }

      observation = await generateObservation(text, contextSummary, actionsLog);
    }

    session.lastResult = observation;
    console.log('👁️  Observation:', observation);

    const primaryAction = (plan.actions || [])[0]?.type || 'unknown';
    storeMemory(observation, primaryAction, true).catch((e) => console.error('Memory store error:', e.message));

    const displayObs = observation.length > 120 ? observation.slice(0, 120) + '…' : observation;
    sendOverlayUpdate({ state: 'done', status: displayObs, transcript: '' });

    // Speak the observation and WAIT for it to finish (no arbitrary timeout)
    speakAndWait(observation);

    // Brief pause so the user can read the overlay after speech ends
    await new Promise(r => setTimeout(r, 1500));
  } catch (err) {
    console.error('Overlay pipeline error:', err);
    sendOverlayUpdate({ state: 'error', status: 'Error: ' + (err.message || 'unknown'), transcript: '' });
    await new Promise(r => setTimeout(r, 2000));
  } finally {
    hideOverlay();
    overlayBusy = false;
  }
}

function listenForVoice(mode = 'listen') {
  const { spawn } = require('child_process');
  const args = mode === 'listen_smart'
    ? ['src/python/voice_engine.py', 'listen_smart', '15', '3']
    : ['src/python/voice_engine.py', 'listen'];
  return new Promise((resolve) => {
    const proc = spawn(getPythonPath(), args.map(a => a === 'src/python/voice_engine.py' ? getPythonScriptPath('voice_engine.py') : a), {
      env: getVoiceEnv(),
      timeout: 90000,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      console.log('🎤 Voice engine:', chunk.trim());
    });
    proc.on('close', (code) => {
      console.log(`🎤 Voice engine exited code=${code}, stdout=${stdout.length}b, stderr=${stderr.length}b`);
      if (stderr) console.log('🎤 Voice stderr:', stderr.trim());
      const line = stdout.split('\n').find(l => l.startsWith('VOICE_RESULT:'));
      if (line) {
        try {
          const result = JSON.parse(line.replace('VOICE_RESULT:', ''));
          console.log('🎤 Voice result:', JSON.stringify(result));
          resolve(result);
        } catch (e) {
          resolve({ transcription: '', error: 'Parse error' });
        }
      } else {
        resolve({ transcription: '', error: `No result (exit code ${code})` });
      }
    });
    proc.on('error', (e) => {
      resolve({ transcription: '', error: e.message });
    });
  });
}

// ─── Wake Word Daemon ────────────────────────────────────────────────────────

function startWakeWordDaemon() {
  const accessKey = process.env.PICOVOICE_ACCESS_KEY || '';
  if (!accessKey) {
    console.log('⚠️  No PICOVOICE_ACCESS_KEY set — wake word detection disabled. Set the env var and restart.');
    return;
  }

  const { spawn } = require('child_process');
  const keyword = process.env.WAKE_WORD || 'jarvis';

  wakeWordProcess = spawn(getPythonPath(), [
    getPythonScriptPath('wake_word.py'),
    '--access-key', accessKey,
    '--keyword', keyword,
  ], {
    env: { ...process.env },
  });

  let stderrBuf = '';
  wakeWordProcess.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    console.log('🗣️  Wake word stderr:', d.toString().trim());
  });

  wakeWordProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      if (line === 'WAKE_WORD_DETECTED') {
        console.log('🗣️  Wake word detected! Triggering voice pipeline...');
        handleWakeWordDetection();
      } else if (line.startsWith('WAKE_WORD_READY:')) {
        console.log('🗣️  ' + line.replace('WAKE_WORD_READY:', ''));
      } else if (line.startsWith('WAKE_WORD_ERROR:')) {
        console.error('🗣️  Wake word error:', line.replace('WAKE_WORD_ERROR:', ''));
      }
    }
  });

  wakeWordProcess.on('close', (code) => {
    console.log(`🗣️  Wake word daemon exited with code ${code}`);
    wakeWordProcess = null;
  });

  wakeWordProcess.on('error', (err) => {
    console.error('🗣️  Wake word daemon spawn error:', err.message);
    wakeWordProcess = null;
  });
}

async function handleWakeWordDetection() {
  if (overlayBusy) return;

  quickAck("Hey, what do you need?");

  await runOverlayVoicePipeline('listen_smart');

  resumeWakeWord();
}

function resumeWakeWord() {
  if (wakeWordProcess && !wakeWordProcess.killed) {
    wakeWordProcess.stdin.write('RESUME\n');
  }
}

function stopWakeWordDaemon() {
  if (wakeWordProcess && !wakeWordProcess.killed) {
    wakeWordProcess.kill();
    wakeWordProcess = null;
  }
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Reset stale Accessibility TCC entry on first launch so reinstalls get a clean grant
  if (!isSetupComplete()) {
    try {
      const { execSync } = require('child_process');
      execSync('tccutil reset Accessibility com.novaassist.app', { timeout: 5000 });
      console.log('TCC: reset Accessibility permission for clean install');
    } catch (e) {
      console.log('TCC: reset skipped —', e.message);
    }
  }

  applyConfigToEnv();
  loadMemories();

  // Request microphone permission from main process on every launch
  systemPreferences.askForMediaAccess('microphone').then(granted => {
    console.log('Microphone permission:', granted ? 'granted' : 'denied');
  }).catch(() => {});

  if (!isSetupComplete()) {
    createWindow();
    mainWindow.loadFile('src/renderer/setup.html');
  } else {
    createWindow();
    createOverlay();

    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      runOverlayVoicePipeline();
    });

    console.log('⌨️  Global shortcut registered: Cmd+Shift+Space');

    startWakeWordDaemon();

    validateBedrockAccess().then(result => {
      if (!result.ok) {
        console.error('⚠️  Bedrock validation failed:', result.error);
        const { dialog } = require('electron');
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Bedrock Access Issue',
          message: 'Amazon Bedrock is not accessible with your current credentials.',
          detail: result.error + '\n\nThe app will still run but AI features (screen description, intent classification) will not work until this is resolved.',
          buttons: ['Open Bedrock Console', 'OK'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            shell.openExternal('https://console.aws.amazon.com/bedrock/home?region=us-east-1#/modelaccess');
          }
        });
      } else {
        console.log('✅  Bedrock access validated');
      }
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopWakeWordDaemon();
});

app.on('window-all-closed', () => app.quit());

async function openChromeTab(url) {
  const script = 'tell application "Google Chrome"\nactivate\nif (count of windows) = 0 then\nmake new window\nset URL of active tab of front window to "' + url + '"\nelse\nmake new tab at end of tabs of front window with properties {URL:"' + url + '"}\nend if\nend tell';
  const escaped = script.replace(/'/g, "'\\''" );
  return executeCommand("osascript -e '" + escaped + "'");
}

ipcMain.handle('execute-command', async (event, userInput) => {
  try {
    await updateSessionContext();
    session.lastCommand = userInput;

    const plan = await classifyIntent(userInput, session);
    const results = await executeActions(plan, userInput);

    // Check if any action already produced a description (describe_screen, read_document, recall_memory, check_notifications)
    const selfDescribedResult = results.find(r => r.description);
    let observation;

    if (selfDescribedResult) {
      observation = selfDescribedResult.description;
      speakAndWait(observation);
    } else {
      const chromeTypes = new Set(['chrome_tab', 'chrome_newtab', 'chrome_profile', 'chrome_read', 'chrome_js', 'chrome_close_tab', 'chrome_switch_tab', 'browser_action']);
      const touchesChrome = (plan.actions || []).some(a => chromeTypes.has(a.type));
      if (touchesChrome) {
        await updateSessionContext();
      }
      const runningApps = await getRunningApps();
      const actionsLog = (plan.actions || []).map(a => `${a.type}: ${a.value || ''}`).join('\n');
      let contextSummary;
      if (touchesChrome) {
        contextSummary = `Active tab: ${session.activeTab.title} — ${session.activeTab.url}\nOpen tabs: ${session.openTabs.map(t => t.title).join(', ')}\nRunning apps: ${runningApps.slice(0, 15).join(', ')}\nPage content: ${session.activeTab.content.substring(0, 1000)}`;
      } else {
        contextSummary = `Running apps: ${runningApps.slice(0, 15).join(', ')}\nNote: No Chrome actions were performed — do NOT describe Chrome state.`;
      }
      observation = await generateObservation(userInput, contextSummary, actionsLog);
    }
    session.lastResult = observation;

    const primaryAction = (plan.actions || [])[0]?.type || 'unknown';
    storeMemory(observation, primaryAction, true).catch((e) => console.error('Memory store error:', e.message));

    return { plan, results, observation, session: { openTabs: session.openTabs, activeTab: { title: session.activeTab.title, url: session.activeTab.url } } };
  } catch (err) {
    return { error: err.message, plan: { speak: 'Error: ' + err.message, actions: [], reasoning: '' }, results: [] };
  }
});

ipcMain.handle('voice-listen', async () => {
  try {
    const out = execSync(getPythonPath() + " '" + getPythonScriptPath('voice_engine.py') + "' listen", { timeout: 90000, maxBuffer: 5*1024*1024, encoding: 'utf-8', env: getVoiceEnv() });
    const line = out.split('\n').find(l => l.startsWith('VOICE_RESULT:'));
    if (line) return JSON.parse(line.replace('VOICE_RESULT:', ''));
    return { transcription: '', error: 'No result' };
  } catch (e) { return { transcription: '', error: e.message }; }
});

ipcMain.handle('voice-speak', async (event, text) => {
  try {
    speakAndWait(text);
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('take-screenshot', async () => {
  await takeScreenshot('/tmp/nova_screenshot.png');
  return '/tmp/nova_screenshot.png';
});

// ─── Setup Wizard IPC Handlers ───────────────────────────────────────────────

ipcMain.handle('check-accessibility', () => {
  try {
    return systemPreferences.isTrustedAccessibilityClient(true);
  } catch (e) {
    return false;
  }
});

ipcMain.handle('check-all-permissions', async () => {
  try {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    const screen = systemPreferences.getMediaAccessStatus('screen');
    return { microphone: mic, screen: screen };
  } catch (e) {
    return { microphone: 'not-determined', screen: 'not-determined' };
  }
});

ipcMain.handle('request-screen-recording', async () => {
  try {
    // On macOS 15+/26, programmatic permission prompts for screen recording are unreliable.
    // The most reliable path: open System Settings directly to the Screen Recording pane
    // so the user can toggle the permission themselves.
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('verify-aws', async (event, credentials) => {
  try {
    const { BedrockRuntimeClient: BRC, InvokeModelCommand: IMC } = require('@aws-sdk/client-bedrock-runtime');
    const testClient = new BRC({
      region: credentials.region || 'us-east-1',
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });
    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
      inferenceConfig: { maxTokens: 10 },
    });
    await testClient.send(new IMC({
      modelId: 'us.amazon.nova-2-lite-v1:0',
      body,
      contentType: 'application/json',
      accept: 'application/json',
    }));
    return { success: true };
  } catch (e) {
    let error = e.message;
    if (e.message?.includes('Invalid API Key') || e.name === 'AccessDeniedException') {
      error = 'Bedrock model access not enabled. Go to AWS Console → Amazon Bedrock → Model access → Enable Amazon Nova models, then retry.';
    }
    return { success: false, error };
  }
});

ipcMain.handle('verify-picovoice', async (event, accessKey) => {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const pythonPath = getPythonPath();
    const proc = spawn(pythonPath, ['-c', `
import pvporcupine
handle = pvporcupine.create(access_key="${accessKey.replace(/"/g, '\\"')}", keywords=["jarvis"])
handle.delete()
print("OK")
`], { env: { ...process.env }, timeout: 15000 });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && out.includes('OK')) {
        resolve({ success: true });
      } else {
        let error = out.trim().split('\n').pop() || 'Verification failed';
        if (error.includes('pvporcupine')) error = 'pvporcupine not installed. Install dependencies first.';
        else if (error.includes('invalid access key') || error.includes('AccessKey')) error = 'Invalid access key. Check your key at console.picovoice.ai';
        resolve({ success: false, error });
      }
    });
    proc.on('error', () => {
      resolve({ success: false, error: 'Python not found. Install dependencies first.' });
    });
  });
});

ipcMain.handle('install-deps', async () => {
  const { spawn, execSync } = require('child_process');
  function getRequirementsPath() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'requirements.txt');
    }
    return path.join(__dirname, 'requirements.txt');
  }
  function findBestPip() {
    const candidates = [
      '/opt/homebrew/bin/pip3',
      '/usr/local/bin/pip3',
      '/opt/homebrew/bin/python3 -m pip',
      '/usr/local/bin/python3 -m pip',
    ];
    for (const c of candidates) {
      try {
        const parts = c.split(' ');
        const ver = execSync(`${parts[0]} ${parts.length > 1 ? parts.slice(1).join(' ') + ' ' : ''}--version 2>/dev/null`, { timeout: 5000 }).toString();
        const match = ver.match(/python\s+(\d+)\.(\d+)/i);
        if (match && (parseInt(match[1]) > 3 || (parseInt(match[1]) === 3 && parseInt(match[2]) >= 10))) {
          console.log(`install-deps: using ${c} (Python ${match[1]}.${match[2]})`);
          return c.split(' ');
        }
      } catch {}
    }
    return ['pip3'];
  }
  const pipCmd = findBestPip();
  function runPipInstall(args) {
    return new Promise((resolve) => {
      const reqPath = getRequirementsPath();
      const cmd = pipCmd[0];
      const cmdArgs = [...pipCmd.slice(1), 'install', '-r', reqPath, ...args];
      const proc = spawn(cmd, cmdArgs, {
        env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:' + (process.env.PATH || '') },
        timeout: 300000,
      });
      let output = '';
      proc.stdout.on('data', (d) => {
        output += d.toString();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('deps-output', d.toString());
        }
      });
      proc.stderr.on('data', (d) => {
        output += d.toString();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('deps-output', d.toString());
        }
      });
      proc.on('close', (code) => {
        resolve({ success: code === 0, output, exitCode: code });
      });
    });
  }
  return new Promise(async (resolve) => {
    let result = await runPipInstall(['--user', '--break-system-packages']);
    if (!result.success && result.output.includes('no such option: --break-system-packages')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('deps-output', 'Retrying without --break-system-packages...\n');
      }
      result = await runPipInstall(['--user']);
    }
    resolve(result);
  });
});

ipcMain.handle('save-config', (event, config) => {
  saveConfig(config);
  applyConfigToEnv();
  return { success: true };
});

ipcMain.handle('save-setup-step', (event, step) => {
  const config = loadConfig();
  config.lastSetupStep = step;
  saveConfig(config);
  return { success: true };
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.quit();
});

ipcMain.handle('complete-setup', () => {
  const config = loadConfig();
  config.setupComplete = true;
  config.firstLaunch = new Date().toISOString();
  saveConfig(config);
  applyConfigToEnv();

  mainWindow.loadFile('src/renderer/index.html');
  createOverlay();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    runOverlayVoicePipeline();
  });
  console.log('⌨️  Global shortcut registered: Cmd+Shift+Space');
  startWakeWordDaemon();

  return { success: true };
});

ipcMain.handle('get-config', () => {
  return loadConfig();
});
