'use client'
import { useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import AudienceSwitch, { useAudienceMode } from '@/components/AudienceSwitch'
import WorkshopBroadcastView from '@/components/workshop-views/WorkshopBroadcastView'
import { supabase } from '@/lib/supabase'
import LessonMessagesWidget from '@/components/LessonMessagesWidget'
import { ChevronDown, MessageSquareText, BookOpen } from 'lucide-react'

interface Course {
  id: string
  name: string
}

export default function BroadcastPage() {
  const [audience, setAudience] = useAudienceMode()
  const [courses, setCourses] = useState<Course[]>([])
  const [selectedCourse, setSelectedCourse] = useState<string>('')
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  useEffect(() => {
    async function init() {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { setLoading(false); return }
      setToken(session.access_token)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { setLoading(false); return }

      const { data } = await supabase
        .from('courses')
        .select('id, name')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false })

      setCourses(data || [])
      setLoading(false)
    }
    init()
  }, [])

  const selectedCourseName = courses.find(c => c.id === selectedCourse)?.name

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">
        <AudienceSwitch value={audience} onChange={setAudience} />
        {audience === 'workshops' ? (
          <WorkshopBroadcastView />
        ) : (
          <>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Lesson Messages</h1>
          <p className="text-sm" style={{ color: 'var(--kurso-hint)' }}>
            Set per-lesson notes and availability messages — shown to students on Telegram, WhatsApp, and the course page.
          </p>
        </div>

        {/* Course selector — mandatory, Kurso-built dropdown, no native <select> */}
        <div className="rounded-2xl p-5 mb-6" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <label className="block text-sm font-medium text-white mb-3">Select a course</label>
          <div className="relative max-w-md">
            <button
              type="button"
              onClick={() => setDropdownOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl text-sm text-left transition-all"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: selectedCourseName ? '#fff' : 'var(--kurso-hint)' }}
            >
              <span className="truncate">
                {loading ? 'Loading courses…' : (selectedCourseName || (courses.length ? 'Choose a course' : 'No courses yet'))}
              </span>
              <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
            </button>

            {dropdownOpen && courses.length > 0 && (
              <div
                className="absolute z-20 mt-1.5 w-full rounded-xl overflow-hidden max-h-64 overflow-y-auto"
                style={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
              >
                {courses.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setSelectedCourse(c.id); setDropdownOpen(false) }}
                    className="w-full px-4 py-3 text-sm text-left transition-colors"
                    style={{
                      color: '#fff',
                      background: selectedCourse === c.id ? 'rgba(var(--kurso-primary-rgb), 0.12)' : 'transparent',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = selectedCourse === c.id ? 'rgba(var(--kurso-primary-rgb), 0.12)' : 'transparent' }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Widget — only once a course is actually chosen */}
        {!selectedCourse ? (
          <div className="rounded-2xl p-12 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
              {courses.length === 0
                ? <BookOpen className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
                : <MessageSquareText className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
              }
            </div>
            <p className="text-sm text-white font-medium mb-1">
              {courses.length === 0 ? 'No courses yet' : 'Select a course above'}
            </p>
            <p className="text-xs" style={{ color: 'var(--kurso-hint)' }}>
              {courses.length === 0
                ? 'Create a course first, then come back here to manage its lesson messages.'
                : 'Choose a course to manage its lesson notes and availability messages.'}
            </p>
          </div>
        ) : (
          <LessonMessagesWidget courseId={selectedCourse} token={token} />
        )}
          </>
        )}

      </main>
    </div>
  )
}