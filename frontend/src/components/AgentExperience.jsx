import React, { Profiler } from 'react';
import { CopilotKit } from '@copilotkit/react-core';
import AgentDisasterRail from './AgentDisasterRail';
import AgentWorkspaceSidebar from './AgentWorkspaceSidebar';
import ControlPanel from './ControlPanel';
import LocationScopePicker from './LocationScopePicker';

// 浏览器始终通过当前站点的反向代理访问 CopilotKit Runtime。
const COPILOTKIT_URL = '/copilotkit';

function AgentExperience({ onError, sidebarProfiler }) {
  return (
    <CopilotKit
      runtimeUrl={COPILOTKIT_URL}
      agent="flood_agent"
      onError={onError}
    >
      <AgentDisasterRail />
      <ControlPanel />
      <Profiler id="AgentWorkspaceSidebar" onRender={sidebarProfiler}>
        <AgentWorkspaceSidebar />
      </Profiler>
      <div className="agent-location-search-dock">
        <LocationScopePicker embedded showInlineNote={false} />
      </div>
    </CopilotKit>
  );
}

export default AgentExperience;
