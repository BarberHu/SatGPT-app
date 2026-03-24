# SatGPT Flood UI/UX Testing Plan

## 1. Purpose

This test plan is designed for the updated SatGPT flood workflows, with emphasis on UN business users rather than remote sensing engineers. The goal is not to evaluate algorithmic novelty. The goal is to verify whether a target user can reliably complete a flood analysis workflow with enough confidence to support operational deployment.

The tested workflow is:

```text
Define AOI -> Choose Ask/Agent mode -> Run analysis -> Confirm event -> Review imagery/impact layers -> Export output -> Submit feedback
```

## 2. Target Users

- Primary: UN programme staff, analysts, and coordinators with flood-response responsibilities
- Secondary: GIS support staff who occasionally help prepare boundaries or validate outputs

## 3. Core Research Questions

1. Can users successfully define an analysis boundary without external GIS preprocessing?
2. Do users understand when to use `Ask` versus `Agent`?
3. Does the confirmation step in agent mode reduce error or create friction?
4. Can users interpret pre-flood, peak, and post-flood imagery without facilitation?
5. Which step is the first hard blocker in a full task run?

## 4. Test Method

Use a moderated, task-based usability format with light think-aloud prompting. This is the highest ROI method for the current product maturity because it captures both completion data and failure context.

Recommended structure per participant:

- 5 minutes: context briefing
- 20 to 25 minutes: task execution
- 5 minutes: structured debrief

Recommended quantitative measures:

- Task completion: success / partial / fail
- Time on task
- SEQ-style ease score: 1 to 5
- Confidence score: 1 to 5

Recommended qualitative capture:

- First confusion point
- First trust-break point
- Workaround used
- Missing information needed to continue

## 5. Task Script

### Task A: Ask mode with manual AOI

Goal: use an uploaded GeoJSON or ZIP Shapefile to run a single inundation analysis.

Success criteria:

- User uploads a boundary without assistance
- User completes one Ask-mode flood analysis
- User exports GEE code

### Task B: Ask mode with fishnet AOI

Goal: run hotspot analysis from a clicked fishnet cell.

Success criteria:

- User identifies that map click defines AOI
- User changes the hotspot duration
- User reads at least one map layer and legend correctly

### Task C: Agent mode with automatic event extraction

Goal: analyze a flood event from natural-language input.

Success criteria:

- User can submit an event query
- User can understand and complete the confirmation step
- User can switch between pre, peak, and post imagery

### Task D: Agent mode with manual AOI override

Goal: keep the event context from the agent but override the analysis area with a boundary file.

Success criteria:

- User understands that uploaded AOI takes precedence
- User can view imagery and at least one impact layer
- User can export the report

## 6. Instrumentation Already Added

The frontend now records local UX events to browser storage. The current event set includes:

- `mode_switch`
- `aoi_upload_success`
- `aoi_upload_fail`
- `aoi_clear`
- `agent_new_chat`
- `agent_confirmation_confirm`
- `agent_confirmation_cancel`
- `imagery_request_success`
- `imagery_request_fail`
- `impact_request_success`
- `impact_request_fail`
- `impact_request_manual`
- `export_report`
- `export_gee_code`
- `ux_feedback_submit`
- `ux_feedback_export`
- `ux_feedback_clear`

These logs can be exported from the in-app `UX Feedback` widget as JSON after each session.

## 7. What to Review After Testing

Prioritize findings with this rule:

```text
Blocks completion > Causes mistrust > Slows the workflow > Cosmetic friction
```

The first review pass should produce:

1. Top 3 blockers by frequency
2. Top 3 trust issues by severity
3. A short fix list mapped to concrete UI components

Relevant implementation touchpoints in this repo:

- `frontend/src/components/AoiUploadPanel.js`
- `frontend/src/components/FeedbackWidget.js`
- `frontend/src/components/AgentPanel.js`
- `frontend/src/components/MapContainer.js`

## 8. Notes for Moderators

- Do not explain the difference between Ask and Agent unless the participant is fully blocked.
- If the participant asks whether the uploaded boundary will override the agent result, answer only after observing their expectation.
- If a task fails, record the exact step that broke, not just the final sentiment.
