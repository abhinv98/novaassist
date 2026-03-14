const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { classifyIntent, analyzeScreenshot } = require('./src/main/brain');
const { executeCommand, takeScreenshot, openChromeWithProfile, findChromeProfile } = require('./src/main/desktop-hands');
const { execSync } = require('child_process');

let mainWindow;

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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

async function openChromeTab(url) {
  const script = 'tell application "Google Chrome"\nactivate\nif (count of windows) = 0 then\nmake new window\nset URL of active tab of front window to "' + url + '"\nelse\nmake new tab at end of tabs of front window with properties {URL:"' + url + '"}\nend if\nend tell';
  const escaped = script.replace(/'/g, "'\\''" );
  return executeCommand("osascript -e '" + escaped + "'");
}

ipcMain.handle('execute-command', async (event, userInput) => {
  try {
    const plan = await classifyIntent(userInput);
    const results = [];
    for (const action of plan.actions) {
      switch (action.type) {
        case 'terminal_command': results.push(await executeCommand(action.value)); break;
        case 'chrome_profile': results.push(await openChromeWithProfile(action.value)); break;
        case 'chrome_tab': results.push(await openChromeTab(action.value)); break;
        case 'browser_action': {
          const payload = JSON.stringify({ instruction: action.value, start_url: 'https://www.google.com', profile_dir: null });
          try {
            const out = execSync("python3 src/python/browser_agent.py '" + payload.replace(/'/g, "'\\''") + "'", { timeout: 120000, maxBuffer: 5*1024*1024, encoding: 'utf-8' });
            const line = out.split('\n').find(l => l.startsWith('NOVA_RESULT:'));
            if (line) {
              const r = JSON.parse(line.replace('NOVA_RESULT:', ''));
              if (r.success && r.screenshot) {
                const desc = await analyzeScreenshot(r.screenshot, 'Describe the result of: "' + action.value + '". Be concise.');
                r.description = desc;
              }
              results.push(r);
            }
          } catch (e) { results.push({ success: false, error: e.message }); }
          break;
        }
        case 'screenshot': {
          const p = action.value || '/tmp/nova_screenshot.png';
          await takeScreenshot(p);
          const desc = await analyzeScreenshot(p);
          results.push({ success: true, description: desc, screenshot: p });
          break;
        }
      }
    }
    return { plan, results };
  } catch (err) {
    return { error: err.message, plan: { speak: 'Error: ' + err.message, actions: [], reasoning: '' }, results: [] };
  }
});

ipcMain.handle('voice-listen', async () => {
  try {
    const out = execSync('python3 src/python/voice_engine.py listen', { timeout: 30000, maxBuffer: 5*1024*1024, encoding: 'utf-8', env: { ...process.env } });
    const line = out.split('\n').find(l => l.startsWith('VOICE_RESULT:'));
    if (line) return JSON.parse(line.replace('VOICE_RESULT:', ''));
    return { transcription: '', error: 'No result' };
  } catch (e) { return { transcription: '', error: e.message }; }
});

ipcMain.handle('voice-speak', async (event, text) => {
  try {
    const escaped = text.replace(/"/g, '\\"');
    execSync('python3 src/python/voice_engine.py speak "' + escaped + '"', { timeout: 30000, env: { ...process.env } });
    return { success: true };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('take-screenshot', async () => {
  await takeScreenshot('/tmp/nova_screenshot.png');
  return '/tmp/nova_screenshot.png';
});
