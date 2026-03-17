"""
NovaAssist Describe Screen — Captures screenshot + AX elements for screen description.
Reuses Accessibility API detection from screen_agent.py.
Outputs DESCRIBE_RESULT:{json} to stdout.
"""
import sys, os, json, subprocess, re

SCREENSHOT_PATH = "/tmp/nova_describe_screen.png"

try:
    from ApplicationServices import AXUIElementCreateApplication, AXUIElementCopyAttributeValue
    from AppKit import NSWorkspace
    AX_AVAILABLE = True
except ImportError:
    AX_AVAILABLE = False

CLICKABLE_ROLES = {
    'AXButton', 'AXLink', 'AXTextField', 'AXTextArea',
    'AXCheckBox', 'AXRadioButton', 'AXPopUpButton', 'AXComboBox',
    'AXCell', 'AXRow', 'AXImage', 'AXMenuItem', 'AXIncrementor',
    'AXStaticText', 'AXToolbar', 'AXTabGroup', 'AXMenu', 'AXMenuBar',
    'AXGroup', 'AXScrollArea', 'AXTable', 'AXList',
}

SPATIAL_LABELS = {
    'AXMenuBar': 'Menu bar',
    'AXToolbar': 'Toolbar',
    'AXTabGroup': 'Tab bar',
    'AXGroup': 'Section',
    'AXScrollArea': 'Scrollable area',
    'AXTable': 'Table',
    'AXList': 'List',
}


def _parse_ax_point(val):
    m = re.search(r'x:([\d.]+)\s+y:([\d.]+)', str(val))
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def _parse_ax_size(val):
    m = re.search(r'w:([\d.]+)\s+h:([\d.]+)', str(val))
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def _spatial_region(cx, cy, screen_w=1920, screen_h=1080):
    """Convert pixel coords to spatial description."""
    if cy < screen_h * 0.1:
        v = "top"
    elif cy > screen_h * 0.85:
        v = "bottom"
    else:
        v = "center"

    if cx < screen_w * 0.25:
        h = "left"
    elif cx > screen_w * 0.75:
        h = "right"
    else:
        h = "center"

    if v == "center" and h == "center":
        return "center"
    if v == "center":
        return h
    if h == "center":
        return v
    return f"{v}-{h}"


def detect_ax_elements(max_depth=8, max_elems=30):
    if not AX_AVAILABLE:
        return []

    try:
        ws = NSWorkspace.sharedWorkspace()
        front_app = ws.frontmostApplication()
        pid = front_app.processIdentifier()
        app_name = front_app.localizedName()
        app_ref = AXUIElementCreateApplication(pid)
        err, windows = AXUIElementCopyAttributeValue(app_ref, 'AXWindows', None)
        if err != 0 or not windows:
            return []
    except Exception:
        return []

    elements = []
    seen_positions = set()

    def traverse(elem, depth=0, parent_label=""):
        if depth > max_depth or len(elements) >= max_elems:
            return

        err, role = AXUIElementCopyAttributeValue(elem, 'AXRole', None)
        if err != 0:
            return
        role = str(role)

        err, pos_val = AXUIElementCopyAttributeValue(elem, 'AXPosition', None)
        err2, size_val = AXUIElementCopyAttributeValue(elem, 'AXSize', None)

        current_label = parent_label
        if role in SPATIAL_LABELS:
            err, title = AXUIElementCopyAttributeValue(elem, 'AXTitle', None)
            current_label = str(title or '') or SPATIAL_LABELS.get(role, '')

        if role in CLICKABLE_ROLES and pos_val and size_val:
            x, y = _parse_ax_point(pos_val)
            w, h = _parse_ax_size(size_val)
            if x is not None and w is not None and w > 8 and h > 8:
                cx, cy = int(x + w / 2), int(y + h / 2)
                pos_key = (cx // 15, cy // 15)
                if pos_key not in seen_positions and 0 < cx < 1920 and 25 < cy < 1080:
                    seen_positions.add(pos_key)

                    err, title = AXUIElementCopyAttributeValue(elem, 'AXTitle', None)
                    err, desc = AXUIElementCopyAttributeValue(elem, 'AXDescription', None)
                    err, val = AXUIElementCopyAttributeValue(elem, 'AXValue', None)
                    label = str(title or desc or val or '')[:60]
                    if not label or label == 'None':
                        label = role.replace('AX', '')

                    friendly_role = role.replace('AX', '')
                    region = _spatial_region(cx, cy)

                    elements.append({
                        'role': friendly_role,
                        'label': label,
                        'region': region,
                        'cx': cx, 'cy': cy,
                        'parent': current_label,
                    })

        err, children = AXUIElementCopyAttributeValue(elem, 'AXChildren', None)
        if err == 0 and children:
            for child in children:
                if len(elements) >= max_elems:
                    break
                traverse(child, depth + 1, current_label)

    for win in list(windows)[:1]:
        traverse(win)

    return elements


def get_frontmost_app_name():
    try:
        ws = NSWorkspace.sharedWorkspace()
        front_app = ws.frontmostApplication()
        return front_app.localizedName()
    except Exception:
        return "Unknown"


def format_elements_text(elements, app_name):
    if not elements:
        return f"Active app: {app_name}\nNo interactive elements detected via Accessibility API."

    lines = [f"Active app: {app_name}", f"Detected {len(elements)} interactive elements:", ""]

    grouped = {}
    for elem in elements:
        parent = elem.get('parent', '') or 'Main area'
        if parent not in grouped:
            grouped[parent] = []
        grouped[parent].append(elem)

    idx = 1
    for parent, elems in grouped.items():
        if parent and parent != 'Main area':
            lines.append(f"{parent}:")
        for e in elems:
            lines.append(f"  [{idx}] {e['role']}: \"{e['label']}\" ({e['region']})")
            idx += 1
        lines.append("")

    return "\n".join(lines)


def take_screenshot():
    subprocess.run(["screencapture", "-x", SCREENSHOT_PATH], check=True, capture_output=True)


def main():
    try:
        take_screenshot()
        app_name = get_frontmost_app_name()
        elements = detect_ax_elements()
        elements_text = format_elements_text(elements, app_name)

        print("DESCRIBE_RESULT:" + json.dumps({
            "elements_text": elements_text,
            "screenshot_path": SCREENSHOT_PATH,
            "app_name": app_name,
            "element_count": len(elements),
        }))

    except Exception as e:
        print(f"DESCRIBE_LOG:Error: {e}", file=sys.stderr)
        print("DESCRIBE_RESULT:" + json.dumps({
            "elements_text": "Could not detect screen elements.",
            "screenshot_path": SCREENSHOT_PATH if os.path.exists(SCREENSHOT_PATH) else "",
            "app_name": "Unknown",
            "element_count": 0,
            "error": str(e),
        }))


if __name__ == "__main__":
    main()
