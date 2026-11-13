/** UNIT: the money maths of a creator's monthly invoice (src/lib/invoiceCalc.ts). Pure logic. */
import { test, expect } from '@playwright/test'
import { computeCourseWorkshopMonth } from '../../src/lib/invoiceCalc'

const sale = (net: number, fee: number) => ({ net_amount: net, platform_fee: fee })

test('no sales and no refunds -> everything zero', () => {
  expect(computeCourseWorkshopMonth([], [])).toEqual({
    salesTotal: 0, refundedTotal: 0, collected: 0, commissionOnSales: 0, commissionCredit: 0, commission: 0,
  })
})

test('commission is the sum of the commission recorded on each sale', () => {
  const r = computeCourseWorkshopMonth([sale(499, 25), sale(499, 25)], [])
  expect(r).toMatchObject({ salesTotal: 998, collected: 998, commissionOnSales: 50, commission: 50 })
})

test('a fully refunded sale does not keep its commission', () => {
  const r = computeCourseWorkshopMonth([sale(499, 25), sale(499, 25)], [{ refund_amount: 499, sale_net_amount: 499, sale_platform_fee: 25 }])
  expect(r).toMatchObject({ refundedTotal: 499, collected: 499, commissionCredit: 25, commission: 25 })
})

test('a partial refund returns commission in proportion', () => {
  const r = computeCourseWorkshopMonth([sale(500, 25)], [{ refund_amount: 250, sale_net_amount: 500, sale_platform_fee: 25 }])
  expect(r.commissionCredit).toBe(12.5)
  expect(r.commission).toBe(12.5)
})

test('a refund larger than the sale never returns more than the commission paid', () => {
  const r = computeCourseWorkshopMonth([], [{ refund_amount: 600, sale_net_amount: 500, sale_platform_fee: 25 }])
  expect(r.commissionCredit).toBe(25)
})

test('a month where refunds exceed sales never goes below zero', () => {
  const r = computeCourseWorkshopMonth([sale(100, 5)], [{ refund_amount: 300, sale_net_amount: 300, sale_platform_fee: 15 }])
  expect(r.collected).toBe(0)
  expect(r.commission).toBe(0)
})

test('zero, negative and missing values are ignored safely', () => {
  const r = computeCourseWorkshopMonth(
    [{ net_amount: null as any, platform_fee: undefined as any }, sale(100, 5)],
    [{ refund_amount: 0, sale_net_amount: 100, sale_platform_fee: 5 }, { refund_amount: -50, sale_net_amount: 100, sale_platform_fee: 5 }]
  )
  expect(r).toMatchObject({ salesTotal: 100, refundedTotal: 0, commission: 5 })
})

test('amounts are rounded to 2 decimals', () => {
  const r = computeCourseWorkshopMonth([sale(33.333, 1.6666)], [])
  expect(r.salesTotal).toBe(33.33)
  expect(r.commission).toBe(1.67)
})