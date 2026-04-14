// Tiny HMAC-signed session cookie. Just holds the User.id.
// We avoid a full auth library for Phase 1 to keep deps minimal.

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";
import type { User } from "@prisma/client";

const COOKIE = "spw_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET is missing or too short");
  }
  return s;
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function createSessionCookie(userId: string): {
  name: string;
  value: string;
  maxAge: number;
} {
  const sig = sign(userId);
  return {
    name: COOKIE,
    value: `${userId}.${sig}`,
    maxAge: MAX_AGE_SECONDS,
  };
}

export function readSessionUserId(): string | null {
  const raw = cookies().get(COOKIE)?.value;
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx < 0) return null;
  const userId = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = sign(userId);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return userId;
}

export async function getCurrentUser(): Promise<User | null> {
  const id = readSessionUserId();
  if (!id) return null;
  return prisma.user.findUnique({ where: { id } });
}

export const SESSION_COOKIE_NAME = COOKIE;
