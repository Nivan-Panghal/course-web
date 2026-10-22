'use client'
/**
 * src/components/ChannelSwitches.tsx
 * The "How students hear from you" switches, shared by courses and workshops.
 *
 *   WhatsApp  on/off   (Meta charges per message; billed on the monthly invoice at Meta's rate)
 *   Telegram  on/off   (free)
 *   Email     always on (free) and cannot be turned off
 *
 * For courses at least one of WhatsApp / Telegram must stay on, because lessons are
 * delivered through one of them. A workshop can switch both off: email still reaches everyone.
 */
import { useState } from 'react'
import { Check, Mail, MessageCircle, Send } from 'lucide-react'
import { ToggleSwitch } from '@/components/WorkshopDesignFields'

const META_PRICING_URL = 'https://developers.facebook.com/docs/whatsapp/pricing'

type Props = {
  whatsapp: boolean
  telegram: boolean
  onChange: (next: { whatsapp: boolean; telegram: boolean }) => void
  kind: 'course' | 'workshop'
  disabled?: boolean
}

const hint = { color: 'var(--kurso-hint)' } as const
const body = { color: 'var(--kurso-text-secondary)' } as const
const row = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' } as const

export default function ChannelSwitches({ whatsapp, telegram, onChange, kind, disabled }: Props) {
  const [notice, setNotice] = useState('')

  function flip(channel: 'whatsapp' | 'telegram', next: boolean) {
    if (disabled) return
    const updated = { whatsapp, telegram, [channel]: next }
    if (kind === 'course' && !updated.whatsapp && !updated.telegram) {
      setNotice('Keep at least one of WhatsApp or Telegram on, so students can get their lessons.')
      return
    }
    setNotice('')
    onChange(updated)
  }

  return (
    <div className="flex flex-col gap-3" style={disabled ? { opacity: 0.6, pointerEvents: 'none' } : undefined} aria-busy={disabled || undefined}>
      <div className="flex items-start justify-between gap-4 p-4 rounded-xl" style={row}>
        <div className="flex gap-3 min-w-0">
          <MessageCircle className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">WhatsApp</p>
            <p className="text-[14px] mt-0.5" style={body}>
              {kind === 'course' ? 'Lessons, reminders and updates on WhatsApp.' : 'Confirmation and reminders on WhatsApp.'}
            </p>
            <p className="text-[13px] mt-1.5" style={hint}>
              Meta charges for each WhatsApp message. It is added to your monthly invoice at Meta&apos;s rate, with no markup.{' '}
              <a href="/upgrade" className="underline" style={body}>See your rates</a>
              {' · '}
              <a href={META_PRICING_URL} target="_blank" rel="noopener noreferrer" className="underline" style={body}>Meta&apos;s price list</a>
            </p>
          </div>
        </div>
        <ToggleSwitch checked={whatsapp} label="WhatsApp" onChange={v => flip('whatsapp', v)} />
      </div>

      <div className="flex items-start justify-between gap-4 p-4 rounded-xl" style={row}>
        <div className="flex gap-3 min-w-0">
          <Send className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Telegram <span className="text-[13px] font-medium ml-1" style={{ color: 'var(--kurso-success)' }}>Free</span></p>
            <p className="text-[14px] mt-0.5" style={body}>Students who connect Telegram get the same messages there.</p>
          </div>
        </div>
        <ToggleSwitch checked={telegram} label="Telegram" onChange={v => flip('telegram', v)} />
      </div>

      <div className="flex items-start justify-between gap-4 p-4 rounded-xl" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.25)' }}>
        <div className="flex gap-3 min-w-0">
          <Mail className="w-5 h-5 mt-0.5 shrink-0" style={{ color: 'var(--kurso-primary-lightest)' }} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">Email <span className="text-[13px] font-medium ml-1" style={{ color: 'var(--kurso-success)' }}>Free</span></p>
            <p className="text-[14px] mt-0.5" style={body}>
              Always on. Students always get their {kind === 'course' ? 'welcome and updates' : 'confirmation and reminders'} by email, even if WhatsApp and Telegram are off.
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold px-2.5 py-1 rounded-full shrink-0" style={{ background: 'rgba(74,222,128,0.12)', color: 'var(--kurso-success)' }}>
          <Check className="w-3.5 h-3.5" /> Always on
        </span>
      </div>

      {notice && <p role="alert" className="text-[14px]" style={{ color: 'var(--kurso-danger)' }}>{notice}</p>}
    </div>
  )
}