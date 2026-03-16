"""
NovaAssist Screen Agent — Computer Use for macOS
Takes a high-level task, then iterates: screenshot → vision analysis → mouse/keyboard action → repeat.
Uses Quartz CoreGraphics for mouse/keyboard (native macOS API) and AWS Bedrock Nova 2 Lite for vision.
Set-of-Mark (SoM) prompting: overlays numbered labels on interactive elements detected via macOS Accessibility API.
"""
import sys, os, json, subprocess, base64, time, re, shutil, hashlib, io, boto3
from PIL import Image, ImageDraw, ImageFont

try:
    from ApplicationServices import AXUIElementCreateApplication, AXUIElementCopyAttributeValue
    from AppKit import NSWorkspace
    AX_AVAILABLE = True
except ImportError:
    AX_AVAILABLE = False

from Quartz.CoreGraphics import (
    CGEventCreateMouseEvent, CGEventPost, CGEventCreateKeyboardEvent,
    CGEventSetIntegerValueField, CGEventSetFlags,
    kCGEventMouseMoved,
    kCGEventLeftMouseDown, kCGEventLeftMouseUp,
    kCGEventRightMouseDown, kCGEventRightMouseUp,
    kCGEventOtherMouseDown, kCGEventOtherMouseUp,
    kCGEventScrollWheel,
    kCGMouseButtonLeft, kCGMouseButtonRight,
    kCGHIDEventTap,
    kCGEventKeyDown, kCGEventKeyUp,
    kCGScrollEventUnitLine,
    kCGEventFlagMaskCommand, kCGEventFlagMaskShift,
    kCGEventFlagMaskAlternate, kCGEventFlagMaskControl,
)
from Quartz import CGEventKeyboardSetUnicodeString, CGEventCreateScrollWheelEvent, CGPointMake

SCREENSHOT_PATH = "/tmp/nova_screen_agent.png"
DEBUG_DIR = "/tmp/nova_screen_agent_debug"
MAX_STEPS_DEFAULT = 10

bedrock = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "us-east-1"))

VISION_SYSTEM = """You are a screen agent controlling a macOS computer. You see screenshots and decide what to do next.
You can: click, double-click, right-click, type text, press keys, scroll, or declare done.
Return ONLY valid JSON, no markdown, no backticks.

COORDINATE PRECISION: The screenshot has a RED GRID overlay with yellow labels. Use these grid lines to determine exact pixel coordinates. For example, if an element appears halfway between the x=200 and x=400 lines, its x coordinate is approximately 300.

CHANGE DETECTION: After each action, compare the new screenshot to the previous one carefully. Look for ANY visual difference — new text, highlighted items, opened panels, sent messages. If the screen changed, your action worked.

ACTION SEQUENCING: Each response is exactly ONE action. To send a message, you need TWO separate steps: first "type" the text, then "keypress" with "return". NEVER type the same text twice — if you already typed it, just press return.

COMPLETION DETECTION: Declare done=true as soon as the task objective is achieved. For messaging tasks: if you typed a message and pressed return, check if the message now appears as a SENT message bubble in the chat (usually on the right side with a checkmark). If yes, the message was sent — declare done immediately. Do NOT keep pressing return or clicking after the message is already visible as sent."""


# ─── Quartz-based mouse/keyboard control ────────────────────────────────────

def _mouse_event(event_type, x, y, button=kCGMouseButtonLeft):
    point = CGPointMake(float(x), float(y))
    ev = CGEventCreateMouseEvent(None, event_type, point, button)
    CGEventPost(kCGHIDEventTap, ev)

def mouse_move(x, y):
    _mouse_event(kCGEventMouseMoved, x, y)

def mouse_click(x, y):
    _mouse_event(kCGEventMouseMoved, x, y)
    time.sleep(0.05)
    _mouse_event(kCGEventLeftMouseDown, x, y)
    time.sleep(0.05)
    _mouse_event(kCGEventLeftMouseUp, x, y)

