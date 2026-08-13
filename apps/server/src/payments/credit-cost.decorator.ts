import { SetMetadata } from '@nestjs/common'
import type { Request } from 'express'

export const CREDIT_COST_KEY = 'creditCost'

export type CreditCostResolver = number | ((req: Request) => number)

/**
 * Annotate a route handler with its credit cost or a resolver function.
 * CreditGuard reads this via Reflector to know how many credits to deduct.
 *
 * Usage:
 *   @CreditCost(5)
 *   @CreditCost((req) => req.body?.type === 'PR' ? 10 : 5)
 */
export const CreditCost = (cost: CreditCostResolver) => SetMetadata(CREDIT_COST_KEY, cost)
