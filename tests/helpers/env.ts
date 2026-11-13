/** Loads .env.test and gives a strict way to read required variables. */
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: true })

export function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing ${name} in .env.test`)
  return v
}