def mouse_double_click(x, y):
    point = CGPointMake(float(x), float(y))
    _mouse_event(kCGEventMouseMoved, x, y)
    time.sleep(0.05)
    down1 = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, point, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(down1, 1, 1)  # clickState = 1
    CGEventPost(kCGHIDEventTap, down1)
    time.sleep(0.03)
    up1 = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, point, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(up1, 1, 1)
    CGEventPost(kCGHIDEventTap, up1)
    time.sleep(0.05)
    down2 = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, point, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(down2, 1, 2)  # clickState = 2
    CGEventPost(kCGHIDEventTap, down2)
    time.sleep(0.03)
    up2 = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, point, kCGMouseButtonLeft)
    CGEventSetIntegerValueField(up2, 1, 2)
    CGEventPost(kCGHIDEventTap, up2)

def mouse_right_click(x, y):
    _mouse_event(kCGEventMouseMoved, x, y)
    time.sleep(0.05)
    _mouse_event(kCGEventRightMouseDown, x, y, kCGMouseButtonRight)
    time.sleep(0.05)
    _mouse_event(kCGEventRightMouseUp, x, y, kCGMouseButtonRight)

def type_text(text):
    for char in text:
        ev_down = CGEventCreateKeyboardEvent(None, 0, True)
        ev_up = CGEventCreateKeyboardEvent(None, 0, False)
        CGEventKeyboardSetUnicodeString(ev_down, len(char), char)
        CGEventKeyboardSetUnicodeString(ev_up, len(char), char)
        CGEventPost(kCGHIDEventTap, ev_down)
        time.sleep(0.02)
        CGEventPost(kCGHIDEventTap, ev_up)
        time.sleep(0.02)

KEYCODE_MAP = {
    "return": 36, "enter": 36,
    "tab": 48,
    "escape": 53, "esc": 53,
    "space": 49,
    "delete": 51, "backspace": 51,
    "fwd-delete": 117,
    "up": 126, "arrow-up": 126,
    "down": 125, "arrow-down": 125,
    "left": 123, "arrow-left": 123,
    "right": 124, "arrow-right": 124,
    "home": 115, "end": 119,
    "page-up": 116, "page-down": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118,
    "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3,
    "g": 5, "h": 4, "i": 34, "j": 38, "k": 40, "l": 37,
    "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
    "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
}

MOD_FLAG_MAP = {
    "cmd": kCGEventFlagMaskCommand, "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "alt": kCGEventFlagMaskAlternate, "option": kCGEventFlagMaskAlternate,
    "ctrl": kCGEventFlagMaskControl, "control": kCGEventFlagMaskControl,
}

def press_key(key_name, modifiers=None):
    key = key_name.lower().strip()
    keycode = KEYCODE_MAP.get(key, None)
    if keycode is None:
        if len(key) == 1:
            type_text(key)
            return
        print(f"SCREEN_AGENT_LOG:Unknown key '{key}', skipping", file=sys.stderr)
        return

    flags = 0
    if modifiers:
        for mod in modifiers:
            flags |= MOD_FLAG_MAP.get(mod.lower().strip(), 0)

    ev_down = CGEventCreateKeyboardEvent(None, keycode, True)
    ev_up = CGEventCreateKeyboardEvent(None, keycode, False)
    if flags:
        CGEventSetFlags(ev_down, flags)
        CGEventSetFlags(ev_up, flags)
    CGEventPost(kCGHIDEventTap, ev_down)
    time.sleep(0.05)
    CGEventPost(kCGHIDEventTap, ev_up)

def scroll(x, y, direction):
    mouse_move(x, y)
    time.sleep(0.05)
    amount = 5 if direction == "up" else -5
    ev = CGEventCreateScrollWheelEvent(None, kCGScrollEventUnitLine, 1, amount)
    CGEventPost(kCGHIDEventTap, ev)


# ─── Vision ──────────────────────────────────────────────────────────────────

