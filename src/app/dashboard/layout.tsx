'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { supabase, getSessionOrRefresh } from '@/lib/supabase'
import { resolveAccountType } from '@/lib/account'
import { ensureCreatorProfile, createCreatorProfile } from '@/lib/creator'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import CreatorAdminChatWidget from '@/components/CreatorAdminChatWidget'
import ImpersonationBanner from '@/components/ImpersonationBanner'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [loading, setLoading] = useState(true)
  const [creator, setCreator] = useState<any>(null)

  useEffect(() => {
    async function init() {
            const { session } = await getSessionOrRefresh()
      if (!session) {
        router.push('/login')
        return
      }

      const accountType = await resolveAccountType(session.user)

      if (accountType === 'student') {
        router.push('/my-courses')
        return
      }

      // accountType is 'creator' or 'unknown' at this point — resolveAccountType
      // already rules out students above via role metadata, course ownership,
      // enrollment records, phone, and email-as-phone checks, so 'unknown'
      // here specifically means "no trace of this user anywhere" rather than
      // "this is a student". Since /dashboard is an exclusively creator-facing
      // route no legitimate student flow ever sends someone to, that's a
      // brand-new signup — most commonly a first-time "Continue with Google"
      // creator, since Google OAuth never carries a role in user_metadata the
      // way email/password signup does. Provisioning them here, rather than
      // bouncing back to login, is what actually lets a new Google-based
      // creator ever reach their dashboard at all.
      let c = await ensureCreatorProfile()
      if (!c) {
        c = await createCreatorProfile()
      }

      if (!c) {
        router.push('/login?role=creator')
        return
      }

      setCreator(c)
      setLoading(false)
    }
    init()
  }, [router])

  if (loading) {
    return (
      <>
        <ImpersonationBanner />
        <div className="min-h-screen bg-black flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <div className="w-10 h-10 violet-gradient rounded-xl animate-pulse-glow" />
            <p className="text-xs" style={{ color: '#a1a1aa' }}>Loading...</p>
          </div>
        </div>
      </>
    )
  }

    return (
    <>
      <ImpersonationBanner />
      <div>
        {children}
      </div>
      
      {creator && !pathname?.startsWith('/dashboard/admin') && (
        <CreatorAdminChatWidget creatorId={creator.id} />
      )}
    </>
  )
}