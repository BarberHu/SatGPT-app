import ast
import importlib.util
import json
from pathlib import Path
import unittest
from typing import TypedDict
from unittest.mock import Mock


AGENT_DIR = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('event_validation', AGENT_DIR / 'event_validation.py')
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class Command:
    def __class_getitem__(cls, _item):
        return cls

    def __init__(self, *, goto, update):
        self.goto, self.update = goto, update


def load_confirmation(responses):
    source = AGENT_DIR / 'flood_agent.py'
    tree = ast.parse(source.read_text(encoding='utf-8'))
    definition = next(node for node in tree.body if getattr(node, 'name', None) == 'confirmation_node')
    command_type = Command
    config_type = dict
    interrupt = Mock(side_effect=responses)
    if responses is None:
        from langchain_core.runnables import RunnableConfig
        from langgraph.types import Command as GraphCommand, interrupt as graph_interrupt
        command_type, interrupt = GraphCommand, graph_interrupt
        config_type = RunnableConfig
    namespace = {
        'FloodAgentState': dict, 'RunnableConfig': config_type, 'Command': command_type, 'NodeType': str,
        'interrupt': interrupt, 'json': json, 'AIMessage': lambda **kwargs: kwargs,
        'validate_flood_event_dates': validation.validate_flood_event_dates,
    }
    exec(compile(ast.Module(body=[definition], type_ignores=[]), str(source), 'exec'), namespace)
    return namespace['confirmation_node'], interrupt


class EventDateValidationTests(unittest.TestCase):
    def test_invalid_windows_are_rejected(self):
        for values in [('', '2021-07-20', '2021-07-30'), ('2021-02-29', '2021-07-20', '2021-07-30'),
                       ('2021-08-01', '2021-07-20', '2021-07-30'), ('2021-07-10', '2021-07-20', '2021-07-01')]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                validation.validate_flood_event_dates(*values)

    def test_equal_dates_and_leap_days_are_valid(self):
        validation.validate_flood_event_dates('2024-02-29', '2024-02-29', '2024-03-01')


class ConfirmationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    state = {'event': 'Test', 'pre_date': '2021-07-10', 'peek_date': '2021-07-20', 'after_date': '2021-07-30'}

    async def test_invalid_resume_reopens_confirmation_until_dates_are_corrected(self):
        handler, interrupt = load_confirmation([
            {'pre_date': '2021-08-01'},
            {'pre_date': '2021-07-10'},
        ])
        result = await handler(self.state, {})
        self.assertEqual(interrupt.call_count, 2)
        self.assertIn('pre-flood ≤ peak', interrupt.call_args_list[1].args[0]['message'])
        self.assertEqual(result.update['pre_date'], '2021-07-10')
        self.assertTrue(result.update['user_confirmed'])

    async def test_user_can_cancel_after_invalid_dates(self):
        handler, interrupt = load_confirmation([
            {'after_date': '2021-07-01'},
            {'cancelled': True},
        ])
        result = await handler(self.state, {})
        self.assertEqual(interrupt.call_count, 2)
        self.assertEqual(result.update['stage'], 'initial')
        self.assertFalse(result.update['user_confirmed'])

    async def test_real_langgraph_replay_reinterrupts_then_accepts_corrected_dates(self):
        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import StateGraph
        from langgraph.types import Command as GraphCommand
        handler, _ = load_confirmation(None)
        channel_names = (
            'messages event event_description location pre_date peek_date after_date resolved_aoi '
            'aoi_resolution_meta recommended_layers selected_layer_ids recommendation_strategy '
            'recommendation_source confirmed_aoi confirmation_version mentioned_layer_refs '
            'mentioned_aoi mentioned_aoi_source stage user_confirmed is_valid_flood_query'
        ).split()
        confirmation_state = TypedDict('ConfirmationState', {name: object for name in channel_names}, total=False)
        builder = StateGraph(confirmation_state)
        builder.add_node('confirmation_node', handler)
        builder.set_entry_point('confirmation_node')
        graph = builder.compile(checkpointer=MemorySaver())
        config = {'configurable': {'thread_id': 'event-date-replay'}}
        first = await graph.ainvoke(self.state, config)
        self.assertTrue(first['__interrupt__'])
        invalid = await graph.ainvoke(GraphCommand(resume={'pre_date': '2021-08-01'}), config)
        self.assertIn('pre-flood ≤ peak', invalid['__interrupt__'][0].value['message'])
        recovered = await graph.ainvoke(GraphCommand(resume={'pre_date': '2021-07-10'}), config)
        self.assertTrue(recovered['user_confirmed'])


if __name__ == '__main__':
    unittest.main()
