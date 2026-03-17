"""
NovaAssist Notification Agent — Reads macOS Notification Center database.
Queries recent notifications and outputs them as structured JSON.
Outputs NOTIFICATION_RESULT:{json} to stdout.
"""
import sys, os, json, sqlite3, plistlib, time


def get_notification_db_path():
    """Find the macOS Notification Center SQLite database."""
    try:
        import subprocess
        user_dir = subprocess.check_output(
            ["getconf", "DARWIN_USER_DIR"], text=True, timeout=5
        ).strip()
        db_path = os.path.join(user_dir, "com.apple.notificationcenter", "db2", "db")
        if os.path.exists(db_path):
            return db_path
    except Exception:
        pass

    home = os.path.expanduser("~")
    alt_path = os.path.join(
        home, "Library", "GroupContainers",
        "group.com.apple.usernoted", "db2", "db"
    )
    if os.path.exists(alt_path):
        return alt_path

    return None


def parse_notification_data(data_blob):
    """Parse the binary plist data from a notification record."""
    if not data_blob:
        return {}
    try:
        parsed = plistlib.loads(data_blob)
        result = {}

        if isinstance(parsed, dict):
            req = parsed.get("req", {})
            if isinstance(req, dict):
                result["title"] = req.get("titl", "")
                result["subtitle"] = req.get("subt", "")
                result["body"] = req.get("body", "")
            else:
                result["title"] = str(parsed.get("titl", ""))
                result["body"] = str(parsed.get("body", ""))
        return result
    except Exception:
        return {}


def get_app_name_from_bundle(bundle_id):
    """Try to resolve a readable app name from a bundle ID."""
    known = {
        "com.apple.MobileSMS": "Messages",
        "com.apple.mail": "Mail",
        "com.tinyspeck.slackmacgap": "Slack",
        "com.microsoft.teams2": "Teams",
        "com.apple.FaceTime": "FaceTime",
        "com.apple.iCal": "Calendar",
        "com.apple.reminders": "Reminders",
        "com.google.Chrome": "Chrome",
        "com.whatsapp.WhatsApp": "WhatsApp",
        "com.spotify.client": "Spotify",
        "com.discord": "Discord",
        "com.telegram.desktop": "Telegram",
        "com.facebook.archon": "Messenger",
    }
    if bundle_id in known:
        return known[bundle_id]
    parts = bundle_id.split(".")
    if len(parts) >= 3:
        return parts[-1].replace("-", " ").title()
    return bundle_id


def read_notifications(minutes_ago=60, limit=20):
    """Read recent notifications from the macOS Notification Center database."""
    db_path = get_notification_db_path()
    if not db_path:
        return {"error": "Notification database not found", "notifications": []}

    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        db.row_factory = sqlite3.Row

        cutoff = time.time() - (minutes_ago * 60)
        # macOS stores timestamps as Core Data timestamps (seconds since 2001-01-01)
        core_data_epoch = 978307200
        cutoff_cd = cutoff - core_data_epoch

        try:
            rows = db.execute(
                "SELECT app_id, data, delivered_date FROM record "
                "WHERE delivered_date > ? "
                "ORDER BY delivered_date DESC LIMIT ?",
                (cutoff_cd, limit)
            ).fetchall()
        except sqlite3.OperationalError:
            rows = db.execute(
                "SELECT app_id, data, delivered_date FROM record "
                "ORDER BY delivered_date DESC LIMIT ?",
                (limit,)
            ).fetchall()

        notifications = []
        for row in rows:
            app_id = row["app_id"] or ""
            data_blob = row["data"]
            delivered = row["delivered_date"]

            parsed = parse_notification_data(data_blob)
            app_name = get_app_name_from_bundle(app_id)

            ts = ""
            if delivered:
                try:
                    unix_ts = delivered + core_data_epoch
                    ts = time.strftime("%H:%M", time.localtime(unix_ts))
                except Exception:
                    pass

            notif = {
                "app": app_name,
                "title": parsed.get("title", ""),
                "body": parsed.get("body", ""),
                "time": ts,
            }
            if notif["title"] or notif["body"]:
                notifications.append(notif)

        db.close()
        return {"notifications": notifications, "count": len(notifications)}

    except Exception as e:
        return {"error": str(e), "notifications": []}


def main():
    minutes = 60
    limit = 20
    if len(sys.argv) > 1:
        try:
            params = json.loads(sys.argv[1])
            minutes = params.get("minutes", 60)
            limit = params.get("limit", 20)
        except (json.JSONDecodeError, TypeError):
            try:
                minutes = int(sys.argv[1])
            except ValueError:
                pass

    result = read_notifications(minutes, limit)
    print("NOTIFICATION_RESULT:" + json.dumps(result))


if __name__ == "__main__":
    main()
