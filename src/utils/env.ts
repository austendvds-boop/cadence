import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BASE_URL: z.string().default('http://localhost:3000'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_TTS_MODEL: z.string().default('tts-1'),
  OPENAI_TTS_VOICE: z.string().default('alloy'),
  DEEPGRAM_API_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_WEBSOCKET_URL: z.string().optional(),
  AUSTEN_CELL_NUMBER: z.string().optional(),
  ACUITY_MINE_USER: z.string().optional(),
  ACUITY_MINE_KEY: z.string().optional(),
  ACUITY_PARENTS_USER: z.string().optional(),
  ACUITY_PARENTS_KEY: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

export const env = EnvSchema.parse(process.env);

export const hasRequiredRuntime = Boolean(env.OPENAI_API_KEY && env.DEEPGRAM_API_KEY && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
