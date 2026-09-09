import React from 'react';
import { extractVisibleMessageText } from '../utils/mentionUtils';

function AgentUserMessage({ message }) {
  const content = extractVisibleMessageText(message?.content);

  return (
    <div className="copilotKitMessage copilotKitUserMessage">
      {content}
    </div>
  );
}

export default AgentUserMessage;
