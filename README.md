# NovaAssist

A voice-controlled desktop agent for macOS, built for people who can't see their screens. Say what you need, and it does it -- opens apps, manages browser tabs, sends messages, takes notes, searches files. No mouse required.

Trigger it with "Jarvis" (wake word) or Cmd+Shift+Space.

## Tech stack

- Electron -- app shell, global shortcuts, floating overlay
- Amazon Nova 2 Sonic (AWS Bedrock) -- real-time bidirectional voice streaming
- Amazon Nova 2 Lite (AWS Bedrock) -- intent classification, screenshot analysis, screen agent vision
- Amazon Nova Act -- browser automation for multi-step web tasks
- Python + PyAudio -- microphone capture, audio playback
- Picovoice Porcupine -- always-on wake word detection
- Quartz CoreGraphics -- native macOS mouse and keyboard control
- macOS Accessibility API -- UI element detection for Set-of-Mark prompting
- Pillow -- screenshot annotation (grids, numbered element markers)
- AppleScript -- Chrome tabs, Apple Notes, app launching

## Setup

```
git clone https://github.com/abhinv98/novaassist.git
cd novaassist
npm install
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill in your keys:

```
cp .env.example .env
```

You need:
- AWS credentials with Bedrock access (Nova 2 Lite, Nova 2 Sonic, Nova Act enabled in us-east-1)
- Picovoice access key (optional, for wake word)

## Run

```
npm start
```

Two ways to interact:
- Type commands in the app window
- Press Cmd+Shift+Space from anywhere to use voice (or say "Jarvis" if wake word is configured)

macOS will prompt for Accessibility, Screen Recording, and Microphone permissions on first run.

## Screen agent debug screenshots

When the screen agent runs, it saves a screenshot at each step to:

```
/tmp/nova_screen_agent_debug/
```

Files are named `step_1.png`, `step_2.png`, etc. Open this folder in Finder to see exactly what the agent saw and did at each step:

```
open /tmp/nova_screen_agent_debug/
```

## Platform

macOS only for now. The screen agent and wake word daemon use macOS-specific APIs. Windows and Linux support is planned.
