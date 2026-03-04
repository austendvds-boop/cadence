import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BASE_URL: z.string().default('http://localhost:3000'),
  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  DEEPGRAM_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  UTTERANCE_END_MS: z.coerce.number().default(700),
  ENDPOINTING_MS: z.coerce.number().default(250),
  MAX_HISTORY_MESSAGES: z.coerce.number().default(20),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_SMS_NUMBER: z.string().optional(),
  TWILIO_WEBSOCKET_URL: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID: z.string().optional(),
  STRIPE_CHECKOUT_SUCCESS_URL: z.string().optional(),
  STRIPE_CHECKOUT_CANCEL_URL: z.string().optional(),
  AUSTEN_CELL_NUMBER: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export const env = EnvSchema.parse(process.env);
