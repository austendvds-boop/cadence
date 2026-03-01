export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'check_availability',
      description: 'Check available lesson time slots for region/date range',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string' },
          package_type: { type: 'string', enum: ['2h5', '5h'] },
          date_from: { type: 'string' },
          date_to: { type: 'string' }
        },
        required: ['region', 'package_type', 'date_from']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Book a driving lesson appointment after confirmation',
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          region: { type: 'string' },
          package_type: { type: 'string', enum: ['2h5', '5h'] },
          datetime: { type: 'string' },
          address: { type: 'string' },
          notes: { type: 'string' }
        },
        required: ['first_name', 'last_name', 'phone', 'region', 'package_type', 'datetime', 'address']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: 'Transfer call to Austen',
      parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_sms',
      description: 'Send sms confirmation',
      parameters: { type: 'object', properties: { phone: { type: 'string' }, message: { type: 'string' } }, required: ['phone', 'message'] }
    }
  }
] as const;
