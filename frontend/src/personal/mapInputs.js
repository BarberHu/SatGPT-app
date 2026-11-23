/** Historical text remains readable after disconnect; private map tiles stay hidden. */
export function visibleMapMessages(messages, connection, owner) {
  return messages.map(message => ({ ...message, layers: (message.layers || []).filter(layer => {
    const execution = layer.generation?.analysis_context?.execution;
    return execution?.mode !== 'personal' || Boolean(connection?.active && connection?.readable && execution.owner === owner);
  }) }));
}
