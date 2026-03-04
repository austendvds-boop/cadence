import type { TenantConfig } from '../config/tenants';

type ToolParameterSchema = {
  type: 'object';
  properties: Record<string, { type: 'string'; description: string }>;
  required?: string[];
  additionalProperties?: boolean;
};

type FunctionToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolParameterSchema;
  };
};

const ALL_TOOL_DEFINITIONS: Record<string, FunctionToolDefinition> = {
  transfer_to_human: {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description:
        'Transfer the call to a human agent. Use ONLY when the caller explicitly asks to speak with a person, Austen, a human, or requests a callback. Never use this to send a text or booking link.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  send_sms: {
    type: 'function',
    function: {
      name: 'send_sms',
      description:
        'Send an SMS text message to the caller. Use whenever the caller asks to be texted anything - a booking link, pricing, information, etc. Do NOT use transfer_to_human for this.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The text message content to send to the caller' }
        },
        required: ['message'],
        additionalProperties: false,
      }
    }
  },
  save_onboarding_field: {
    type: 'function',
    function: {
      name: 'save_onboarding_field',
      description: 'Save one onboarding intake field and value for the current call session.',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description:
              'The onboarding field key to save, for example business_name, business_description, hours, services, faqs, greeting, transfer_number, owner_name, owner_email, area_code.'
          },
          value: {
            type: 'string',
            description: 'The caller provided value for that field.'
          }
        },
        required: ['field', 'value'],
        additionalProperties: false,
      }
    }
  },
  complete_onboarding: {
    type: 'function',
    function: {
      name: 'complete_onboarding',
      description: 'Complete onboarding, create a Stripe checkout link, and text that checkout link to the caller.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }
    }
  }
};

export const toolDefinitions: FunctionToolDefinition[] = Object.values(ALL_TOOL_DEFINITIONS);

export function getToolDefinitionsForTenant(tenant: TenantConfig): FunctionToolDefinition[] {
  return tenant.tools.flatMap((toolName) => {
    const definition = ALL_TOOL_DEFINITIONS[toolName];
    return definition ? [definition] : [];
  });
}

