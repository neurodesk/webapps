/** @param {Record<string, unknown>} body */
export function neurodeskRequest(body) {
  return {
    ...body,
    max_tokens: 8192,
    messages: Array.isArray(body.messages) ? body.messages.map((message) => {
      if (!message || typeof message !== 'object' || !('content' in message) || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.filter((part) =>
          !(part && typeof part === 'object' && 'type' in part && part.type === 'image_url')),
      };
    }) : body.messages,
  };
}
