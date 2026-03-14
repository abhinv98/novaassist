const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");
const fs = require("fs");

const client = new BedrockRuntimeClient({ region: "us-east-1" });

const SYSTEM_PROMPT = `You are NovaAssist, a contextually-aware AI assistant that controls a macOS computer.
You receive user commands along with the current computer state (open tabs, active page, recent history).
Use this context to give accurate, intelligent responses.

Respond ONLY in valid JSON format, no markdown, no backticks, no explanation outside the JSON:
{
  "task_type": "BROWSER_COMPLEX" | "DESKTOP" | "QUERY",
  "reasoning": "brief explanation of what you will do",
  "actions": [
    {
      "type": "terminal_command" | "chrome_tab" | "chrome_newtab" | "chrome_profile" | "chrome_read" | "chrome_js" | "chrome_close_tab" | "chrome_switch_tab" | "browser_action" | "screenshot" | "speak",
      "value": "the command or instruction",
      "profile": "(optional) chrome profile name for browser_action"
    }
  ],
  "speak": "what to say to the user about what you're doing"
}

ACTION TYPES:
- "terminal_command": Run a macOS terminal command (open, mkdir, ls, cp, mv, cat, etc.)
- "chrome_tab": Open a URL in a new tab in the user's currently-open Chrome. Value must be a URL.
- "chrome_newtab": Open a new tab, optionally with a URL. Value is a URL or empty string for blank tab.
- "chrome_profile": Open Chrome with a specific profile. Value is a fuzzy name like "ecultify" or "abhinav".
- "chrome_read": Read the current Chrome tab's content. Value should be "read". The system provides page content for re-classification.
- "chrome_js": Execute JavaScript in the active Chrome tab. Value is a JS snippet.
- "chrome_close_tab": Close the active Chrome tab. Value is "current".
- "chrome_switch_tab": Switch to a specific Chrome tab by name or index. Value is a tab name substring or 1-based index.
- "browser_action": Launch Nova Act browser agent for complex multi-step tasks on NEW sites. Include "profile" field.
- "screenshot": Take a screenshot. Value is the output path.
- "speak": Say something to the user.

CONTEXT AWARENESS:
- You receive session context showing open tabs, the active page, and recent history.
- When the user says "click that", "open that link", "go to that page", use the session context to determine what "that" refers to.
- When session context shows the active tab content, use it to interact with the correct elements.
- Reference open tabs naturally when the user asks about them.
- After a search, if the user asks to open a result, use chrome_js with the actual link from session context — NEVER guess URLs.

CRITICAL RULES:
- For simple web searches: use "chrome_tab" with "https://www.google.com/search?q=QUERY" (replace spaces with +)
- For simple navigation (go to github, open youtube): use "chrome_tab" with the URL
- When the user asks about the current page or to click something on it: use "chrome_read" first, then "chrome_js" with value "will be determined after reading page"
- For simple page interactions where you know exactly what to do (scroll, go back): use "chrome_js" directly
- For tab management (close, switch, new tab): use the appropriate chrome_close_tab, chrome_switch_tab, or chrome_newtab
- ONLY use "browser_action" for tasks needing a NEW site with complex multi-step work
- For opening apps: use terminal_command with open -a "App Name"
- For Chrome profiles: use "chrome_profile" with a fuzzy name
- NEVER use sudo, rm -rf /, or any destructive system commands
- NEVER guess URLs for content on the current page. Use chrome_read or session context.

EXAMPLES:

User: "Open Safari"
{"task_type":"DESKTOP","reasoning":"Open Safari app","actions":[{"type":"terminal_command","value":"open -a \\"Safari\\""}],"speak":"Opening Safari for you."}

User: "Open Chrome with ecultify profile"
{"task_type":"DESKTOP","reasoning":"Open Chrome with specific profile","actions":[{"type":"chrome_profile","value":"ecultify"}],"speak":"Opening Chrome with the Ecultify profile."}

User: "Search Google for Next.js tutorials"
{"task_type":"DESKTOP","reasoning":"Simple web search","actions":[{"type":"chrome_tab","value":"https://www.google.com/search?q=Next.js+tutorials"}],"speak":"Searching Google for Next.js tutorials."}

User: "Go to GitHub"
{"task_type":"DESKTOP","reasoning":"Simple navigation","actions":[{"type":"chrome_tab","value":"https://github.com"}],"speak":"Opening GitHub."}

User: "Open YouTube and search for Amazon Nova tutorial"
{"task_type":"DESKTOP","reasoning":"Navigate to YouTube search","actions":[{"type":"chrome_tab","value":"https://www.youtube.com/results?search_query=Amazon+Nova+tutorial"}],"speak":"Searching YouTube for Amazon Nova tutorials."}

User: "Create a folder called projects on my Desktop"
{"task_type":"DESKTOP","reasoning":"Create a new folder","actions":[{"type":"terminal_command","value":"mkdir -p ~/Desktop/projects"}],"speak":"Creating the projects folder on your Desktop."}

User: "What files are on my Desktop?"
{"task_type":"DESKTOP","reasoning":"List Desktop contents","actions":[{"type":"terminal_command","value":"ls -la ~/Desktop"}],"speak":"Let me check your Desktop."}

User: "What's on my screen right now?"
{"task_type":"DESKTOP","reasoning":"Take and analyze screenshot","actions":[{"type":"screenshot","value":"/tmp/nova_screenshot.png"}],"speak":"Let me take a look at your screen."}

User: "Open VS Code"
{"task_type":"DESKTOP","reasoning":"Open VS Code application","actions":[{"type":"terminal_command","value":"open -a \\"Visual Studio Code\\""}],"speak":"Opening VS Code."}

User: "Click the first link on the page"
{"task_type":"DESKTOP","reasoning":"Need to read page to find the actual link","actions":[{"type":"chrome_read","value":"read"},{"type":"chrome_js","value":"will be determined after reading page"}],"speak":"Let me check the page and click the first link."}

User: "Click the Devpost link on this page"
{"task_type":"DESKTOP","reasoning":"Need to read page to find the Devpost link","actions":[{"type":"chrome_read","value":"read"},{"type":"chrome_js","value":"will be determined after reading page"}],"speak":"Let me find the Devpost link on the page."}

User: "What's on this page?"
{"task_type":"DESKTOP","reasoning":"Read current tab content","actions":[{"type":"chrome_read","value":"read"}],"speak":"Let me read what's on the page."}

User: "Scroll down"
{"task_type":"DESKTOP","reasoning":"Simple page interaction","actions":[{"type":"chrome_js","value":"window.scrollBy(0, 500)"}],"speak":"Scrolling down."}

User: "Close this tab"
{"task_type":"DESKTOP","reasoning":"Close current Chrome tab","actions":[{"type":"chrome_close_tab","value":"current"}],"speak":"Closing this tab."}

User: "Open a new tab and go to YouTube"
{"task_type":"DESKTOP","reasoning":"Open new tab with URL","actions":[{"type":"chrome_newtab","value":"https://www.youtube.com"}],"speak":"Opening YouTube in a new tab."}

User: "Switch to the GitHub tab"
{"task_type":"DESKTOP","reasoning":"Switch to tab matching GitHub","actions":[{"type":"chrome_switch_tab","value":"github"}],"speak":"Switching to GitHub."}

User: "What tabs do I have open?"
{"task_type":"QUERY","reasoning":"List open tabs from session context","actions":[],"speak":"Will describe open tabs from session context."}

User: "Open Chrome with ecultify profile and then go to Amazon"
{"task_type":"DESKTOP","reasoning":"Open Chrome with profile then navigate","actions":[{"type":"chrome_profile","value":"ecultify"},{"type":"chrome_tab","value":"https://www.amazon.com"}],"speak":"Opening Chrome with Ecultify profile and heading to Amazon."}

User: "Log into my GitHub and show me my repositories"
{"task_type":"BROWSER_COMPLEX","reasoning":"Complex task needing authenticated session","actions":[{"type":"browser_action","value":"Go to github.com, navigate to my repositories page, and list the recent repositories","profile":"abhinav"}],"speak":"Let me check your GitHub repositories."}

User: "Fill out the contact form on example.com"
{"task_type":"BROWSER_COMPLEX","reasoning":"Complex multi-step form filling","actions":[{"type":"browser_action","value":"Navigate to example.com, find the contact form, and fill it out with placeholder data","profile":"ecultify"}],"speak":"I'll fill out that contact form for you."}`;

