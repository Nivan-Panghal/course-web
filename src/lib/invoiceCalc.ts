// src/lib/invoiceCalc.ts
//
// The money maths for one creator's monthly COURSE and WORKSHOP invoice.
// Pure functions (no database), so the rules are easy to read and test.
//
// Rules
//   collected  = what students actually paid in the month (after coupons)
//                minus refunds sent in the month.
//   commission = the commission recorded on each sale, reduced in proportion
//                when a sale is refunded. A refunded sale does not keep its commission.
//   A month where refunds are larger than sales never goes below zero.

export type SaleRow = { net_amount: number; platform_fee: number }
export type RefundedSale = { refund_amount: number; sale_net_amount: number; sale_platform_fee: number }

const round2 = (n: number) => Math.round(n * 100) / 100

export function computeCourseWorkshopMonth(sales: SaleRow[], refunds: RefundedSale[]) {
  const salesTotal = sales.reduce((s, r) => s + (Number(r.net_amount) || 0), 0)
  const commissionOnSales = sales.reduce((s, r) => s + (Number(r.platform_fee) || 0), 0)

  let refundedTotal = 0
  let commissionCredit = 0
  for (const r of refunds) {
    const amount = Number(r.refund_amount) || 0
    const net = Number(r.sale_net_amount) || 0
    if (amount <= 0) continue
    refundedTotal += amount
    if (net > 0) commissionCredit += (Number(r.sale_platform_fee) || 0) * Math.min(1, amount / net)
  }

  return {
    salesTotal: round2(salesTotal),
    refundedTotal: round2(refundedTotal),
    collected: round2(Math.max(0, salesTotal - refundedTotal)),
    commissionOnSales: round2(commissionOnSales),
    commissionCredit: round2(commissionCredit),
    commission: round2(Math.max(0, commissionOnSales - commissionCredit)),
  }
}