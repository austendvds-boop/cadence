export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: 'Transfer the call to a human agent. Use ONLY when the caller explicitly asks to speak with a person, Austen, a human, or requests a callback. Never use this to send a text or booking link.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_sms',
      description: 'Send an SMS text message to the caller. Use whenever the caller asks to be texted anything - a booking link, pricing, information, etc. Do NOT use transfer_to_human for this.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The text message content to send to the caller' }
        },
        required: ['message']
      }
    }
  }
] as const;

