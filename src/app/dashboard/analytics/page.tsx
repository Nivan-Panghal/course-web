'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopAnalyticsView from '@/components/workshop-views/WorkshopAnalyticsView'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { BarChart3, BookOpen, Users, TrendingUp } from 'lucide-react'

interface Course {
  id: string
  name: string
  description: string
  is_published: boolean
}

export default function AnalyticsIndexPage() {
  const [audience, setAudience] = useAudienceMode()
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data } = await supabase
        .from('courses')
        .select('id, name, description, is_published')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false })
      setCourses(data || [])
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">
        <AudienceSwitch value={audience} onChange={setAudience} />
        {audience === 'workshops' ? (
          <WorkshopAnalyticsView />
        ) : (
          <>
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Analytics</h1>
          <p className="text-sm" style={{ color: 'var(--kurso-hint)' }}>
            Select a course to view student drop-off and engagement data.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
          </div>
        ) : courses.length === 0 ? (
          <div className="rounded-2xl p-16 text-center glass"
            style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <BarChart3 className="w-10 h-10 mx-auto mb-3" style={{ color: 'var(--kurso-primary-light)' }} />
            <p className="text-sm font-medium text-white mb-1">No courses yet</p>
            <p className="text-[13px]" style={{ color: 'var(--kurso-hint)' }}>
              Create a course first to see analytics.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {courses.map(course => (
              <Link key={course.id} href={`/dashboard/analytics/${course.id}`}
                className="rounded-2xl p-5 glass flex items-center gap-4 group transition-all"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(var(--kurso-primary-rgb), 0.3)')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)')}
              >
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                  <BarChart3 className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-semibold text-white truncate">{course.name}</p>
                    {course.is_published && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'rgba(74,222,128,0.1)', color: '#4ade80' }}>
                        Live
                      </span>
                    )}
                  </div>
                  <p className="text-[13px] truncate" style={{ color: 'var(--kurso-hint)' }}>{course.description}</p>
                </div>
                <span className="text-xs flex-shrink-0 group-hover:text-violet-400 transition-colors"
                  style={{ color: 'var(--kurso-hint)' }}>View →</span>
              </Link>
            ))}
          </div>
        )}
          </>
        )}
      </main>
    </div>
  )
}