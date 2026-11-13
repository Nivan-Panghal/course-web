/**
 * UNIT: phone normalisation (src/lib/phone.ts). Phones are a lookup key for enrollments
 * and bot identity, so format drift = duplicate enrollments or "not found" errors.
 * The WhatsApp bot must produce the identical form.
 */
import { test, expect } from '@playwright/test'
import { normalizePhone } from '../../src/lib/phone'

test.describe('Indian numbers always land on the bare 10 digits', () => {
  const same = ['9000000001', '+91 90000 00001', '919000000001', '09000000001', '0919000000001', '90000-00001', '(90000) 00001', '90000 00001']
  for (const raw of same) {
    test(`"${raw}" -> 9000000001`, () => expect(normalizePhone(raw)).toBe('9000000001'))
  }
})

test('non-Indian numbers keep their country code, digits only', () => {
  expect(normalizePhone('+1 415 555 2671')).toBe('14155552671')
})

test('a 10-digit number that merely starts with 91 is NOT stripped', () => {
  expect(normalizePhone('9112345678')).toBe('9112345678')
})

test('empty or non-numeric input returns null', () => {
  for (const bad of [null, undefined, '', '   ', 'abc', '---']) expect(normalizePhone(bad as any)).toBeNull()
})

test('is idempotent: normalising twice changes nothing', () => {
  for (const raw of ['+91 90000 00001', '09000000001', '+1 415 555 2671']) {
    const once = normalizePhone(raw)
    expect(normalizePhone(once)).toBe(once)
  }
})