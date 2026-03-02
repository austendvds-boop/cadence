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
  },
  {
    type: 'function',
    function: {
      name: 'notify_owner',
      description: 'Send a brief SMS summary of this call to the owner. Call this once when the conversation is naturally wrapping up. Include what the caller asked about and the outcome.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Short summary: caller number, what they asked, outcome (e.g. "Caller +16025551234 asked about pricing. Sent booking link.")'
          }
        },
        required: ['summary']
      }
    }
  }
] as const;

