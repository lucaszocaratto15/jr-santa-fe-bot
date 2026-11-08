"""Regression tests for the existing MiniMax gateway's request-context pruning."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

with patch.dict(os.environ, {"MINIMAX_API_KEY": "fixture-not-a-secret"}):
    spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("gateway.py"))
    gateway = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gateway)


def tool(identifier, text):
    return [
        {"role": "assistant", "tool_calls": [{"id": identifier, "function": {"name": "strata_consultas_executar", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": identifier, "content": text},
    ]


class ContextTests(unittest.TestCase):
    def test_report_json_and_all_active_pages_survive_large_history(self):
        payload = json.dumps({"rows": [{"id": i, "description": "x" * 300} for i in range(82)]})
        messages = [{"role": "system", "content": "instructions " * 12000}]
        messages += [{"role": "user", "content": "old request"}] + tool("old", "old " * 20000)
        messages += [{"role": "user", "content": "pesquise combustivel somente pelo MCP"}]
        for i in range(7):
            messages += tool(str(i), payload)
        expected = copy.deepcopy(messages[4:])
        request = {"messages": messages}
        gateway.apply_jr_context(request)
        self.assertEqual(messages[4:], expected)
        self.assertTrue(messages[3]["content"].startswith("[saída antiga omitida,"))
        self.assertEqual(len(json.loads(messages[-1]["content"])["rows"]), 82)

    def test_active_results_without_user_boundary_are_not_silently_cut(self):
        request = {"messages": tool("1", "x" * 40000)}
        expected = copy.deepcopy(request)
        gateway.apply_jr_context(request)
        self.assertEqual(request, expected)

    def test_new_user_turn_makes_old_results_eligible_again(self):
        request = {"messages": [{"role": "user", "content": "old"}] + tool("1", "x" * 40000) + [{"role": "user", "content": "new"}]}
        gateway.apply_jr_context(request)
        self.assertLessEqual(len(request["messages"][2]["content"]), gateway.TOOL_RESULT_CHARS)
        self.assertEqual(request["messages"][-1]["content"], "new")

    def test_active_structured_content_and_snapshot_like_data_are_preserved(self):
        payload = [{"type": "text", "text": "Page Snapshot ```yaml\n" + "x" * 40000}]
        request = {"messages": [{"role": "user", "content": "pesquise dados MCP"}] + tool("a", payload) + tool("b", payload)}
        expected = copy.deepcopy(request)
        gateway.apply_jr_context(request, {"contextPruning": False})
        self.assertEqual(request, expected)


if __name__ == "__main__":
    unittest.main()
