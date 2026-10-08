"""Exercise the production nodes without credentials, network or GEE initialization."""
import ast
import asyncio
import json
import re
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Literal, Optional, TypedDict, Annotated
from unittest.mock import AsyncMock, Mock

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.graph import StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command, interrupt
from ag_ui.core import EventType, RunAgentInput, UserMessage
from copilotkit import LangGraphAGUIAgent
from boundary_geometry import is_approximate_search_scope


AGENT_DIR = Path(__file__).resolve().parents[1]
CANDIDATE = {
    "event": "Nepal flood", "location": "Rasuwa District, Nepal",
    "event_description": "Candidate event for confirmation.",
    "pre_date": "2026-08-19", "peek_date": "2026-08-26", "after_date": "2026-09-02",
}
AOI = {"id": "rasuwa", "bounds": {"west": 85, "south": 28, "east": 86, "north": 29}}
DSML = '<｜DSML｜tool_calls><｜DSML｜invoke name="execute_workflow">flood_analysis</｜DSML｜invoke></｜DSML｜tool_calls>'


class BaseState(TypedDict, total=False):
    messages: Annotated[list, add_messages]
    copilotkit: dict


@tool
def search_flood_event(query: str) -> str:
    """Test double for the registered search tool."""
    return "Source materials"


def load_nodes():
    # Match the repo's existing AST-isolation tests, but use real LangGraph and
    # message classes so routing, interrupts, and checkpoint resume are exercised.
    namespace = dict(
        asyncio=asyncio, json=json, re=re, date=date, Any=Any, Dict=Dict,
        Literal=Literal, Optional=Optional, RunnableConfig=RunnableConfig,
        AIMessage=AIMessage, HumanMessage=HumanMessage, SystemMessage=SystemMessage,
        Command=Command, interrupt=interrupt, StateGraph=StateGraph,
        ToolNode=ToolNode, MemorySaver=MemorySaver, tools=[search_flood_event],
        CopilotKitState=BaseState,
        is_approximate_search_scope=is_approximate_search_scope,
    )
    state_tree = ast.parse((AGENT_DIR / "state.py").read_text(encoding="utf-8"))
    state_defs = [n for n in state_tree.body if isinstance(n, ast.ClassDef)]
    namespace.update(List=list)
    exec(compile(ast.Module(body=state_defs, type_ignores=[]), "state.py", "exec"), namespace)
    exec((AGENT_DIR / "prompts.py").read_text(encoding="utf-8"), namespace)
    tree = ast.parse((AGENT_DIR / "flood_agent.py").read_text(encoding="utf-8"))
    helpers = {
        "_get_latest_user_message_content", "_extract_json_object",
        "_has_event_time_hint", "_has_specific_event_time_hint",
        "_has_explicit_spatial_mention", "_has_spatial_scope_mention",
        "_is_confirmation_reply", "_is_cancellation_reply", "_is_pending_workflow",
        "_is_completed_imagery_followup", "_completed_imagery_guidance",
        "_default_intent", "_normalize_intent", "_classify_user_intent",
        "_should_route_to_tool_node", "_extract_flood_info_from_content",
        "_format_sources_text", "_has_complete_flood_info", "_has_unexecutable_tool_output",
        "_checked_reply_config", "_reply_text_parts", "_has_chinese_prose",
        "_english_reply_text", "_english_chat_fallback",
        "entry_node", "intent_node", "chat_node", "extraction_node",
        "pre_confirmation_node", "confirmation_node", "processing_node",
        "_event_confirmation_data", "_cancel_event_confirmation",
        "_missing_confirmation_requirements", "_confirm_event_confirmation",
        "await_confirmation_node", "text_confirmation_node",
    }
    constants = {"_TIME_HINT_PATTERNS", "_SPECIFIC_TIME_HINT_PATTERNS", "NodeType"}
    definitions = [n for n in tree.body if getattr(n, "name", None) in helpers or (
        isinstance(n, ast.Assign) and any(getattr(t, "id", None) in constants for t in n.targets)
    )]
    exec(compile(ast.Module(body=definitions, type_ignores=[]), "flood_agent.py", "exec"), namespace)
    namespace["aoi_to_geo_fields"] = lambda aoi: {
        "coordinates": [85.5, 28.5], "bounds": aoi["bounds"], "geojson": aoi.get("geojson"),
    }
    namespace["resolve_mention_context"] = Mock(return_value={})
    namespace["build_confirmation_context"] = Mock(side_effect=lambda **kw: {
        **kw, "resolved_aoi": AOI, "confirmed_aoi": AOI,
        "selected_layer_ids": ["flood_detection"], "recommended_layers": [],
    })
    namespace["generate_flood_gee_code"] = Mock(return_value="// flood GEE code")
    namespace["_get_model"] = Mock(return_value=SimpleNamespace(
        ainvoke=AsyncMock(return_value=AIMessage(content="Source-backed report.")),
    ))
    namespace["_classify_user_intent"] = AsyncMock(side_effect=lambda msg, config, state: namespace["_normalize_intent"](
        {"requests_workflow": True, "has_time": True, "has_location": True, "missing_requirements": []}, msg, state,
    ))
    namespace["graph_statements"] = tree.body[next(
        i for i, n in enumerate(tree.body) if isinstance(n, ast.Assign)
        and any(getattr(t, "id", None) == "workflow" for t in n.targets)
    ):]
    return namespace


class FloodWorkflowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ns = load_nodes()

    async def test_legacy_guessed_scope_cannot_be_confirmed_or_processed(self):
        state = {**CANDIDATE, 'spatial_scope_message': '@Test area',
                 'selected_layer_ids': ['flood_detection'], 'user_confirmed': True,
                 'confirmed_aoi': {**AOI, 'source': 'place_search', 'status': 'Approximate boundary'}}
        command = self.ns['_confirm_event_confirmation'](state, require_scope=True)
        self.assertEqual(command.goto, '__end__')
        self.assertFalse(command.update['user_confirmed'])
        command = await self.call('processing_node', state)
        self.assertFalse(command.update['user_confirmed'])

    async def test_ambiguous_boundary_message_identifies_the_actual_choices(self):
        state = {**CANDIDATE, 'spatial_scope_message': '@Chiang Mai',
                 'selected_layer_ids': ['flood_detection'], 'aoi_resolution_meta': {'candidates': [
                     {'label': 'Chiang Mai City Municipality, Thailand'}, {'label': 'Chiang Mai Province, Thailand'},
                 ]}}
        command = await self.call('await_confirmation_node', state)
        self.assertIn('City Municipality', command.update['messages'].content)
        self.assertIn('Chiang Mai Province', command.update['messages'].content)
        self.assertFalse(command.update['user_confirmed'])

    async def call(self, node, state):
        return await self.ns[node](state, {})

    def test_candidate_dates_must_be_real_and_ordered(self):
        check = self.ns["_has_complete_flood_info"]
        self.assertTrue(check(CANDIDATE))
        for changes in ({"peek_date": "2026-02-30"}, {"pre_date": "2026-09-10"},
                        {"after_date": "2026-8-27"}, {"location": ""}):
            self.assertFalse(check({**CANDIDATE, **changes}))

    def test_json_cannot_set_workflow_stage(self):
        extracted = self.ns["_extract_flood_info_from_content"](json.dumps({**CANDIDATE, "stage": "completed"}))
        self.assertEqual(extracted["event"], CANDIDATE["event"])
        self.assertNotIn("stage", extracted)
        self.assertEqual(self.ns["_extract_flood_info_from_content"](DSML), {})

    async def test_workflow_is_remembered_before_scope_is_supplied(self):
        state = {"messages": [HumanMessage(content="2026年尼泊尔洪水的分析图像")]}
        command = await self.call("intent_node", state)
        self.assertEqual(command.update["stage"], "awaiting_workflow_event_confirmation")

    async def test_scope_followup_opens_confirmation_for_saved_candidate(self):
        state = {**CANDIDATE, "stage": "awaiting_workflow_event_confirmation",
                 "messages": [HumanMessage(content="@Rasuwa District, Nepal")]}
        command = await self.call("intent_node", state)
        self.assertEqual(command.goto, "pre_confirmation_node")
        self.assertEqual(command.update["spatial_scope_message"], "@Rasuwa District, Nepal")
        self.assertNotIn("user_confirmed", command.update)
        self.ns["_classify_user_intent"].assert_not_called()

    async def test_yes_preserves_scope_for_resolution(self):
        state = {**CANDIDATE, "stage": "awaiting_workflow_event_confirmation",
                 "spatial_scope_message": "@Rasuwa District, Nepal", "messages": [HumanMessage(content="yes")]}
        command = await self.call("intent_node", state)
        self.assertEqual(command.goto, "pre_confirmation_node")
        self.assertEqual(command.update["spatial_scope_message"], state["spatial_scope_message"])

    async def test_complete_candidate_without_scope_does_not_start(self):
        state = {"stage": "awaiting_workflow_event_confirmation", "intent": {"requests_workflow": True},
                 "messages": [HumanMessage(content="Analyze the flood"), AIMessage(content=json.dumps(CANDIDATE))]}
        command = await self.call("extraction_node", state)
        self.assertEqual(command.goto, "__end__")
        self.assertEqual(command.update["stage"], "awaiting_workflow_event_confirmation")

    async def test_information_only_candidate_does_not_start(self):
        command = await self.call("extraction_node", {"intent": {"requests_workflow": False},
            "messages": [HumanMessage(content="Tell me about this flood"), AIMessage(content=json.dumps(CANDIDATE))]})
        self.assertEqual(command.goto, "__end__")

    async def test_scope_is_resolved_from_saved_mention_after_yes(self):
        scope = "@Rasuwa District, Nepal"
        await self.call("pre_confirmation_node", {**CANDIDATE, "location": "Nepal",
            "spatial_scope_message": scope, "messages": [HumanMessage(content="yes")]})
        self.ns["resolve_mention_context"].assert_called_once_with(scope, thread_id=None)
        self.assertEqual(self.ns["build_confirmation_context"].call_args.kwargs["location"], CANDIDATE["location"])

    async def test_unsupported_tool_output_retries_once(self):
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content=DSML), AIMessage(content=json.dumps(CANDIDATE))]))
        self.ns["_get_model"].return_value = model
        command = await self.call("chat_node", {"messages": [HumanMessage(content="hello")], "intent": {}})
        self.assertEqual(model.ainvoke.await_count, 2)
        self.assertEqual(command.goto, "extraction_node")
        self.assertNotIn("DSML", command.update["messages"].content)

    async def test_chinese_explanation_is_translated_without_changing_candidate_json(self):
        payload = "```json\n" + json.dumps(CANDIDATE, indent=2) + "\n```"
        mixed = "以下是该事件的候选信息：\n\n" + payload + "\n\n请添加 @Rasuwa, Nepal 并回复 confirm。"
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[
            AIMessage(content=mixed, id="candidate-reply"),
            AIMessage(content=json.dumps({"translations": [
                "Here is the candidate event information:",
                "Please add @Rasuwa, Nepal and reply confirm.",
            ]})),
        ]))
        self.ns["_get_model"].return_value = model
        command = await self.call("chat_node", {"messages": [HumanMessage(content="帮我分析洪水")], "intent": {}})
        reply = command.update["messages"]
        self.assertEqual(reply.id, "candidate-reply")
        self.assertFalse(self.ns["_has_chinese_prose"](reply.content))
        self.assertIn(payload, reply.content)
        self.assertEqual(self.ns["_extract_flood_info_from_content"](reply.content), CANDIDATE)
        self.assertEqual(model.ainvoke.await_count, 2)
        for call in model.ainvoke.await_args_list:
            self.assertFalse(call.args[1]["metadata"]["emit-messages"])
            self.assertFalse(call.args[1]["metadata"]["copilotkit:emit-messages"])

    async def test_translation_failure_preserves_candidate_and_returns_english_guidance(self):
        payload = "```json\n" + json.dumps(CANDIDATE) + "\n```"
        mixed = "洪水日期为2026-08-26。\n\n" + payload
        for failed in (
            RuntimeError("translation unavailable"),
            AIMessage(content=json.dumps({"translations": ["洪水日期为2026-08-26。"]})),
            AIMessage(content=json.dumps({"translations": ["The flood date is 2026-08-27."]})),
            AIMessage(content=json.dumps({"translations": []})),
            AIMessage(content=DSML),
        ):
            with self.subTest(failed=type(failed).__name__):
                model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content=mixed), failed]))
                self.ns["_get_model"].return_value = model
                command = await self.call("chat_node", {"messages": [HumanMessage(content="帮我分析洪水")], "intent": {}})
                reply = command.update["messages"]
                self.assertFalse(self.ns["_has_chinese_prose"](reply.content))
                self.assertIn(payload, reply.content)
                self.assertEqual(self.ns["_extract_flood_info_from_content"](reply.content), CANDIDATE)
                self.assertEqual(model.ainvoke.await_count, 2)

    async def test_english_reply_and_chinese_code_do_not_trigger_translation(self):
        content = 'Candidate information:\n```json\n{"location": "尼泊尔"}\n```'
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content=content)))
        self.ns["_get_model"].return_value = model
        command = await self.call("chat_node", {"messages": [HumanMessage(content="hello")], "intent": {}})
        self.assertEqual(command.update["messages"].content, content)
        self.assertEqual(model.ainvoke.await_count, 1)

    async def test_registered_search_still_executes_with_english_status(self):
        tool_call = {"name": "search_flood_event", "args": {"query": "Nepal floods"}, "id": "search-1"}
        model = SimpleNamespace(ainvoke=AsyncMock(return_value=AIMessage(content="正在搜索", tool_calls=[tool_call])))
        model.bind_tools = Mock(return_value=model)
        self.ns["_get_model"].return_value = model
        command = await self.call("chat_node", {
            "messages": [HumanMessage(content="Tell me about the 2026 Nepal floods")],
            "intent": {"is_specific_flood_event": True, "should_use_search": True},
        })
        self.assertEqual(command.goto, "tool_node")
        self.assertEqual(command.update["messages"].tool_calls, [tool_call | {"type": "tool_call"}])
        self.assertFalse(self.ns["_has_chinese_prose"](command.update["messages"].content))
        self.assertEqual(model.ainvoke.await_count, 1)

    async def test_stream_emits_checked_english_reply_without_translation_json(self):
        payload = "```json\n" + json.dumps(CANDIDATE) + "\n```"
        model = FakeListChatModel(responses=[
            "以下是该事件的候选信息：\n\n" + payload,
            json.dumps({"translations": ["Here is the candidate event information:"]}),
        ])
        self.ns["_get_model"].return_value = model
        self.ns["_classify_user_intent"].side_effect = None
        self.ns["_classify_user_intent"].return_value = {"requests_workflow": False}
        exec(compile(ast.Module(body=self.ns["graph_statements"], type_ignores=[]), "graph", "exec"), self.ns)
        agent = LangGraphAGUIAgent(name="flood_agent", graph=self.ns["graph"])
        request = RunAgentInput(thread_id="english-stream", run_id="english-run", state={},
            messages=[UserMessage(id="user-1", content="帮我解释这一事件")], tools=[], context=[], forwarded_props={})
        events = [event async for event in agent.run(request)]
        self.assertFalse(any(event.type == EventType.RUN_ERROR for event in events))
        snapshots = [event for event in events if event.type == EventType.MESSAGES_SNAPSHOT]
        replies = [message for message in snapshots[-1].messages if message.role == "assistant"]
        self.assertTrue(replies)
        self.assertIn(payload, replies[-1].content)
        self.assertFalse(self.ns["_has_chinese_prose"](replies[-1].content))
        for event in events:
            if event.type == EventType.TEXT_MESSAGE_CONTENT:
                self.assertNotRegex(event.delta, r"[\u4e00-\u9fff]")
                self.assertNotIn("translations", event.delta)

    async def test_report_body_is_english_after_translation_or_provider_failure(self):
        for translated in (AIMessage(content=json.dumps({"translations": ["Event impacts remain unverified."]})),
                           RuntimeError("translation unavailable")):
            with self.subTest(translated=type(translated).__name__):
                model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[AIMessage(content="事件影响尚未核实。"), translated]))
                self.ns["_get_model"].return_value = model
                command = await self.call("processing_node", {**CANDIDATE,
                    "confirmed_aoi": AOI, "user_confirmed": True, "event_description": "影响尚未核实"})
                self.assertEqual(command.update["stage"], "completed")
                self.assertFalse(self.ns["_has_chinese_prose"](command.update["flood_report"]))
                self.assertEqual(command.update["pre_date"], CANDIDATE["pre_date"])

    async def test_unsupported_structured_call_never_reaches_tool_node(self):
        response = AIMessage(content="", tool_calls=[{"name": "execute_workflow", "args": {}, "id": "fake"}])
        model = SimpleNamespace(ainvoke=AsyncMock(side_effect=[response, AIMessage(content=DSML)]))
        self.ns["_get_model"].return_value = model
        command = await self.call("chat_node", {"messages": [HumanMessage(content="hello")], "intent": {}})
        self.assertEqual(command.goto, "extraction_node")
        self.assertIn("has not started", command.update["messages"].content)
        self.assertEqual(command.update["messages"].tool_calls, [])

    async def test_cancel_clears_pending_workflow(self):
        self.ns["interrupt"] = lambda _: {"cancelled": True}
        command = await self.call("confirmation_node", CANDIDATE)
        self.assertEqual(command.goto, "__end__")
        self.assertFalse(command.update["user_confirmed"])
        self.assertIsNone(command.update["event"])

    async def test_invalid_dates_cannot_confirm(self):
        self.ns["interrupt"] = lambda _: {"peek_date": "2026-02-30", "confirmed_aoi": AOI, "selected_layer_ids": ["flood_detection"]}
        command = await self.call("confirmation_node", CANDIDATE)
        self.assertEqual(command.goto, "__end__")
        self.assertFalse(command.update["user_confirmed"])

    async def test_confirm_updates_geometry_before_processing(self):
        changed_aoi = {**AOI, "bounds": {"west": 84, "south": 27, "east": 85, "north": 28}}
        self.ns["interrupt"] = lambda _: {"confirmed_aoi": changed_aoi, "selected_layer_ids": ["flood_detection"]}
        command = await self.call("confirmation_node", CANDIDATE)
        self.assertEqual(command.goto, "processing_node")
        self.assertEqual(command.update["bounds"], changed_aoi["bounds"])
        self.assertTrue(command.update["user_confirmed"])
        self.assertEqual(command.update["stage"], "confirmed")

    async def test_processing_requires_real_confirmation(self):
        command = await self.call("processing_node", {**CANDIDATE, "confirmed_aoi": AOI})
        self.assertFalse(command.update["user_confirmed"])
        self.ns["_get_model"].assert_not_called()

    async def test_report_failure_keeps_confirmed_map_context_and_code(self):
        self.ns["_get_model"].side_effect = RuntimeError("provider unavailable")
        command = await self.call("processing_node", {**CANDIDATE, "confirmed_aoi": AOI, "user_confirmed": True})
        self.assertEqual(command.update["stage"], "completed")
        self.assertEqual(command.update["gee_code"], "// flood GEE code")
        self.assertTrue(command.update["flood_report"])

    async def test_real_graph_waits_for_chat_confirmation_then_processes(self):
        exec(compile(ast.Module(body=self.ns["graph_statements"], type_ignores=[]), "graph", "exec"), self.ns)
        graph = self.ns["graph"]
        config = {"configurable": {"thread_id": "flood-workflow-regression"}}
        model = self.ns["_get_model"].return_value
        model.bind_tools = Mock(return_value=model)
        model.ainvoke.side_effect = [AIMessage(content=json.dumps(CANDIDATE)), AIMessage(content="Source-backed report.")]
        result = await graph.ainvoke({"messages": [HumanMessage(content="2026年尼泊尔洪水的分析图像")]}, config)
        self.assertEqual(result["stage"], "awaiting_workflow_event_confirmation")
        self.assertFalse(result.get("user_confirmed", False))
        self.assertEqual(result["event"], CANDIDATE["event"])
        result = await graph.ainvoke({"messages": [HumanMessage(content="@Rasuwa District, Nepal")]}, config)
        self.assertEqual(result["stage"], "awaiting_user_confirmation")
        self.assertFalse(result.get("__interrupt__"))
        self.assertFalse(result["user_confirmed"])
        confirmation_text = result["messages"][-1].content
        self.assertIn("Ready for your confirmation", confirmation_text)
        self.assertIn("confirm", confirmation_text)
        self.assertIn("cancel", confirmation_text)
        self.assertNotRegex(confirmation_text, r"[\u4e00-\u9fff]")
        self.assertEqual(model.ainvoke.await_count, 1)
        result = await graph.ainvoke({"messages": [HumanMessage(content="confirm")]}, config)
        self.assertEqual(result["stage"], "completed")
        self.assertTrue(result["user_confirmed"])
        self.assertEqual(result["gee_code"], "// flood GEE code")
        self.assertEqual(result["report_document"], result["flood_report"])

    async def test_information_query_then_scope_then_confirm_never_needs_dialog(self):
        exec(compile(ast.Module(body=self.ns["graph_statements"], type_ignores=[]), "graph", "exec"), self.ns)
        graph = self.ns["graph"]
        config = {"configurable": {"thread_id": "information-to-analysis"}}
        self.ns["_classify_user_intent"].return_value = {"requests_workflow": False}
        self.ns["_classify_user_intent"].side_effect = None
        model = self.ns["_get_model"].return_value
        model.bind_tools = Mock(return_value=model)
        model.ainvoke.side_effect = [
            AIMessage(content="The Nepal flood happened on 26 August 2026. Add @ to request analysis."),
            AIMessage(content=json.dumps(CANDIDATE)),
            AIMessage(content="Provisional monitoring report."),
        ]
        result = await graph.ainvoke({"messages": [HumanMessage(content="尼泊尔2026年洪水")]}, config)
        self.assertEqual(result["stage"], "initial")
        result = await graph.ainvoke({"messages": [HumanMessage(content="@Rasuwa, Nepal")]}, config)
        self.assertEqual(result["stage"], "awaiting_user_confirmation")
        self.assertFalse(result.get("__interrupt__"))
        self.assertIn("confirm", result["messages"][-1].content)
        self.assertNotIn("button", result["messages"][-1].content)
        self.assertEqual(self.ns["_classify_user_intent"].await_count, 1)
        result = await graph.ainvoke({"messages": [HumanMessage(content="confirm")]}, config)
        self.assertTrue(result["user_confirmed"])
        self.assertEqual(result["stage"], "completed")
        self.assertEqual(result["gee_code"], "// flood GEE code")
        self.assertEqual(model.ainvoke.await_count, 3)
        completed_state = result
        result = await graph.ainvoke({"messages": [HumanMessage(content="@Rasuwa, Nepal显示分析图像了吗")]}, config)
        for key in ("stage", "user_confirmed", "event", "pre_date", "peek_date", "after_date",
                    "confirmed_aoi", "selected_layer_ids", "flood_report", "gee_code"):
            self.assertEqual(result[key], completed_state[key], key)
        self.assertIn("Apply imagery window", result["messages"][-1].content)
        self.assertIn("does not confirm", result["messages"][-1].content)
        self.assertEqual(model.ainvoke.await_count, 3)
        self.assertEqual(self.ns["_classify_user_intent"].await_count, 1)

    async def test_chat_confirmation_supports_english_and_chinese(self):
        for text in ("confirm", "确认", "yes", "yes please", "好的", "开始分析"):
            with self.subTest(text=text):
                state = {**CANDIDATE, "stage": "awaiting_user_confirmation",
                    "confirmed_aoi": AOI, "selected_layer_ids": ["core:flood_detection"],
                    "spatial_scope_message": "@Rasuwa, Nepal", "messages": [HumanMessage(content=text)]}
                command = await self.call("intent_node", state)
                self.assertEqual(command.goto, "text_confirmation_node")
                command = await self.call("text_confirmation_node", state)
                self.assertEqual(command.goto, "processing_node")
                self.assertTrue(command.update["user_confirmed"])
                self.assertNotRegex(command.update["messages"].content, r"[\u4e00-\u9fff]")
        self.ns["_classify_user_intent"].assert_not_called()

    async def test_chat_confirmation_does_not_run_with_missing_dates_scope_or_boundary(self):
        for changes in ({"peek_date": None}, {"spatial_scope_message": None},
                        {"confirmed_aoi": None}, {"selected_layer_ids": []}):
            with self.subTest(changes=changes):
                state = {**CANDIDATE, "stage": "awaiting_user_confirmation",
                    "confirmed_aoi": AOI, "selected_layer_ids": ["core:flood_detection"],
                    "spatial_scope_message": "@Rasuwa, Nepal", "messages": [HumanMessage(content="confirm")], **changes}
                command = await self.call("text_confirmation_node", state)
                self.assertEqual(command.goto, "__end__")
                self.assertFalse(command.update["user_confirmed"])
                self.assertIn("has not started", command.update["messages"].content)
                self.assertNotRegex(command.update["messages"].content, r"[\u4e00-\u9fff]")

    async def test_negative_reply_is_not_confirmation(self):
        state = {**CANDIDATE, "stage": "awaiting_user_confirmation",
            "confirmed_aoi": AOI, "selected_layer_ids": ["core:flood_detection"],
            "spatial_scope_message": "@Rasuwa, Nepal", "messages": [HumanMessage(content="do not confirm")]}
        command = await self.call("text_confirmation_node", state)
        self.assertEqual(command.goto, "await_confirmation_node")
        self.assertNotIn("user_confirmed", command.update or {})

    async def test_cancel_in_chat_clears_candidate_without_model_call(self):
        command = await self.call("intent_node", {**CANDIDATE, "stage": "awaiting_user_confirmation",
            "messages": [HumanMessage(content="取消")]})
        self.assertEqual(command.goto, "__end__")
        self.assertFalse(command.update["user_confirmed"])
        self.assertIsNone(command.update["confirmed_aoi"])
        self.assertNotRegex(command.update["messages"].content, r"[\u4e00-\u9fff]")
        self.ns["_classify_user_intent"].assert_not_called()

    async def test_repeated_confirmation_does_not_restart_completed_event(self):
        command = await self.call("entry_node", {**CANDIDATE, "stage": "completed",
            "user_confirmed": True, "messages": [HumanMessage(content="confirm")]})
        self.assertEqual(command.goto, "__end__")
        self.assertNotIn("stage", command.update)
        self.assertNotIn("user_confirmed", command.update)

    async def test_imagery_followup_preserves_confirmed_state_without_model_claims(self):
        for question in ("@Rasuwa, Nepal显示分析图像了吗", "图像为什么没显示", "Where are the satellite images?", "Show the flood map"):
            with self.subTest(question=question):
                state = {**CANDIDATE, "stage": "completed", "user_confirmed": True,
                    "confirmed_aoi": AOI, "spatial_scope_message": "@Rasuwa, Nepal",
                    "messages": [HumanMessage(content=question)]}
                command = await self.call("entry_node", state)
                self.assertEqual(command.goto, "__end__")
                self.assertEqual(set(command.update), {"messages"})
                self.assertIn("Flood Detection", command.update["messages"].content)
                self.assertIn("does not confirm", command.update["messages"].content)
                self.assertNotIn("text-only", command.update["messages"].content)
                self.ns["_get_model"].assert_not_called()

    async def test_new_event_or_different_scope_does_not_reuse_completed_analysis(self):
        for question in ("@Kathmandu, Nepal显示分析图像了吗", "Show images of the 2024 Bangladesh flood"):
            with self.subTest(question=question):
                command = await self.call("entry_node", {**CANDIDATE, "stage": "completed", "user_confirmed": True,
                    "spatial_scope_message": "@Rasuwa, Nepal", "messages": [HumanMessage(content=question)]})
                self.assertEqual(command.goto, "intent_node")
                self.assertFalse(command.update["user_confirmed"])
                self.assertEqual(command.update["stage"], "initial")


if __name__ == "__main__":
    unittest.main()