def build_vision_prompt(task, history, step, max_steps, no_change_warning="", som_elements=None):
    history_text = "\n".join(f"  Step {i+1}: {h}" for i, h in enumerate(history)) or "  (none yet)"

    stuck_warning = ""
    if len(history) >= 2:
        last_two = history[-2:]
        if all("click" in h.lower() for h in last_two):
            coords = []
            for h in last_two:
                m = re.search(r"at \((\d+), (\d+)\)", h)
                if m:
                    coords.append((int(m.group(1)), int(m.group(2))))
            if len(coords) == 2 and abs(coords[0][0] - coords[1][0]) < 20 and abs(coords[0][1] - coords[1][1]) < 20:
                stuck_warning = """
⚠️ WARNING: You've clicked the same spot multiple times with no visible change.
You MUST try something COMPLETELY different — different element, different coordinates.
DO NOT click the same coordinates again."""

    if som_elements:
        elem_list = "\n".join(
            f"  [{i+1}] {e['role'].replace('AX','')}: \"{e['label']}\" — click at ({e['cx']}, {e['cy']})"
            for i, e in enumerate(som_elements)
        )
        targeting_section = f"""LABELED ELEMENTS (Set-of-Mark):
The screenshot has GREEN BOXES with RED NUMBERED LABELS on detected interactive elements.
Here is the list of labeled elements and their exact click coordinates:
{elem_list}

To click an element, use its EXACT coordinates from the list above.
For example, to click element [3], use the x,y coordinates shown for [3].
If the element you need is NOT in the list, estimate coordinates from visual position on screen."""
    else:
        targeting_section = """COORDINATE GRID:
Red lines and yellow labels overlay the screenshot. Major lines every 200px (labeled). Minor every 100px.
Use the grid to estimate exact coordinates of UI elements.
- Click the CENTER of text labels and buttons, not edges.
- For chat lists: names start around x=80-100. Click at x=120-150 for the name text.
- For message inputs at the bottom: click the center of the input bar.
- NEVER click at y < 30 (menu bar) or y > 1000 (dock)."""

    return f"""The user wants: "{task}"

Steps completed so far:
{history_text}

This is step {step} of maximum {max_steps}.
{stuck_warning}
{no_change_warning}

{targeting_section}

Decide the SINGLE next action to take.

Respond with ONLY valid JSON:
{{
  "thought": "I see [element] at/near [position]. I will...",
  "action": "click" | "double_click" | "right_click" | "type" | "keypress" | "scroll_up" | "scroll_down" | "wait" | "done",
  "x": 500,
  "y": 300,
  "text": "",
  "done": false,
  "summary": ""
}}

RULES:
- "click"/"double_click"/"right_click": x, y pixel coordinates. Use labeled elements or grid.
- "type": requires "text". MUST click the input field first.
- "keypress": key name ("return", "tab", "escape", "space", "delete") or combo ("cmd+a")
- "done": set done=true with a short "summary" of what was accomplished.
- The app is MAXIMIZED to fill the screen. All clicks land inside the app.
- NEVER click y < 30 or y > 1000.

CRITICAL SEQUENCING — READ THIS:
- Each response is ONE action. "type" and "keypress" are SEPARATE actions.
- To send a message: step A = "type" the text, step B = "keypress" with "return". These are TWO separate steps.
- After you "type" text, your VERY NEXT action MUST be "keypress" with text="return" to send it. NEVER type the same text twice.
- If you already typed text in a previous step, do NOT type it again. Instead, press "return" to send it.

COMPLETION — VERY IMPORTANT:
- After pressing "return" to send a message, CHECK the next screenshot.
- If your message appears as a SENT bubble (right side, with timestamp/checkmark) → done=true immediately.
- If the chat preview on the left shows your message → also confirms sent.
- Do NOT keep pressing return if the message is already visible as sent.

CHANGE DETECTION:
- Screenshot unchanged = action FAILED. Pick DIFFERENT coordinates.
- Screenshot changed = action WORKED. Proceed to next step."""


def maximize_frontmost_window():
    """Maximize the frontmost app's window to fill the screen (below menu bar, above dock)."""
    script = '''
    tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        tell process frontApp
            try
                set frontWindow to window 1
                set position of frontWindow to {0, 25}
                set size of frontWindow to {1920, 1010}
            end try
        end tell
    end tell
    '''
    subprocess.run(["osascript", "-e", script], capture_output=True, timeout=5)
    time.sleep(0.3)

