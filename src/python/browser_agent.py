import sys
import json
from nova_act import NovaAct, workflow

@workflow(workflow_definition_name='hackathon-test', model_id='nova-act-latest')
def execute_browser_task():
    task = json.loads(sys.argv[1])
    instruction = task.get("instruction", "")
    start_url = task.get("start_url", "https://www.google.com")

    with NovaAct(starting_page=start_url, headless=False) as nova:
        result = nova.act(instruction)
        nova.page.screenshot(path="/tmp/nova_browser_screenshot.png")
        output = {"success": True, "screenshot": "/tmp/nova_browser_screenshot.png"}
        print("NOVA_RESULT:" + json.dumps(output))

if __name__ == "__main__":
    try:
        execute_browser_task()
    except Exception as e:
        print("NOVA_RESULT:" + json.dumps({"success": False, "error": str(e)}))
