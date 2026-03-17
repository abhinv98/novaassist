# NovaAssist -- Voice-First AI Desktop Agent for macOS

A voice-controlled desktop agent that gives visually impaired users
hands-free control of their entire Mac. Say "Jarvis" and tell it
what you need -- it sees the screen, clicks, types, and speaks the
result back.

Built for the Amazon Nova AI Hackathon 2026.

## Quick Install

1. Download the latest `.dmg` from [Releases](https://github.com/abhinv98/novaassist/releases)
2. Open the `.dmg` and drag NovaAssist to Applications
3. Right-click the app, then click Open (required because the app is not code-signed)
4. Follow the setup wizard

### Prerequisites

- macOS 13 (Ventura) or later
- Python 3.9+ (`brew install python3` or download from python.org)
- PortAudio (`brew install portaudio` -- required for microphone access)
- An AWS account with Amazon Bedrock access enabled
  - Nova 2 Lite, Nova 2 Sonic, and Nova Act must be enabled in the Bedrock console
  - Region: us-east-1 recommended
- A free Picovoice account for the wake word -- get your key at [console.picovoice.ai](https://console.picovoice.ai)

### First Launch

The app will guide you through setup:

1. Grant Accessibility permission (System Settings, Privacy and Security)
2. Grant Microphone permission
3. Enter your AWS credentials
4. Enter your Picovoice Access Key
5. Dependencies auto-install

### Manual Setup (alternative)

```
git clone https://github.com/abhinv98/novaassist.git
cd novaassist
npm install
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` with your AWS and Picovoice keys, then run:

```
npm start
```

## Privacy and Data

NovaAssist runs locally on your Mac.

- All app data, settings, and memory are stored locally in `~/.novaassist/`
- No data is stored on any remote server
- Your AWS credentials are saved locally and used only to call Amazon Bedrock
- Voice audio is streamed to AWS Bedrock (Nova Sonic) for real-time transcription -- AWS does not retain this audio after processing
- Screenshots are sent to AWS Bedrock (Nova 2 Lite) for vision analysis -- AWS does not retain these images after processing
- Wake word detection ("Jarvis") runs entirely offline via Picovoice -- no audio leaves your Mac until the wake word is detected
- You can delete all local data at any time by removing the `~/.novaassist/` folder

## How It Works

Three Amazon Nova models work together:

Nova 2 Sonic handles voice input and output over a bidirectional WebSocket. It performs speech-to-text with smart silence detection and text-to-speech for spoken responses.

Nova 2 Lite is the brain and eyes. It classifies intent, plans actions, and powers the screen agent. For native apps with no API (WhatsApp, Slack), it takes screenshots, detects UI elements via the macOS Accessibility API, overlays numbered labels (Set-of-Mark prompting), and clicks at exact pixel coordinates via Quartz CoreGraphics. Extended thinking is enabled for complex screen analysis tasks.

Nova Act handles browser automation. It performs complex multi-step web tasks like form filling and multi-page navigation autonomously.

Nova Multimodal Embeddings powers persistent memory. After each completed action, a summary is embedded and stored locally. On new commands, relevant past interactions are recalled and injected into the context so the agent remembers what you did earlier.

## Demo Commands

Try these after setup:

- "Jarvis, describe my screen"
- "Jarvis, open WhatsApp and send a message to [contact] saying [message]"
- "Jarvis, open Chrome and search for Amazon Nova AI hackathon"
- "Jarvis, take notes: buy groceries, call dentist"
- "Jarvis, find my resume on the Desktop"
- "Jarvis, read this document"
- "Jarvis, what did I do earlier?"

## Tech Stack

- Amazon Nova 2 Sonic (voice) via Amazon Bedrock
- Amazon Nova 2 Lite (reasoning + vision) via Amazon Bedrock
- Amazon Nova Act (browser automation)
- Amazon Nova Multimodal Embeddings (memory)
- Electron + React (desktop app)
- Node.js (main process)
- Python 3 (screen agent, wake word, voice capture)
- Picovoice Porcupine (offline wake word)
- macOS Accessibility API (UI element detection)
- Quartz CoreGraphics (mouse/keyboard control)
- AppleScript (Chrome/app control)

## Troubleshooting

### "macOS cannot verify the developer"

Right-click the app, then click Open, then click Open in the dialog. This only needs to be done once.

### "Accessibility permission not working"

Go to System Settings, then Privacy and Security, then Accessibility. Remove NovaAssist, re-add it, and restart the app.

### "PyAudio installation fails"

Run `brew install portaudio` first, then retry the setup.

### "Bedrock access denied"

Make sure Nova 2 Lite, Nova 2 Sonic, and Nova Act are enabled in the Amazon Bedrock console under Model Access in the us-east-1 region.

### "Wake word not responding"

Check that your Picovoice Access Key is valid at console.picovoice.ai. Also ensure microphone permission is granted.

### Screen agent debug screenshots

When the screen agent runs, it saves a screenshot at each step to `/tmp/nova_screen_agent_debug/`. Open this folder to see exactly what the agent saw and did:

```
open /tmp/nova_screen_agent_debug/
```

## Getting Your API Keys

### AWS Credentials

1. Go to the [AWS Console](https://console.aws.amazon.com/)
2. Navigate to IAM, then Users, then Create User
3. Attach the `AmazonBedrockFullAccess` policy
4. Create an Access Key under Security Credentials
5. Copy the Access Key ID and Secret Access Key

### Picovoice Access Key

1. Go to [console.picovoice.ai](https://console.picovoice.ai/)
2. Sign up for a free account
3. Your Access Key is shown on the dashboard -- copy it

### Enable Amazon Nova Models

1. Go to the [Amazon Bedrock Console](https://console.aws.amazon.com/bedrock/)
2. Switch to the us-east-1 region
3. Click "Model access" in the left sidebar
4. Click "Enable specific models"
5. Select: Nova 2 Lite, Nova 2 Sonic
6. Click Submit -- access is granted immediately

## Built By

Abhinav Rai -- Full-stack developer, Mumbai, India

## License

MIT