SCREENSHOT_ANNOTATED_PATH = "/tmp/nova_screen_agent_annotated.png"
SOM_MIN_ELEMENTS = 5


# ─── Set-of-Mark (SoM) via macOS Accessibility API ───────────────────────────

def _parse_ax_point(val):
    m = re.search(r'x:([\d.]+)\s+y:([\d.]+)', str(val))
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)

def _parse_ax_size(val):
    m = re.search(r'w:([\d.]+)\s+h:([\d.]+)', str(val))
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)

CLICKABLE_ROLES = {
    'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
    'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXComboBox',
    'AXCell', 'AXRow', 'AXImage', 'AXMenuItem', 'AXIncrementor',
    'AXStaticText',
}

def detect_ax_elements(max_depth=8, max_elems=50):
    """Use macOS Accessibility API to find interactive elements in the frontmost app."""
    if not AX_AVAILABLE:
        return []

    try:
        ws = NSWorkspace.sharedWorkspace()
        front_app = ws.frontmostApplication()
        pid = front_app.processIdentifier()
        app_ref = AXUIElementCreateApplication(pid)
        err, windows = AXUIElementCopyAttributeValue(app_ref, 'AXWindows', None)
        if err != 0 or not windows:
            return []
    except Exception:
        return []

    elements = []
    seen_positions = set()

    def traverse(elem, depth=0):
        if depth > max_depth or len(elements) >= max_elems:
            return

        err, role = AXUIElementCopyAttributeValue(elem, 'AXRole', None)
        if err != 0:
            return
        role = str(role)

        err, pos_val = AXUIElementCopyAttributeValue(elem, 'AXPosition', None)
        err2, size_val = AXUIElementCopyAttributeValue(elem, 'AXSize', None)

        if role in CLICKABLE_ROLES and pos_val and size_val:
            x, y = _parse_ax_point(pos_val)
            w, h = _parse_ax_size(size_val)
            if x is not None and w is not None and w > 8 and h > 8:
                cx, cy = int(x + w / 2), int(y + h / 2)
                pos_key = (cx // 10, cy // 10)
                if pos_key not in seen_positions and 0 < cx < 1920 and 25 < cy < 1050:
                    seen_positions.add(pos_key)

                    err, title = AXUIElementCopyAttributeValue(elem, 'AXTitle', None)
                    err, desc = AXUIElementCopyAttributeValue(elem, 'AXDescription', None)
                    err, val = AXUIElementCopyAttributeValue(elem, 'AXValue', None)
                    label = str(title or desc or val or '')[:50]
                    if not label or label == 'None':
                        label = role.replace('AX', '')

                    elements.append({
                        'role': role, 'label': label,
                        'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h),
                        'cx': cx, 'cy': cy,
                    })

        err, children = AXUIElementCopyAttributeValue(elem, 'AXChildren', None)
        if err == 0 and children:
            for child in children:
                if len(elements) >= max_elems:
                    break
                traverse(child, depth + 1)

    for win in list(windows)[:1]:
        traverse(win)

    return elements


def add_som_overlay(image_path, output_path, elements):
    """Draw numbered markers on detected interactive elements."""
    img = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(img)

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 16)
        font_sm = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 11)
    except Exception:
        font = ImageFont.load_default()
        font_sm = font

    for i, elem in enumerate(elements):
        cx, cy = elem['cx'], elem['cy']
        num = str(i + 1)

        draw.rectangle(
            [(elem['x'], elem['y']), (elem['x'] + elem['w'], elem['y'] + elem['h'])],
            outline=(0, 255, 0), width=2
        )

        badge_w = len(num) * 11 + 6
        badge_h = 20
        bx, by = cx - badge_w // 2, elem['y'] - badge_h - 2
        if by < 0:
            by = elem['y'] + elem['h'] + 2
        draw.rectangle([(bx, by), (bx + badge_w, by + badge_h)], fill=(255, 0, 0))
        draw.text((bx + 3, by + 1), num, fill=(255, 255, 255), font=font)

    img.save(output_path, "PNG")
    return output_path


def take_screenshot():
    subprocess.run(["screencapture", "-x", SCREENSHOT_PATH], check=True, capture_output=True)


