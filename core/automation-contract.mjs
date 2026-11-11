import { z } from 'zod';

const empty = z.object({}).strict();
const pose = { yaw:z.number().min(-180).max(180).optional(), pitch:z.number().min(-89).max(89).optional(), roll:z.number().min(-180).max(180).optional() };
export const previewParameters = {
  tap: empty, back: empty, reload: empty, exit: empty,
  key: z.object({ code: z.enum(['Enter', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space']), type: z.enum(['keydown', 'keyup']).default('keyup'), timestamp: z.number().nonnegative().optional() }).strict(),
  swipe: z.object({ direction: z.enum(['forward', 'backward']).default('forward'), repeats: z.number().int().min(1).max(50).default(1), intervalMs: z.number().int().min(10).max(500).default(45), keyupOnly: z.boolean().optional(), aliases: z.boolean().optional() }).strict().refine(p => p.repeats * p.intervalMs <= 8000, 'A swipe burst must be at most 8 seconds'),
  pose: z.object(pose).strict(),
  pose_stream: z.object({ enabled: z.boolean() }).strict(),
  pose_motion: z.object({ enabled: z.boolean(), pattern: z.enum(['yaw', 'pitch', 'roll', 'orbit']).optional(), amplitude: z.number().min(1).max(60).optional(), periodMs: z.number().min(1000).max(20000).optional() }).strict(),
  mouse: z.object({ enabled: z.boolean().optional(), sensitivity: z.number().min(.05).max(1).optional() }).strict(),
  camera_fixture: z.object({ path: z.string().min(1).describe('Absolute local PNG/JPEG/WebP path, at most 10 MB') }).strict(),
  camera_source: z.object({ source: z.enum(['fixture', 'webcam']) }).strict(),
  camera_permission: z.object({ allowed: z.boolean() }).strict(),
  battery: z.object({ level: z.number().min(0).max(1).optional(), charging: z.boolean().optional(), chargingTime: z.number().nonnegative().optional(), dischargingTime: z.number().nonnegative().optional() }).strict(),
  focus: z.object({ focused: z.boolean() }).strict(),
  network: z.object({ online: z.boolean() }).strict(),
  target: z.object({ target: z.enum(['_blank', '_current']) }).strict(),
};
const expectation = z.object({
  state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Exact simulator state values by dotted path, e.g. {"pose.yaw":12,"running":true}. This does not inspect private app data.'),
  logContains: z.string().min(1).optional().describe('Wait for a NEW log containing this literal text during this step'),
  logCount: z.object({ contains: z.string().min(1), count: z.number().int().min(0).max(500) }).strict().optional().describe('Exact count of NEW matching logs during this step; checked after settleMs'),
}).strict();
export const ACTION_HELP = {
  tap:'{}', back:'{}', key:'{code: Enter|Backspace|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Space, type?: keydown|keyup, timestamp?: ms}',
  swipe:'{direction?: forward|backward, repeats?: 1..50, intervalMs?: 10..500, keyupOnly?: boolean, aliases?: boolean}; at most 8 seconds',
  pose:'{yaw?: -180..180, pitch?: -89..89, roll?: -180..180} degrees', pose_stream:'{enabled: boolean}',
  pose_motion:'{enabled: boolean, pattern?: yaw|pitch|roll|orbit, amplitude?: 1..60, periodMs?: 1000..20000}', mouse:'{enabled?: boolean, sensitivity?: 0.05..1}',
  camera_fixture:'{path: absolute PNG/JPEG/WebP file <=10MB}', camera_source:'{source: fixture|webcam}; video preview and grabFrame snapshots', camera_permission:'{allowed: boolean}',
  battery:'{level?: 0..1, charging?: boolean, chargingTime?: seconds, dischargingTime?: seconds}', focus:'{focused: boolean}', network:'{online: boolean}',
  target:'{target: _blank|_current}', reload:'{}', exit:'{}', wait:'{}; use waitMs/settleMs and expect',
};
// A single common step schema keeps MCP discovery small. Strict per-action
// validation still happens before any input is dispatched.
export const previewStep = z.object({
  name: z.string().max(120).optional(), action: z.enum(Object.keys(ACTION_HELP)),
  parameters: z.record(z.string(),z.unknown()).default({}).describe(Object.entries(ACTION_HELP).map(([key,value])=>`${key}: ${value}`).join('; ')),
  waitMs: z.number().int().min(0).max(10000).default(0).describe('Pause BEFORE this step, e.g. 400 ms between physical swipes'),
  settleMs: z.number().int().min(0).max(5000).default(200).describe('Observe AFTER dispatch; use for delayed callbacks and exact log counts'),
  expect: expectation.optional(), timeoutMs: z.number().int().min(200).max(10000).default(3000),
}).strict().transform((step,context)=>{
  const result=(previewParameters[step.action]||empty).safeParse(step.parameters);
  if(!result.success){for(const issue of result.error.issues)context.addIssue({...issue,path:['parameters',...issue.path]});return z.NEVER;}
  return {...step,parameters:result.data};
});
export const previewTestSchema = z.object({
  projectId: z.string().min(1), page: z.string().optional(), target: z.enum(['_blank', '_current']).default('_blank'),
  steps: z.array(previewStep).max(40).default([]), reload: z.boolean().default(true), capture: z.boolean().default(true),
  failOnError: z.boolean().default(true).describe('Fail when the current runtime emits an error log'),
  record: z.boolean().default(false).describe('Record the actual simulator canvas while replaying these steps; return the finalized local video in result.video'),
  recordFps: z.union([z.literal(24),z.literal(30),z.literal(60)]).default(24),
  waitMs: z.number().int().min(0).max(55000).default(45000).describe('Wait for the job in this call; if still running, use aiui_job_wait with its id'),
}).strict();
export const buildSchema = z.object({ projectId: z.string().min(1), waitMs: z.number().int().min(0).max(55000).default(45000) }).strict();
export const jobWaitSchema = z.object({ jobId: z.string().min(1), waitMs: z.number().int().min(0).max(55000).default(45000) }).strict();
export const recordingSchema = z.object({source:z.enum(['simulator','glasses']),sessionId:z.string().optional(),projectId:z.string().optional(),serial:z.string().optional(),durationSeconds:z.number().int().min(1).max(120).default(30),fps:z.union([z.literal(15),z.literal(24),z.literal(30),z.literal(60)]).default(24),rotation:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]).optional()}).strict();
export const clipSchema = recordingSchema.extend({durationSeconds:z.number().int().min(1).max(30).default(10),waitMs:z.number().int().min(0).max(55000).default(45000)});
