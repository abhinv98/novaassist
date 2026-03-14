const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('path');
const { classifyIntent, analyzeScreenshot, generateObservation } = require('./src/main/brain');
const {
  executeCommand, takeScreenshot, openChromeWithProfile, findChromeProfile,
  getChromeTabs, getActiveTabInfo, closeTab, switchToTab, newTab,
} = require('./src/main/desktop-hands');
const { execSync } = require('child_process');

let mainWindow;
let overlayWindow = null;
let overlayBusy = false;

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

const voiceEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_REGION: 'us-east-1',
  PATH: '/opt/anaconda3/bin:/usr/local/bin:/usr/bin:/bin',
};

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
      const linksResult = await executeCommand('osascript -e \'tell application "Google Chrome" to execute active tab of front window javascript "Array.from(document.querySelectorAll(\\\"a\\\")).slice(0,20).map(a => a.href + \\\" | \\\" + a.textContent.trim().substring(0,50)).join(\\\"\\\\n\\\")"\'');
      const pageContent = `Page: ${session.activeTab.title}\nURL: ${session.activeTab.url}\n\nLinks:\n${linksResult.stdout || 'none'}\n\nContent preview:\n${session.activeTab.content}`;
      return { success: true, stdout: pageContent, description: 'Current page content' };
    }
    case 'chrome_close_tab': return closeTab();
    case 'chrome_switch_tab': return switchToTab(action.value);
    case 'chrome_newtab': return newTab(action.value || '');
    case 'browser_action': {
      const payload = JSON.stringify({ instruction: action.value, start_url: 'https://www.google.com', profile_dir: null });
      try {
        const out = execSync("/opt/anaconda3/bin/python3 src/python/browser_agent.py '" + payload.replace(/'/g, "'\\''") + "'", { timeout: 120000, maxBuffer: 5*1024*1024, encoding: 'utf-8' });
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
      const desc = await analyzeScreenshot(p);
      return { success: true, description: desc, screenshot: p };
    }
    default: return { success: true };
  }
}

async function executeActions(plan, userInput) {
  const results = [];
  const actions = plan.actions || [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
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

async function runOverlayVoicePipeline() {
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
    const voiceResult = await listenForVoice();

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
    sendOverlayUpdate({ state: 'thinking', status: 'Thinking...', transcript: text });

    await updateSessionContext();
    session.lastCommand = text;

    const plan = await classifyIntent(text, session);

    if (!overlayBusy) return;

    const results = await executeActions(plan, text);

    if (!overlayBusy) return;

    // Phase 3: Observe — gather context and generate natural observation
    sendOverlayUpdate({ state: 'thinking', status: 'Observing...', transcript: text });
    await updateSessionContext();

    const contextSummary = `Active tab: ${session.activeTab.title} — ${session.activeTab.url}\nOpen tabs: ${session.openTabs.map(t => t.title).join(', ')}\nPage content: ${session.activeTab.content.substring(0, 1000)}`;
    const observation = await generateObservation(text, contextSummary);

    session.lastResult = observation;
    console.log('👁️  Observation:', observation);

    const displayObs = observation.length > 120 ? observation.slice(0, 120) + '…' : observation;
    sendOverlayUpdate({ state: 'done', status: displayObs, transcript: '' });

    try {
      const escaped = observation.replace(/"/g, '\\"');
      execSync('/opt/anaconda3/bin/python3 src/python/voice_engine.py speak "' + escaped + '"', { timeout: 30000, env: voiceEnv });
    } catch (e) {
      console.error('Voice speak error:', e.message);
    }

    await new Promise(r => setTimeout(r, 4000));
  } catch (err) {
    console.error('Overlay pipeline error:', err);
    sendOverlayUpdate({ state: 'error', status: 'Error: ' + (err.message || 'unknown'), transcript: '' });
    await new Promise(r => setTimeout(r, 2000));
  } finally {
    hideOverlay();
    overlayBusy = false;
  }
}

function listenForVoice() {
  try {
    const out = execSync('/opt/anaconda3/bin/python3 src/python/voice_engine.py listen', { timeout: 90000, maxBuffer: 5*1024*1024, encoding: 'utf-8', env: voiceEnv });
    const line = out.split('\n').find(l => l.startsWith('VOICE_RESULT:'));
    if (line) return JSON.parse(line.replace('VOICE_RESULT:', ''));
    return { transcription: '', error: 'No result' };
  } catch (e) { return { transcription: '', error: e.message }; }
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  createOverlay();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    runOverlayVoicePipeline();
  });

  console.log('⌨️  Global shortcut registered: Cmd+Shift+Space');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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

    // Phase 3: Observe
    await updateSessionContext();
    const contextSummary = `Active tab: ${session.activeTab.title} — ${session.activeTab.url}\nOpen tabs: ${session.openTabs.map(t => t.title).join(', ')}\nPage content: ${session.activeTab.content.substring(0, 1000)}`;
    const observation = await generateObservation(userInput, contextSummary);
    session.lastResult = observation;

    return { plan, results, observation, session: { openTabs: session.openTabs, activeTab: { title: session.activeTab.title, url: session.activeTab.url } } };
  } catch (err) {
    return { error: err.message, plan: { speak: 'Error: ' + err.message, actions: [], reasoning: '' }, results: [] };
  }
});

ipcMain.handle('voice-listen', async () => {
  try {
    const out = execSync('/opt/anaconda3/bin/python3 src/python/voice_engine.py listen', { timeout: 90000, maxBuffer: 5*1024*1024, encoding: 'utf-8', env: voiceEnv });
    const line = out.split('\n').find(l => l.startsWith('VOICE_RESULT:'));
    if (line) return JSON.parse(line.replace('VOICE_RESULT:', ''));
    return { transcription: '', error: 'No result' };
  } catch (e) { return { transcription: '', error: e.message }; }
});

ipcMain.handle('voice-speak', async (event, text) => {
  try {
    const escaped = text.replace(/"/g, '\\"');
    execSync('/opt/anaconda3/bin/python3 src/python/voice_engine.py speak "' + escaped + '"', { timeout: 30000, env: voiceEnv });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('take-screenshot', async () => {
  await takeScreenshot('/tmp/nova_screenshot.png');
  return '/tmp/nova_screenshot.png';
});
