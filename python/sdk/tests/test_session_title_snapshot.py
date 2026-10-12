"""Project recorded title stability and reasoning controls through the Python SDK."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness
from deepseek_harness.models import Notification

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
FIXTURE = ROOT / 'snapshots' / 'sdk' / 'session-title-stability'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_session_title_stability_snapshot(tmp_path: Path) -> None:
    # Authored replay plugins are workspace-only additions to the shipped SDK profile.
    modules = tmp_path / 'home' / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    modules.mkdir(parents=True)
    for name, source in (
        ('llm-replay', 'test-support/llm-replay'),
        ('session-title-all-prompts-llm', 'session/session-title-all-prompts-llm'),
    ):
        (modules / f'dsh-{name}').symlink_to(ROOT / 'packages' / source, target_is_directory=True)
    events = [json.loads(line) for line in (FIXTURE / 'session.v4.jsonl').read_text().splitlines()]
    prompts = [
        event['data']['content'][0]['text'] for event in events
        if event.get('type') == 'user/message' and event['data']['source']['kind'] == 'user'
    ]
    titles: list[str] = []
    requests: list[dict] = []

    def collect(notification: Notification) -> None:
        if notification.method != 'session.event':
            return
        event = notification.payload.get('event')
        if not isinstance(event, dict):
            return
        data = event['data']
        if event['type'] == 'session/title' and data['source']['kind'] == 'provider':
            titles.append(data['title'])
        elif event['type'] == 'session/title-llm-request':
            requests.append(data)

    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(FIXTURE / 'cordis.snapshot.yml'),),
        provider='deepseek-official',
        model='deepseek-v4-flash',
        env={
            'DSH_TELEMETRY_DISABLED': '1',
            'DSH_AGENTS_HOME': str(tmp_path / '.agents'),
            'DSH_SNAPSHOT': 'replay',
            'DSH_SNAPSHOT_FILE': str(FIXTURE / 'session.v4.jsonl'),
            'DSH_SNAPSHOT_OVERRIDE': str(FIXTURE / 'replay.override.json'),
        },
    ) as harness:
        session = harness.start_session()
        with harness.client.subscribe_session_notifications(session.id) as subscription:
            for index, prompt in enumerate(prompts, 1):
                result = session.run(prompt)
                assert result.finish_reason == 'completed', result.events
                deadline = time.monotonic() + 10
                while len(titles) < index and time.monotonic() < deadline:
                    subscription.drain(collect)
                    if len(titles) < index:
                        time.sleep(0.01)
                assert len(titles) == index, f'Missing accepted title for turn {index}'
    actual = {
        'titles': titles,
        'reasoning_efforts': [request['reasoningEffort'] for request in requests],
        'previous_title_anchors': [
            '"currentTitle":"阳台种番茄与罗勒"' in request['messages'][0]['content'][0]['text']
            for request in requests
        ],
    }
    expected = Path(__file__).with_name('expected') / 'session-title-stability.json'
    assert actual == json.loads(expected.read_text())