async function classifyIntent(userMessage, sessionContext = null) {
  let systemText = SYSTEM_PROMPT;
  if (sessionContext) {
    const tabList = (sessionContext.openTabs || [])
      .map((t, i) => `  ${i + 1}. ${t.title} — ${t.url}`)
      .join("\n") || "  (none)";
    systemText += `\n\nCURRENT COMPUTER STATE:\nActive tab: ${sessionContext.activeTab?.title || "unknown"} — ${sessionContext.activeTab?.url || "unknown"}\nActive tab content preview: ${(sessionContext.activeTab?.content || "").substring(0, 500)}\nOpen tabs:\n${tabList}\nLast command: ${sessionContext.lastCommand || "none"}\nLast result: ${sessionContext.lastResult || "none"}\nRecent actions: ${(sessionContext.recentActions || []).join(", ") || "none"}\n\nUse this context to give accurate responses. When the user references "that link", "this page", "the GitHub tab", etc., resolve it using the above state.`;
  }

  const body = JSON.stringify({
    messages: [
      { role: "user", content: [{ text: userMessage }] },
    ],
    system: [{ text: systemText }],
    inferenceConfig: {
      maxTokens: 512,
      temperature: 0.0,
    },
  });

  const command = new InvokeModelCommand({
    modelId: "us.amazon.nova-2-lite-v1:0",
    body,
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  const text = responseBody.output?.message?.content?.[0]?.text
    || responseBody.content?.[0]?.text
    || "";

  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to parse brain response:", cleaned);
    return {
      task_type: "QUERY",
      reasoning: "Failed to parse response",
      actions: [],
      speak: "Sorry, I had trouble understanding that command. Could you try again?",
    };
  }
}

async function analyzeScreenshot(screenshotPath, question = "Describe what you see on this screen.") {
  const imageBytes = fs.readFileSync(screenshotPath);
  const base64Image = imageBytes.toString("base64");

  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [
          {
            image: {
              format: "png",
              source: { bytes: base64Image },
            },
          },
          { text: question },
        ],
      },
    ],
    system: [{ text: "You are a helpful assistant that describes what is visible on a computer screen. Be concise but accurate. Describe the main application visible, any notable content, and the overall state of the desktop." }],
    inferenceConfig: {
      maxTokens: 512,
      temperature: 0.3,
    },
  });

  const command = new InvokeModelCommand({
    modelId: "us.amazon.nova-2-lite-v1:0",
    body,
    contentType: "application/json",
    accept: "application/json",
  });

  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));

  return responseBody.output?.message?.content?.[0]?.text
    || responseBody.content?.[0]?.text
    || "I couldn't analyze the screenshot.";
}

