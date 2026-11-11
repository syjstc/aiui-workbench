export const POSE_AXES = [
  ['yaw', '左右转头', -180, 180],
  ['pitch', '抬头 / 低头', -89, 89],
  ['roll', '左右侧倾', -180, 180],
];
export const NEUTRAL_POSE = Object.freeze({ yaw: 0, pitch: 0, roll: 0 });
export const DEFAULT_MOUSE = Object.freeze({ enabled: true, sensitivity: 0.25 });
export const DEFAULT_MOTION = Object.freeze({ enabled: false, pattern: 'yaw', amplitude: 20, periodMs: 5000 });

export function motionPose(origin, motion, elapsedMs) {
  const phase = elapsedMs / motion.periodMs * Math.PI * 2;
  const offset = Math.sin(phase) * motion.amplitude;
  return updatePose(origin, motion.pattern === 'orbit'
    ? { yaw: origin.yaw + offset, pitch: origin.pitch + Math.sin(phase * 2) * motion.amplitude * 0.5 }
    : { [motion.pattern]: origin[motion.pattern] + offset });
}

export function updatePose(pose, values) {
  const next = { ...pose };
  for (const [axis, , min, max] of POSE_AXES) {
    if (values[axis] === undefined) continue;
    if (!Number.isFinite(values[axis])) throw new Error('姿态必须是有限数字');
    next[axis] = Math.round(Math.max(min, Math.min(max, values[axis])) * 100) / 100;
  }
  return next;
}

export function dragPose(pose, dx, dy, sensitivity, rollOnly) {
  return updatePose(pose, rollOnly
    ? { roll: pose.roll + dx * sensitivity }
    : { yaw: pose.yaw + dx * sensitivity, pitch: pose.pitch - dy * sensitivity });
}

const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];

// Android +Z gravity at neutral, quaternion order [x, y, z, w].
export function poseQuaternion(pose) {
  const r = Math.PI / 360, yaw = pose.yaw * r, pitch = pose.pitch * r, roll = pose.roll * r;
  return mul(mul([0, 0, Math.sin(-yaw), Math.cos(yaw)], [Math.SQRT1_2, 0, 0, Math.SQRT1_2]),
    mul([Math.sin(pitch), 0, 0, Math.cos(pitch)], [0, 0, Math.sin(roll), Math.cos(roll)]));
}
