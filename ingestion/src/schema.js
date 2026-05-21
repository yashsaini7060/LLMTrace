import { z } from 'zod';

/**
 * The wire format the SDK sends. Kept permissive: anything we don't
 * recognise lands in raw_payload so we never lose data.
 */
export const LogSchema = z.object({
  request_id: z.string().min(1),
  conversation_id: z.string().uuid().nullable().optional(),
  user_id: z.string().nullable().optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(['success', 'error', 'cancelled']),
  error_type: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
  streamed: z.boolean().default(false),
  latency_ms: z.number().int().nullable().optional(),
  ttft_ms: z.number().int().nullable().optional(),
  prompt_tokens: z.number().int().nullable().optional(),
  completion_tokens: z.number().int().nullable().optional(),
  total_tokens: z.number().int().nullable().optional(),
  input_preview: z.string().nullable().optional(),
  output_preview: z.string().nullable().optional(),
  request_started_at: z.string(),       // ISO timestamp
  request_finished_at: z.string().nullable().optional(),
  raw_payload: z.record(z.any()).default({})
});

export const BatchSchema = z.object({
  logs: z.array(LogSchema).min(1).max(500)
});
