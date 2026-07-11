import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthService, Public } from './auth.js';
import { parseBody } from '../validation.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12, 'Use at least 12 characters'),
});

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const { email, password } = parseBody(loginSchema, body);
    const locked = this.auth.lockedFor(email);
    if (locked !== null) {
      throw new UnauthorizedException(
        `Too many failed attempts — try again in ${locked} minute${locked === 1 ? '' : 's'}`,
      );
    }
    const session = await this.auth.login(email, password);
    if (!session) throw new UnauthorizedException('Invalid email or password');
    this.auth.setSessionCookie(res, session.token);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    this.auth.clearSessionCookie(res);
    return { ok: true };
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: unknown, @Req() req: Request & { userId?: string }) {
    const { currentPassword, newPassword } = parseBody(changePasswordSchema, body);
    const ok = await this.auth.changePassword(req.userId!, currentPassword, newPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    return { ok: true };
  }

  /** Who am I — the SPA uses this to know whether a session exists. */
  @Get('me')
  me(@Req() req: Request & { userId?: string }) {
    return { userId: req.userId };
  }
}
