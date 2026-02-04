/**
 * Agent 模式聊天输入组件
 * 用于在 Agent 模式下显示一个简单的提示，引导用户使用 AgentPanel
 */
import React from 'react';

function AgentChatInput({ onModeToggle }) {
  return (
    <div className="agent-chat-input">
      <div className="chat-msg">
        {/* Mode Toggle */}
        <div className="mode-toggle-inline">
          <span className="mode-label-v">Ask</span>
          <label className="mode-switch-v">
            <input
              type="checkbox"
              checked={true}
              onChange={onModeToggle}
            />
            <span className="mode-slider-v"></span>
          </label>
          <span className="mode-label-v active">Agent</span>
        </div>

        <div className="agent-mode-hint">
          <span className="hint-icon">🤖</span>
          <span className="hint-text">使用右侧智能体面板进行洪水分析</span>
        </div>
      </div>

      <style jsx="true">{`
        .agent-chat-input {
          width: 100%;
        }
        .agent-mode-hint {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 15px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 8px;
          color: white;
          font-size: 14px;
          flex: 1;
        }
        .hint-icon {
          font-size: 18px;
        }
        .hint-text {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `}</style>
    </div>
  );
}

export default AgentChatInput;
