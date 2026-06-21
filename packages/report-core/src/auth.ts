import { timingSafeEqual } from 'node:crypto';

// Constant-time comparison of two bearer tokens. Returns false (without leaking timing) when the
// lengths differ, and otherwise compares the full buffers so an attacker cannot recover the token
// byte by byte from response timing.
export const safeTokenEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};
