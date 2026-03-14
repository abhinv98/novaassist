const readline = require("readline");
const { execSync } = require("child_process");
const { classifyIntent, analyzeScreenshot } = require("./src/main/brain");
const {
  executeCommand,
  takeScreenshot,
  openChromeWithProfile,
  listChromeProfiles,
  findChromeProfile,
} = require("./src/main/desktop-hands");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let voiceMode = false;
let lastChromeProfile = null;

console.log("\n🤖 NovaAssist — Voice AI Desktop Agent");
console.log("═══════════════════════════════════════");
console.log("Commands:");
console.log('  Type naturally to control your Mac');
console.log('  "voice"    → toggle voice mode (speak instead of type)');
console.log('  "profiles" → list Chrome profiles');
console.log('  "quit"     → exit\n');

function voiceListen() {
  try {
    console.log("\n🎙️  Listening... (speak now, 6 seconds)");
    const output = execSync("python3 src/python/voice_engine.py listen", {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
      encoding: "utf-8",
    });
    const resultLine = output.split("\n").find((l) => l.startsWith("VOICE_RESULT:"));
    if (resultLine) {
      const result = JSON.parse(resultLine.replace("VOICE_RESULT:", ""));
      if (result.error) {
        console.log(`❌ Voice error: ${result.error}`);
        return null;
      }
      return result.transcription;
    }
    return null;
  } catch (err) {
    console.log(`❌ Voice listen failed: ${err.message}`);
    return null;
  }
}

function voiceSpeak(text) {
  try {
    const escaped = text.replace(/'/g, "'\\''");
    execSync(`say -v Samantha -r 180 '${escaped}'`, { timeout: 30000 });
  } catch {
    // Silent fail
  }
}

async function openChromeTab(url) {
  const script = `tell application "Google Chrome"
    activate
    if (count of windows) = 0 then
      make new window
      set URL of active tab of front window to "${url}"
    else
      make new tab at end of tabs of front window with properties {URL:"${url}"}
    end if
  end tell`;
  const escaped = script.replace(/"/g, '\\"');
  return executeCommand(`osascript -e "${escaped}"`);
}

async function executePlan(plan) {
  console.log(`\n🧠 Brain says: ${plan.reasoning}`);
  console.log(`💬 "${plan.speak}"`);
  console.log(`📋 Task type: ${plan.task_type}`);
  console.log(`📝 Actions: ${plan.actions.length}\n`);

  if (voiceMode && plan.speak) voiceSpeak(plan.speak);

  for (const action of plan.actions) {
    switch (action.type) {
      case "terminal_command": {
        const result = await executeCommand(action.value);
        if (result.success) {
          console.log(`✅ Command succeeded`);
          if (result.stdout) {
            console.log(`📄 Output:\n${result.stdout}\n`);
            if (voiceMode && result.stdout.length < 200) voiceSpeak(result.stdout);
          }
        } else {
          console.log(`❌ Command failed: ${result.error}`);
        }
        break;
      }

      case "chrome_profile": {
        const result = await openChromeWithProfile(action.value);
        if (result.success) {
          console.log(`✅ Chrome opened with matched profile`);
          const profile = findChromeProfile(action.value);
          if (profile) lastChromeProfile = profile.directory;
        } else {
          console.log(`❌ ${result.error}`);
        }
        break;
      }

      case "chrome_tab": {
        console.log(`🌐 Opening in Chrome: ${action.value}`);
        const result = await openChromeTab(action.value);
        if (result.success) {
          console.log(`✅ Opened in Chrome tab`);
        } else {
          console.log(`❌ Failed to open tab: ${result.error}`);
        }
        break;
      }

      case "browser_action": {
        console.log(`🤖 AI Browser Agent: "${action.value}"`);
        console.log(`⏳ Launching Nova Act (15-60 seconds)...`);
        if (voiceMode) voiceSpeak("Working on it. This will take a moment.");

        try {
          const taskPayload = JSON.stringify({
            instruction: action.value,
            start_url: "https://www.google.com",
            profile_dir: null,
          });
          const escaped = taskPayload.replace(/'/g, "'\\''");
          const output = execSync(
            `python3 src/python/browser_agent.py '${escaped}'`,
            { timeout: 120000, maxBuffer: 5 * 1024 * 1024, encoding: "utf-8" }
          );
          const resultLine = output.split("\n").find((l) => l.startsWith("NOVA_RESULT:"));
          if (resultLine) {
            const result = JSON.parse(resultLine.replace("NOVA_RESULT:", ""));
            if (result.success) {
              console.log(`✅ AI Browser Agent completed`);
              console.log(`👀 Analyzing what the agent found...`);
              const description = await analyzeScreenshot(
                result.screenshot,
                `Describe the result of this browser task: "${action.value}". Be concise — 2-3 sentences.`
              );
              console.log(`🖼️  ${description}\n`);
              if (voiceMode) voiceSpeak(description);
            } else {
              console.log(`❌ Agent failed: ${result.error}`);
            }
          }
        } catch (err) {
          console.log(`❌ Nova Act error: ${err.message}`);
        }
        break;
      }

      case "screenshot": {
        const screenshotPath = action.value || "/tmp/nova_screenshot.png";
        await takeScreenshot(screenshotPath);
        console.log(`📸 Screenshot saved`);
        console.log(`👀 Analyzing screenshot...`);
        try {
          const description = await analyzeScreenshot(screenshotPath);
          console.log(`🖼️  ${description}\n`);
          if (voiceMode) voiceSpeak(description);
        } catch (err) {
          console.log(`❌ Screenshot analysis failed: ${err.message}`);
        }
        break;
      }

      case "speak": {
        console.log(`🔊 "${action.value}"`);
        if (voiceMode) voiceSpeak(action.value);
        break;
      }

      default:
        console.log(`⚠️  Unknown action type: ${action.type}`);
    }
  }
}

async function handleInput(input) {
  const trimmed = input.trim();

  if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit") {
    console.log("\n👋 NovaAssist shutting down.");
    if (voiceMode) voiceSpeak("Goodbye!");
    rl.close();
    process.exit(0);
  }

  if (trimmed.toLowerCase() === "voice") {
    voiceMode = !voiceMode;
    console.log(`\n🔊 Voice mode: ${voiceMode ? "ON 🎙️" : "OFF ⌨️"}\n`);
    if (voiceMode) voiceSpeak("Voice mode activated. I'm listening.");
    return;
  }

  if (trimmed.toLowerCase() === "profiles") {
    console.log("\n📋 Chrome Profiles:\n" + listChromeProfiles() + "\n");
    return;
  }

  if (!trimmed) return;

  try {
    console.log("\n⏳ Thinking...");
    const plan = await classifyIntent(trimmed);
    await executePlan(plan);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
  }
  console.log("─".repeat(50));
}

function prompt() {
  if (voiceMode) {
    const transcription = voiceListen();
    if (transcription) {
      console.log(`🎙️  You said: "${transcription}"`);
      handleInput(transcription).then(() => prompt());
    } else {
      console.log("🔇 Didn't catch that. Try again.");
      prompt();
    }
  } else {
    rl.question("🎙️  You: ", async (input) => {
      await handleInput(input);
      prompt();
    });
  }
}

prompt();
