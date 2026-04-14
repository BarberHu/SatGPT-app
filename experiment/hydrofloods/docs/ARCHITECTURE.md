# HYDRAFloods Agent Architecture

This document reflects the current design of the `experiment/hydrofloods` agent after introducing:

- explicit execution planning
- preflight validation before execution
- asset recommendation as an independent early-stage decision
- separation between registry, adapter, and orchestration responsibilities

## Layered Architecture

```mermaid
flowchart LR
    U["User / Natural Language Query"] --> S["LangGraph Agent<br/>hydrafloods_langgraph_agent.py"]

    subgraph Agent["Agent Orchestration Layer"]
        N1["detect_environment"]
        N2["parse_request<br/>LLM + heuristic parse"]
        N3["plan_execution<br/>describe_only / assets_only / compute_only / hybrid"]
        N4["preflight_check<br/>params / time window / sensor suitability"]
        N5["select_tool"]
        N6["execute_tool"]
        N7["format_response"]
    end

    subgraph Registry["Registry Layer"]
        T1["tool_library.py<br/>tool specs / handler registry"]
        A1["assets_library.py<br/>curated asset registry / metadata"]
    end

    subgraph Adapter["Execution Adapter Layer"]
        X1["adapter.py<br/>workflow adapters"]
        X2["recommend_asset_layers"]
        X3["get_water_extent_tile"]
        X4["get_flood_extent_tile"]
        X5["estimate_flood_depth_tile"]
    end

    subgraph Runtime["Runtime / External Systems"]
        G1["Google Earth Engine"]
        G2["HYDRAFloods Python Library"]
        G3["OpenAI LLM<br/>routing only"]
    end

    subgraph Debug["Debug / Validation Layer"]
        D1["streamlit_debug_app.py"]
        D2["run_test_cases.py"]
    end

    S --> T1
    S --> A1
    S --> G3
    T1 --> X1
    A1 --> X1
    X1 --> G1
    X1 --> G2
    D1 --> S
    D2 --> S
    U --> D1
```

## Runtime Graph

```mermaid
flowchart TD
    Q["User Query"] --> E["detect_environment"]
    E --> P["parse_request"]
    P --> PL["plan_execution"]

    PL --> MODE{"Execution mode?"}
    MODE -->|"describe_only"| D["describe_hydrafloods_tools"]
    MODE -->|"assets_only"| A["recommend_flood_asset_layers"]
    MODE -->|"compute_only"| PF["preflight_check"]
    MODE -->|"hybrid"| PF

    PF --> BLOCK{"Blocking issues?"}
    BLOCK -->|"Yes"| ERR["Return error result<br/>with preflight findings"]
    BLOCK -->|"No"| ST["select_tool"]

    ST --> EX{"Dispatch"}
    EX -->|"compute_only"| C["Run compute adapter"]
    EX -->|"hybrid"| H1["Run asset recommendation"]
    H1 --> H2["Run compute adapter"]
    H2 --> H3["Merge outputs<br/>assets primary or compute primary"]

    D --> F["format_response"]
    A --> F
    C --> F
    H3 --> F
    ERR --> F

    F --> OUT["Structured result + response"]
```

## Execution Modes

The agent now plans execution explicitly before any tool runs.

### `describe_only`

- Used for capability and tool-library questions.
- No asset rendering.
- No HYDRAFloods computation.

### `assets_only`

- Used when the user wants data-product recommendation or reference layers only.
- Returns recommended asset layers.
- Does not run HYDRAFloods computation.

### `compute_only`

- Used when the user asks for a direct HYDRAFloods analysis result.
- Runs one compute adapter only.
- Does not attach recommendations automatically.

### `hybrid`

- Used when the query asks for both recommendation/context and fresh computation.
- Runs recommendation first, then compute.
- Keeps a declared primary output:
  - `assets`
  - `compute`

## Preflight Responsibilities

Preflight runs before real execution for compute and hybrid flows.

Current checks include:

- missing required parameters
- requested time window versus asset availability
- sensor suitability warnings

Examples:

- optical flood extent warns about cloud/shadow risk
- depth estimation warns when the chosen sensor is not ideal
- Sentinel-1 water mapping warns that thresholding may be unstable

## Module Responsibilities

### `hydrafloods_langgraph_agent.py`

- routing
- execution planning
- preflight validation
- dispatch
- response formatting

### `tool_library.py`

- tool catalog for the agent
- handler registration
- tool descriptions and intent mapping

### `assets_library.py`

- curated asset registry
- runtime overrides
- recommendable asset filtering
- asset metadata used in recommendation and rendering

### `adapter.py`

- execution harness for HYDRAFloods workflows
- asset layer rendering
- structured result generation
- map artifacts, legends, metadata, and repro code

### `streamlit_debug_app.py`

- manual testing shell for the latest agent structure
- map and legend inspection
- recommendation inspection
- raw-state debugging

### `run_test_cases.py`

- regression checks for routing and execution behavior
- token accounting
- report generation

## Design Boundary

The current design intentionally keeps these concerns separate:

- orchestration stays in the LangGraph layer
- tool registration stays in the tool library layer
- actual workflow execution stays in the adapter layer
- curated asset selection stays in the assets library layer

This avoids treating HYDRAFloods compute tools as if they were data-product recommendations.
