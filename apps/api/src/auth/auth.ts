import { Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import argon2 from 'argon2';
import type { PrismaClient } from '@pricepulse/db';
import { API_CONFIG } from '../config.js';
import type { ApiConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';

export const SESSION_COOKIE = 'pp_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export const IS_PUBLIC = 'isPublic';
/** Marks a route as reachable without a session (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  /** Brute-force lockout state (WP-2.1 rule 3), keyed by email. */
  private readonly attempts = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Minutes remaining if the account is locked out, else null. */
  lockedFor(email: string): number | null {
    const state = this.attempts.get(email);
    if (!state || state.lockedUntil <= Date.now()) return null;
    return Math.ceil((state.lockedUntil - Date.now()) / 60_000);
  }

  private recordFailure(email: string): void {
    const state = this.attempts.get(email) ?? { count: 0, lockedUntil: 0 };
    state.count += 1;
    if (state.count >= LOCKOUT_THRESHOLD) {
      state.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60_000;
      state.count = 0;
    }
    this.attempts.set(email, state);
  }

  /** Deliberately does not disclose which factor was wrong (WP-2.1 rule 1). */
  async login(email: string, password: string): Promise<{ token: string; userId: string } | null> {
    const user = await (this.prisma as PrismaClient).user.findUnique({ where: { email } });
    const valid = user
      ? await argon2.verify(user.passwordHash, password).catch(() => false)
      : false;
    if (!user || !valid) {
      this.recordFailure(email);
      return null;
    }
    this.attempts.delete(email);
    const token = await new SignJWT({ sub: user.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
      .sign(new TextEncoder().encode(this.config.JWT_SECRET));
    return { token, userId: user.id };
  }

  /** WP-2.1 rule 5: change requires the current password. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await (this.prisma as PrismaClient).user.findUnique({ where: { id: userId } });
    if (!user) return false;
    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) return false;
    await (this.prisma as PrismaClient).user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }) },
    });
    return true;
  }

  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.config.JWT_SECRET));
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }

  setSessionCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure(),
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}

/**
 * Whether the session cookie carries the Secure flag. Defaults to on in
 * production (HTTPS), but can be forced off with COOKIE_SECURE=false for a
 * plain-HTTP demo on a bare IP (no domain/TLS) so login still works.
 */
function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE !== undefined) return process.env.COOKIE_SECURE === 'true';
  return process.env.NODE_ENV === 'production';
}

/** Global guard: every route requires a session unless marked @Public (FR-6.4). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { userId?: string }>();
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Sign in required');
    const userId = await this.auth.verify(token);
    if (!userId) throw new UnauthorizedException('Session expired');
    request.userId = userId;
    return true;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}