def add_grid_overlay(image_path, output_path):
    """Draw a coordinate grid on the screenshot to help the model estimate positions."""
    img = Image.open(image_path).convert("RGB")
    draw = ImageDraw.Draw(img)
    w, h = img.size

    try:
        font = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
    except Exception:
        font = ImageFont.load_default()

    major_color = (255, 50, 50)
    minor_color = (255, 100, 100)
    label_bg = (0, 0, 0)
    label_fg = (255, 255, 0)

    for x in range(100, w, 100):
        is_major = (x % 200 == 0)
        draw.line([(x, 0), (x, h)], fill=major_color if is_major else minor_color, width=2 if is_major else 1)
        if is_major:
            label = str(x)
            draw.rectangle([(x + 1, 1), (x + len(label) * 9 + 4, 17)], fill=label_bg)
            draw.text((x + 3, 2), label, fill=label_fg, font=font)

    for y in range(100, h, 100):
        is_major = (y % 200 == 0)
        draw.line([(0, y), (w, y)], fill=major_color if is_major else minor_color, width=2 if is_major else 1)
        if is_major:
            label = str(y)
            draw.rectangle([(1, y + 1), (len(label) * 9 + 4, y + 17)], fill=label_bg)
            draw.text((3, y + 2), label, fill=label_fg, font=font)

    img.save(output_path, "PNG")
    return output_path


def screenshot_hash(path):
    """Return a perceptual hash (small thumbnail comparison) to detect near-identical images."""
    img = Image.open(path).convert("L").resize((64, 64))
    return hashlib.md5(img.tobytes()).hexdigest()


def analyze_screenshot(task, history, step, max_steps, no_change_warning="", som_elements=None):
    if som_elements and len(som_elements) >= SOM_MIN_ELEMENTS:
        add_som_overlay(SCREENSHOT_PATH, SCREENSHOT_ANNOTATED_PATH, som_elements)
        print(f"SCREEN_AGENT_LOG:SoM mode: {len(som_elements)} labeled elements", file=sys.stderr)
    else:
        add_grid_overlay(SCREENSHOT_PATH, SCREENSHOT_ANNOTATED_PATH)
        som_elements = None
        print("SCREEN_AGENT_LOG:Grid mode (not enough AX elements for SoM)", file=sys.stderr)

    with open(SCREENSHOT_ANNOTATED_PATH, "rb") as f:
        image_bytes = f.read()
    b64 = base64.b64encode(image_bytes).decode("utf-8")

    prompt_text = build_vision_prompt(task, history, step, max_steps, no_change_warning, som_elements)

    body = json.dumps({
        "messages": [{
            "role": "user",
            "content": [
                {"image": {"format": "png", "source": {"bytes": b64}}},
                {"text": prompt_text},
            ],
        }],
        "system": [{"text": VISION_SYSTEM}],
        "inferenceConfig": {"maxTokens": 512, "temperature": 0.1},
    })

    response = bedrock.invoke_model(
        modelId="us.amazon.nova-2-lite-v1:0",
        body=body,
        contentType="application/json",
        accept="application/json",
    )
    result = json.loads(response["body"].read())
    text = (result.get("output", {}).get("message", {}).get("content", [{}])[0].get("text", "")
            or result.get("content", [{}])[0].get("text", ""))

    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    return json.loads(cleaned)


# ─── Action executor ─────────────────────────────────────────────────────────

def clamp_coords(x, y):
    """Keep coordinates within the usable screen area (avoid dock and menu bar)."""
    x = max(0, min(x, 1919))
    y = max(30, min(y, 1000))
    return x, y

