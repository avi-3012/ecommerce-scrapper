import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { getUserWithSettings } from '@pricepulse/core';
import { PrismaService } from './prisma.service.js';
import { parseBody } from './validation.js';

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a #RRGGBB hex value')
  .nullable()
  .optional();

const createSchema = z.object({ name: z.string().trim().min(1).max(50), color });
const updateSchema = z.object({ name: z.string().trim().min(1).max(50).optional(), color });

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * User-defined product categories (CRUD). Categories are never scraped — they
 * are organisational labels the user manages and assigns to products. Scoped to
 * the single Phase-1 user; deleting a category leaves its products intact with
 * their category cleared (FK ON DELETE SET NULL).
 */
@Controller('categories')
export class CategoriesController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const { user } = await getUserWithSettings(this.prisma);
    const categories = await this.prisma.category.findMany({
      where: { userId: user.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: true } } },
    });
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      productCount: c._count.products,
    }));
  }

  @Post()
  async create(@Body() body: unknown) {
    const { name, color: hex } = parseBody(createSchema, body);
    const { user } = await getUserWithSettings(this.prisma);
    try {
      const c = await this.prisma.category.create({
        data: { userId: user.id, name, color: hex ?? null },
      });
      return { id: c.id, name: c.name, color: c.color, productCount: 0 };
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({ message: `A category named “${name}” already exists` });
      throw err;
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown) {
    const changes = parseBody(updateSchema, body);
    const { user } = await getUserWithSettings(this.prisma);
    await this.ensureOwned(id, user.id);
    try {
      const c = await this.prisma.category.update({
        where: { id },
        data: {
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...('color' in changes ? { color: changes.color ?? null } : {}),
        },
      });
      return { id: c.id, name: c.name, color: c.color };
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ConflictException({ message: 'A category with that name already exists' });
      throw err;
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const { user } = await getUserWithSettings(this.prisma);
    await this.ensureOwned(id, user.id);
    // Products keep existing; their category_id is set NULL by the FK.
    await this.prisma.category.delete({ where: { id } });
    return { deleted: true };
  }

  private async ensureOwned(id: string, userId: string): Promise<void> {
    const owned = await this.prisma.category.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException();
  }
}
