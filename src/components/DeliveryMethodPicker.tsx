'use client'
/**
 * src/components/DeliveryMethodPicker.tsx
 * ─────────────────────────────────────────────────────────────────
 * Which channels a COURSE uses to reach its students, shared by create-course
 * and the course settings.
 *
 * Everyone is on Pay As You Earn, so nothing is locked behind a plan. The three
 * stored values stay exactly as before ('telegram' | 'whatsapp' | 'both'), so no
 * other code or data changes. The UI is simply two switches:
 *
 *   WhatsApp on, Telegram on   -> 'both'
 *   WhatsApp on only           -> 'whatsapp'
 *   Telegram on only           -> 'telegram'
 *
 * Email is always on and free (see ChannelSwitches).
 * `currentPlanId` and `onUpgraded` are still accepted so existing callers compile,
 * but they are no longer used.
 * ─────────────────────────────────────────────────────────────────
 */
import ChannelSwitches from '@/components/ChannelSwitches'
import type { SubscriptionPlanId } from '@/app/api/razorpay/subscription-plans'

type Props = {
  value: SubscriptionPlanId
  onChange: (next: SubscriptionPlanId) => void | Promise<void>
  disabled?: boolean
  currentPlanId?: unknown
  onUpgraded?: (newPlanId: SubscriptionPlanId) => void
}

export default function DeliveryMethodPicker({ value, onChange, disabled }: Props) {
  const current = value || 'both'
  const whatsapp = current === 'whatsapp' || current === 'both'
  const telegram = current === 'telegram' || current === 'both'

  return (
    <ChannelSwitches
      kind="course"
      disabled={disabled}
      whatsapp={whatsapp}
      telegram={telegram}
      onChange={next => {
        const method: SubscriptionPlanId = next.whatsapp && next.telegram ? 'both' : next.whatsapp ? 'whatsapp' : 'telegram'
        void onChange(method)
      }}
    />
  )
}