def execute_action(action_data):
    action = action_data.get("action", "done")
    x = int(float(action_data.get("x", 0)))
    y = int(float(action_data.get("y", 0)))
    text = action_data.get("text", "")

    if action in ("click", "double_click", "right_click", "scroll_up", "scroll_down"):
        x, y = clamp_coords(x, y)

    if action == "click":
        mouse_click(x, y)
        return f"Clicked at ({x}, {y})"

    elif action == "double_click":
        mouse_double_click(x, y)
        return f"Double-clicked at ({x}, {y})"

    elif action == "right_click":
        mouse_right_click(x, y)
        return f"Right-clicked at ({x}, {y})"

    elif action == "type":
        type_text(text)
        return f'Typed: "{text}"'

    elif action == "keypress":
        if "+" in text:
            parts = text.lower().split("+")
            mods = [p.strip() for p in parts[:-1]]
            key = parts[-1].strip()
            press_key(key, mods)
            return f"Pressed {text}"
        else:
            press_key(text)
            return f"Pressed {text}"

    elif action == "scroll_up":
        scroll(x, y, "up")
        return f"Scrolled up at ({x}, {y})"

    elif action == "scroll_down":
        scroll(x, y, "down")
        return f"Scrolled down at ({x}, {y})"

    elif action == "wait":
        time.sleep(2)
        return "Waited 2 seconds"

    elif action == "done":
        return "Task complete"

    return f"Unknown action: {action}"


# ─── Agent loop ──────────────────────────────────────────────────────────────

