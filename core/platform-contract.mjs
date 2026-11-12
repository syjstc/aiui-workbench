import { z } from 'zod';

export const platformAgentId = z.string().regex(/^[A-Za-z0-9._-]{8,128}$/);
const text = (max) => z.string().trim().min(1).max(max);
export const platformUploadSchema = z.object({
  projectId: text(128), agentId: platformAgentId,
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  description: text(500).optional(), category: text(80).optional(),
  resumeUploadId: text(128).optional(),
  waitMs: z.number().int().min(0).max(55000).default(45000),
}).strict();
export const platformReviewSchema = z.object({
  projectId: text(128), description: text(500), prologue: text(300),
  versionLog: z.string().trim().min(5).max(1000),
  previewFiles: z.array(text(4096)).min(3).max(5).optional(),
  iconFile: text(4096).optional(),
  permissionUsage: z.record(z.string(), text(500)).default({}),
  waitMs: z.number().int().min(0).max(55000).default(45000),
}).strict();