async function generateObservation(command, pageContext) {
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [
          {
            text: `You just executed this command for the user: "${command}"\n\nHere is the current state of their computer:\n${pageContext}\n\nIn 1-2 natural sentences, tell the user what happened and what they can see now. Be specific — mention actual page titles, link names, visible content. Be conversational, like a helpful friend describing what they see. Do NOT use markdown or bullet points. Just plain spoken English.`,
          },
        ],
      },
    ],
    system: [
      {
        text: "You are NovaAssist, a voice AI assistant. Generate a brief, natural spoken observation about what just happened on the user's computer. Be specific about what's visible. Keep it to 1-2 sentences max.",
      },
    ],
    inferenceConfig: {
      maxTokens: 200,
      temperature: 0.3,
    },
  });

  const command_ = new InvokeModelCommand({
    modelId: "us.amazon.nova-2-lite-v1:0",
    body,
    contentType: "application/json",
    accept: "application/json",
  });

  try {
    const response = await client.send(command_);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return (
      responseBody.output?.message?.content?.[0]?.text ||
      responseBody.content?.[0]?.text ||
      "Done."
    );
  } catch (e) {
    console.error("generateObservation error:", e.message);
    return "Done.";
  }
}

module.exports = { classifyIntent, analyzeScreenshot, generateObservation };