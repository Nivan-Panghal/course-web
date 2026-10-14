// src/components/workshop-page/WorkshopReviews.tsx
// "Reviews from attendees" on the public workshop page. Server component, plain text only.
import { Star } from 'lucide-react'
import type { LandingThemeColors } from '@/lib/landing-themes/types'
import type { PublicReviews } from '@/lib/workshop-public-reviews'

type C = LandingThemeColors

const cardStyle = (c: C) => ({ background: c.cardBg, border: `1px solid ${c.borderSoft}`, borderRadius: '1rem' })

function Stars({ c, value }: { c: C; value: number }) {
  return (
    <div className="flex gap-0.5" role="img" aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} className="w-4 h-4" style={{ color: c.accentText }} fill={s <= Math.round(value) ? 'currentColor' : 'none'} />
      ))}
    </div>
  )
}

export default function WorkshopReviews({ c, reviews, hostName }: { c: C; reviews: PublicReviews; hostName: string }) {
  return (
    <section className="mb-12 md:mb-14" aria-labelledby="ws-reviews-heading">
      <h2 id="ws-reviews-heading" className="ws-heading text-2xl md:text-3xl font-bold mb-3" style={{ color: c.textPrimary }}>Reviews from attendees</h2>
      <div className="flex items-center gap-3 mb-5">
        <span className="ws-heading text-3xl font-bold" style={{ color: c.textPrimary }}>{reviews.average.toFixed(1)}</span>
        <div>
          <Stars c={c} value={reviews.average} />
          <p className="ws-small" style={{ color: 'var(--ws-muted)' }}>{reviews.count} review{reviews.count === 1 ? '' : 's'}</p>
        </div>
      </div>
      {reviews.items.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {reviews.items.map((r, i) => (
            <figure key={i} className="p-5 flex flex-col gap-3" style={cardStyle(c)}>
              <Stars c={c} value={r.rating} />
              <blockquote className="ws-body whitespace-pre-line break-words" style={{ color: 'var(--ws-secondary)' }}>{r.comment}</blockquote>
              <figcaption className="ws-small font-semibold mt-auto" style={{ color: c.textPrimary }}>{r.name}</figcaption>
              {r.reply && (
                <div className="p-3 rounded-xl" style={{ background: c.accentSoft, border: `1px solid ${c.accentBorder}` }}>
                  <p className="ws-small font-semibold mb-1" style={{ color: c.accentText }}>Reply from {hostName}</p>
                  <p className="ws-small whitespace-pre-line break-words" style={{ color: 'var(--ws-secondary)' }}>{r.reply}</p>
                </div>
              )}
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}