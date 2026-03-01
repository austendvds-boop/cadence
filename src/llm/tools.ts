export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: "Transfer call to Austen's cell",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_sms',
      description: 'Send SMS to caller',
      parameters: { type: 'object', properties: { phone: { type: 'string' }, message: { type: 'string' } }, required: ['phone', 'message'] }
    }
  }
] as const;