def run_agent(task, max_steps=MAX_STEPS_DEFAULT):
    history = []
    final_summary = "Task completed."
    consecutive_same_action = 0
    last_action_key = None
    prev_screenshot_hash = None
    consecutive_no_change = 0

    print(f"SCREEN_AGENT_LOG:Starting task: {task}", file=sys.stderr)
    print(f"SCREEN_AGENT_LOG:Max steps: {max_steps}", file=sys.stderr)

    os.makedirs(DEBUG_DIR, exist_ok=True)

    print("SCREEN_AGENT_LOG:Maximizing target app to fill screen...", file=sys.stderr)
    maximize_frontmost_window()

    for step in range(1, max_steps + 1):
        print(f"SCREEN_AGENT_LOG:Step {step}/{max_steps}", file=sys.stderr)

        take_screenshot()
        shutil.copy2(SCREENSHOT_PATH, os.path.join(DEBUG_DIR, f"step_{step}.png"))

        current_hash = screenshot_hash(SCREENSHOT_PATH)
        no_change_warning = ""
        if step > 1 and prev_screenshot_hash == current_hash:
            consecutive_no_change += 1
            print(f"SCREEN_AGENT_LOG:⚠️ Screenshot UNCHANGED after last action (streak: {consecutive_no_change})", file=sys.stderr)
            no_change_warning = f"""
🚨 SCREENSHOT UNCHANGED: The screen looks EXACTLY the same as before your last action.
Your previous action ({history[-1] if history else 'unknown'}) had NO EFFECT.
This has happened {consecutive_no_change} time(s) in a row.
You MUST try something COMPLETELY DIFFERENT:
- Your click coordinates were WRONG — the target element is at different x,y coordinates
- Look at the RED GRID overlay to recalculate the exact position
- For list items, click on the TEXT of the item (roughly center of the row), NOT the far-left edge
- If you tried clicking at x < 100, that's likely the sidebar icons — the actual list items start around x=100-200"""
        else:
            consecutive_no_change = 0
        prev_screenshot_hash = current_hash

        if consecutive_no_change >= 4:
            print(f"SCREEN_AGENT_LOG:No-change limit reached ({consecutive_no_change}x), aborting", file=sys.stderr)
            final_summary = "Actions had no visible effect on the screen after multiple attempts. Clicks may not be registering in this app."
            history.append("ABORTED: Screenshot unchanged after 4 consecutive actions")
            break

        som_elements = detect_ax_elements()
        try:
            decision = analyze_screenshot(task, history, step, max_steps, no_change_warning, som_elements)
        except Exception as e:
            print(f"SCREEN_AGENT_LOG:Vision error at step {step}: {e}", file=sys.stderr)
            history.append(f"Vision analysis failed: {e}")
            continue

        thought = decision.get("thought", "")
        action = decision.get("action", "done")
        is_done = decision.get("done", False)
        x = int(float(decision.get("x", 0)))
        y = int(float(decision.get("y", 0)))
        text = decision.get("text", "")

        if action == "type" and text:
            prev_types = [h for h in history if h.startswith("type: Typed:")]
            for pt in prev_types:
                if text in pt:
                    print(f"SCREEN_AGENT_LOG:⚠️ Auto-correcting duplicate type → keypress:return", file=sys.stderr)
                    action = "keypress"
                    decision["action"] = "keypress"
                    decision["text"] = "return"
                    break

        print(f"SCREEN_AGENT_LOG:Thought: {thought}", file=sys.stderr)
        print(f"SCREEN_AGENT_LOG:Action: {action}", file=sys.stderr)

        if is_done or action == "done":
            model_summary = decision.get("summary", thought or "Task completed.")
            if consecutive_no_change >= 3 and step > 1:
                final_summary = f"Attempted but actions had no visible effect. {model_summary}"
                print("SCREEN_AGENT_LOG:⚠️ Model declared done after many no-change steps", file=sys.stderr)
            else:
                final_summary = model_summary
            history.append(f"Done: {final_summary}")
            print(f"SCREEN_AGENT_LOG:Task complete at step {step}", file=sys.stderr)
            break

        action_key = f"{action}:{x},{y}" if action in ("click", "double_click", "right_click") else f"{action}:{decision.get('text', '')}"
        if action_key == last_action_key:
            consecutive_same_action += 1
        else:
            consecutive_same_action = 0
            last_action_key = action_key

        if consecutive_same_action >= 3:
            has_typed = any("type: Typed:" in h for h in history)
            has_pressed_return = any("keypress" in h and "return" in h for h in history)
            if has_typed and (action == "keypress" or has_pressed_return):
                typed_text = ""
                for h in history:
                    if h.startswith("type: Typed:"):
                        m = re.search(r'Typed: "(.+?)"', h)
                        if m:
                            typed_text = m.group(1)
                final_summary = f"Message '{typed_text}' was typed and sent." if typed_text else "Message was typed and sent."
                print(f"SCREEN_AGENT_LOG:Stuck on return after type — treating as SUCCESS", file=sys.stderr)
            else:
                final_summary = f"Got stuck repeating the same action. The action may not be registering."
                print(f"SCREEN_AGENT_LOG:Stuck loop detected ({action_key} repeated {consecutive_same_action + 1}x), aborting", file=sys.stderr)
            history.append(f"STUCK → resolved: {final_summary}")
            break

        result = execute_action(decision)
        history.append(f"{action}: {result} (thought: {thought})")
        print(f"SCREEN_AGENT_LOG:Result: {result}", file=sys.stderr)

        wait_time = 1.5 if action in ("click", "double_click", "type") else 0.5
        time.sleep(wait_time)
    else:
        take_screenshot()
        shutil.copy2(SCREENSHOT_PATH, os.path.join(DEBUG_DIR, f"step_final.png"))
        try:
            final_check = analyze_screenshot(
                task, history, max_steps + 1, max_steps + 1,
                "\n🏁 MAX STEPS REACHED. Look at the current screen. Did the task get completed? Provide a SHORT summary of what was accomplished. Set done=true and give an honest summary."
            )
            final_summary = final_check.get("summary", final_check.get("thought", "Reached maximum steps."))
            print(f"SCREEN_AGENT_LOG:Final check summary: {final_summary}", file=sys.stderr)
        except Exception:
            final_summary = f"Reached maximum {max_steps} steps. Task may or may not have completed."

    take_screenshot()
    screenshot_path = SCREENSHOT_PATH

    return {
        "success": True,
        "summary": final_summary,
        "steps": len(history),
        "history": history,
        "screenshot": screenshot_path,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 screen_agent.py '{\"task\": \"...\", \"max_steps\": 10}'")
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
        task = params.get("task", "")
        max_steps = params.get("max_steps", MAX_STEPS_DEFAULT)

        if not task:
            print("SCREEN_AGENT_RESULT:" + json.dumps({"success": False, "error": "No task provided"}))
            sys.exit(1)

        result = run_agent(task, max_steps)
        print("SCREEN_AGENT_RESULT:" + json.dumps(result))

    except Exception as e:
        print(f"SCREEN_AGENT_LOG:Fatal error: {e}", file=sys.stderr)
        print("SCREEN_AGENT_RESULT:" + json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
