'use client'
import { useEffect, useRef, useState, use } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { slugify, renumberLessons, getNextLessonOrder, renumberModules, getNextModuleOrder, applyLessonReorder } from '@/lib/utils'
import Link from 'next/link'
import LandingPageDesigner from '@/components/LandingPageDesigner'
import CountdownEndPicker from '@/components/CountdownEndPicker'
import CoInstructorsEditor, { type CoInstructor } from '@/components/CoInstructorsEditor'
import DeliveryMethodPicker from '@/components/DeliveryMethodPicker'
import { ReleaseScheduleCard, ModuleReleaseControl } from '@/components/ReleaseSchedule'
import ReleaseCalendar from '@/components/ReleaseCalendar'
import { normalizeDeliveryMode, normalizeUnlockTime, type DeliveryMode } from '@/lib/releaseSchedule'
import SocialLinksEditor from '@/components/SocialLinksEditor'
import { parseSocialLinks, getSocialLinksErrors, cleanSocialLinks, type SocialLink } from '@/lib/social-links'
import ContactDetailsEditor from '@/components/ContactDetailsEditor'
import { parseContactDetails, getContactDetailsErrors, cleanContactDetails, type ContactDetail } from '@/lib/contact-details'
import TestCourseModal from '@/components/TestCourseModal'
import SectionDivider from '@/components/SectionDivider'
import { getEffectivePlanId } from '@/lib/kurso-checkout'
import { PLAN_ORDER, planCoversDeliveryMethod, type SubscriptionPlanId } from '@/app/api/razorpay/subscription-plans'
import {
  DEFAULT_LANDING_CONFIG, normalizeLandingConfig, MAX_CUSTOM_SECTION_IMAGES,
  MAX_FINAL_CTA_WORDS, DEFAULT_FINAL_CTA_TEXT,
  MAX_ENROLL_BUTTON_WORDS, MAX_ENROLL_BUTTON_CHARS, DEFAULT_ENROLL_BUTTON_TEXT,
  type LandingConfig, type LandingSectionEntry, type LandingCustomSection,
  type LandingSectionType,
} from '@/lib/landing-config'
import { MAX_CUSTOM_SECTIONS_PER_COURSE, MAX_CUSTOM_HEADING_LENGTH, MAX_CUSTOM_BODY_LENGTH } from '@/lib/customSectionText'
import { MAX_POLICY_FILE_BYTES, POLICY_DOC_LABELS, type PolicyDocType } from '@/lib/policyDocs'
import { CERT_PALETTES, getCertLayoutPalette } from '@/lib/certPalettes'
import AiFieldAssist from '@/components/AiFieldAssist'
import { Gift, AlertTriangle as AlertTriangleIcon, FileText as FileTextIcon, Timer as TimerIcon, X as XIcon, Image as ImageIconLucide, FlaskConical } from 'lucide-react'

import {
  ArrowLeft, Plus, Video, FileText, Globe,
  Eye, EyeOff, ExternalLink, Copy, Check,
  Trash2, CheckCircle, AlertCircle,
  MessageCircle, Monitor, Share2, ChevronDown, ChevronUp, AlertTriangle,
  Calendar, Clock, Link as LinkIcon, Video as VideoIcon, Pencil, X, ChevronRight, Code2,
  Award
} from 'lucide-react'

type Testimonial =
  | { type: 'written'; name: string; text: string; rating: number; photo_url?: string }
  | { type: 'screenshot'; image_url: string }

const MAX_TESTIMONIALS = 15
const MAX_TESTIMONIAL_IMAGE_BYTES = 5 * 1024 * 1024
const TESTIMONIAL_IMAGE_TYPES = ['image/jpeg', 'image/png']

interface Course {
  id: string
  name: string
  slug: string
  description: string
  price: number
  original_price: number
  host_name: string
  about_creator: string
  delivery: string
  delivery_mode?: DeliveryMode
  delivery_unlock_time?: string
  total_lessons: number
  language: string[]
  is_published: boolean
  creator_id: string
  start_date?: string
  start_time?: string
  duration?: string
  what_you_will_learn?: string[]
  faq?: { question: string; answer: string }[]
  host_image?: string
  is_free_course?: boolean
  refund_window_days?: number
  refund_policy_text?: string
  refund_policy_storage_path?: string
  terms_storage_path?: string
  privacy_storage_path?: string
  contact_details?: ContactDetail[]
  ratings_enabled_on_landing?: boolean
  social_links?: SocialLink[]
  promo_video_heading?: string
  uses_external_landing_page?: boolean
  scheduled_deletion_at?: string
  next_lesson_date?: string
  course_end_date?: string
  student_update_message?: string
  landing_theme?: string
  brand_logo_url?: string
  use_logo_on_certificate?: boolean
  brand_name?: string
  instructor_title?: string
  cert_template?: string
  cert_palette?: string
  promo_video_url?: string
  promo_video_urls?: string[]
  target_audience?: string[]
  testimonials?: Testimonial[]
  level?: string
  category?: string
  requirements?: string[]
  co_instructors?: { name: string; title: string; image: string; bio: string }[]
}

interface Lesson {
  id: string
  course_id: string
  title: string
  content_url: string
  content_type: string
  order_num: number
  is_published: boolean
  is_free: boolean
  is_last_lesson: boolean
  qa_enabled: boolean
  duration: string
  module_id?: string | null
  summary_url?: string | null
  summary_name?: string | null
  notes_url?: string | null
  notes_name?: string | null
  quiz_questions?: QuizQuestion[] | null
  assignment_prompt?: string | null
  assignment_required?: boolean
  assignment_file_url?: string | null
  assignment_file_name?: string | null
  // Engagement & live session fields
  expected_delivery_text?: string | null
  live_scheduled_at?: string | null
  live_join_url?: string | null
  live_recording_url?: string | null
  live_duration_minutes?: number | null
  video_storage_path?: string | null
}

interface QuizQuestion {
  question: string
  options: string[]
  answerIndex: number
}

interface CourseModule {
  id: string
  course_id: string
  name: string
  order_num: number
  planned_lessons: number
  description?: string | null
  unlock_date?: string | null
  unlock_after_days?: number | null
}

// Max length of a module's optional "Details" text. Also enforced by a CHECK
// constraint on course_modules.description in the database.
const MODULE_DETAILS_MAX_WORDS = 500

function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

// Folders that hold video content — these upload to R2 instead of Supabase.
const R2_FOLDERS = ['videos', 'live-recordings', 'live-session-recordings']

async function uploadToSupabase(file: File, folder: string, courseId?: string): Promise<{ publicUrl: string; storagePath: string }> {
  if (R2_FOLDERS.includes(folder)) {
    if (!courseId) throw new Error('Missing course ID for video upload')
    return uploadVideoToR2(file, folder, courseId)
  }

  try {
    const ext = file.name.split('.').pop()
    const safeName = `${folder}/${Math.random().toString(36).substring(2)}-${Date.now()}.${ext}`

    // Upload directly using Supabase client (handles CORS properly)
    const { data, error: uploadError } = await supabase.storage
      .from('lessons')
      .upload(safeName, file, {
        cacheControl: '3600',
        upsert: false
      })

    if (uploadError) {
      // Provide specific error messages for common issues
      let errorMsg = uploadError.message

      if (errorMsg?.includes('row-level security') || errorMsg?.includes('RLS')) {
        errorMsg = 'Storage policy error: Please contact admin to enable file uploads. See STORAGE_RLS_FIX.md for fix.'
      } else if (errorMsg?.includes('unauthorized') || errorMsg?.includes('auth')) {
        errorMsg = 'Authentication error: Please log out and log back in.'
      } else if (errorMsg?.includes('not found')) {
        errorMsg = 'Storage bucket not found. Please check configuration.'
      }

      console.error('Supabase upload error:', uploadError)
      throw new Error(`Upload failed: ${errorMsg}`)
    }

    if (!data) {
      throw new Error('No data returned from upload')
    }

    // Generate public URL
    const { data: publicUrlData } = supabase.storage
      .from('lessons')
      .getPublicUrl(safeName)

    return {
      publicUrl: publicUrlData.publicUrl,
      storagePath: safeName
    }
  } catch (err: any) {
    console.error('Upload error:', err)
    throw new Error(err.message || 'Upload failed')
  }
}

async function uploadVideoToR2(file: File, folder: string, courseId: string): Promise<{ publicUrl: string; storagePath: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const authToken = session?.access_token
    if (!authToken) throw new Error('Not logged in — please log in again.')

    const signRes = await fetch('/api/upload/r2-sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ fileName: file.name, contentType: file.type, folder, courseId }),
    })

    if (!signRes.ok) {
      const body = await signRes.json().catch(() => ({}))
      throw new Error(body.error || 'Could not get an upload URL')
    }

    const { uploadUrl, key } = await signRes.json()

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })

    if (!putRes.ok) {
      throw new Error('Upload to storage failed')
    }

    // Video is private (served only through /api/video/stream) — there's no
    // real public URL to give out. `key` fills that slot so the existing
    // "must provide a URL or file" check on the caller side still passes;
    // it's never opened directly, only video_storage_path is actually used.
    return { publicUrl: key, storagePath: key }
  } catch (err: any) {
    console.error('R2 upload error:', err)
    throw new Error(err.message || 'Upload failed')
  }
}

// A labeled horizontal rule — "――――― Section Name ―――――" — used to visually
// break the long settings form into scannable groups.
function AddModuleModal({
  onClose,
  onAdd,
  courseId,
  nextOrder,
}: {
  onClose: () => void
  onAdd: () => void
  courseId: string
  nextOrder: number
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

 
  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Module name is required.')
      return
    }

    setLoading(true)
    setError('')

    const { error: insertError } = await supabase.from('course_modules').insert({
      course_id: courseId,
      name: name.trim(),
      order_num: nextOrder,
      planned_lessons: 0,
    })

    if (insertError) {
      setError(insertError.message)
      setLoading(false)
      return
    }

    onAdd()
    onClose()
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-md rounded-2xl p-6"
        style={{ background: '#111', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">Add Module</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
            X
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-white mb-2 block">Module Name *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Week 1, Foundation, Advanced SEO"
              className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
          </div>
          {error && (
            <div className="p-3 rounded-xl text-sm"
              style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
            </div>
          )}
          <div className="flex gap-3 mt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-3 rounded-xl text-sm font-medium"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 disabled:opacity-50">
              {loading ? 'Adding...' : 'Add Module'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── MODULE DETAILS EDITOR ──
// Optional "Details" text for a module, shown to students inside that module's
// expanded row on the landing page. Sits directly under the module name in the
// lessons tab: click to edit, Save writes to course_modules.description.
function ModuleDetailsEditor({
  mod,
  onSaved,
}: {
  mod: CourseModule
  onSaved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const words = countWords(value)
  const overLimit = words > MODULE_DETAILS_MAX_WORDS

  function startEditing() {
    setValue(mod.description || '')
    setError('')
    setEditing(true)
  }

  async function handleSave() {
    if (overLimit) return
    setSaving(true)
    setError('')
    const trimmed = value.trim()
    const { error: updateError } = await supabase
      .from('course_modules')
      .update({ description: trimmed || null })
      .eq('id', mod.id)
    setSaving(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setEditing(false)
    onSaved()
  }

  return (
    <div className="mb-3">
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            rows={4}
            placeholder="Optional — what students will learn in this module. Shown on your course page."
            className="w-full px-3 py-2.5 rounded-xl text-sm text-white outline-none resize-y"
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: `1px solid ${overLimit ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
            }}
          />
          <p className="text-xs" style={{ color: 'var(--kurso-hint)' }}>
            Optional — shown to students on your course page to help them decide.
          </p>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs" style={{ color: overLimit ? '#ef4444' : '#a6a6ab' }}>
              {words} / {MODULE_DETAILS_MAX_WORDS} words
            </span>
            <div className="flex gap-2">
              <button type="button" onClick={() => setEditing(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving || overLimit}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white violet-gradient hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
          {error && (
            <p className="text-xs" style={{ color: '#ef4444' }}>{error}</p>
          )}
        </div>
      ) : mod.description ? (
        <div className="flex items-start gap-3">
          <p className="text-xs flex-1 min-w-0"
            style={{
              color: '#a6a6ab',
              lineHeight: 1.6,
              whiteSpace: 'pre-line',
              overflowWrap: 'anywhere',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
            {mod.description}
          </p>
          <button type="button" onClick={startEditing}
            className="text-xs flex-shrink-0 underline"
            style={{ color: 'var(--kurso-primary-light)' }}>
            Edit details
          </button>
        </div>
      ) : (
        <button type="button" onClick={startEditing}
          className="text-xs"
          style={{ color: 'var(--kurso-primary-light)' }}>
          + Add details
        </button>
      )}
    </div>
  )
}

// ── ADD LESSON MODAL ──
function AddLessonModal({
  onClose,
  onAdd,
  courseId,
  creatorId,
  nextOrder,
  modules,
  initialModuleId = '',
  initialType = 'video',
}: {
  onClose: () => void
  onAdd: () => void
  courseId: string
  creatorId: string
  nextOrder: number
  modules: CourseModule[]
  initialModuleId?: string
  initialType?: 'video' | 'pdf' | 'live' | 'quiz' | 'assignment'
}) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [type, setType] = useState<'video' | 'pdf' | 'live' | 'quiz' | 'assignment'>(initialType)
  const [duration, setDuration] = useState('')
  const [moduleId, setModuleId] = useState(initialModuleId)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [liveScheduledAt, setLiveScheduledAt] = useState('')
  const [liveDate, setLiveDate] = useState('')
  const [liveTime, setLiveTime] = useState('')
  const [liveDurationMins, setLiveDurationMins] = useState('60')


  async function handleSubmit(e: React.SyntheticEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    let finalUrl = url
    let finalStoragePath = ''

    if (file && type !== 'live' && type !== 'quiz') {
      try {
        const folder = type === 'video' ? 'videos' : 'pdfs'
        const { publicUrl, storagePath } = await uploadToSupabase(file, folder, courseId)
        finalUrl = publicUrl
        finalStoragePath = storagePath
      } catch (err: any) {
        setError(`Upload error: ${err.message}`)
        setLoading(false)
        return
      }
    }

    if (type !== 'live' && type !== 'quiz' && type !== 'assignment' && !finalUrl) {
      setError('Please provide a URL or upload a file.')
      setLoading(false)
      return
    }

    const lessonData: any = {
      course_id: courseId,
      creator_id: creatorId,
      title,
      content_url: finalUrl || '',
      content_type: type,
      order_num: nextOrder,
      duration,
      module_id: moduleId || null,
      is_published: false,

    }

    if (type === 'live') {
      lessonData.live_join_url = url
      lessonData.live_scheduled_at = liveDate && liveTime
        ? new Date(`${liveDate}T${liveTime}`).toISOString()
        : null
      lessonData.live_duration_minutes = parseInt(liveDurationMins) || 60
    }

    if (finalStoragePath) {
      if (type === 'video') lessonData.video_storage_path = finalStoragePath
      else lessonData.pdf_storage_path = finalStoragePath
    }

    const { error: dbError } = await supabase.from('lessons').insert(lessonData)

    if (dbError) {
      setError(dbError.message)
      setLoading(false)
      return
    }

    onAdd()
    onClose()
    setLoading(false)
  }

  const typeConfig = {
    video: { icon: <Video className="w-4 h-4" />, label: 'Video' },
    pdf: { icon: <FileText className="w-4 h-4" />, label: 'PDF' },
    live: { icon: <span className="text-sm">📡</span>, label: 'Live' },
    quiz: { icon: <span className="text-sm">🧠</span>, label: 'Quiz' },
    assignment: { icon: <span className="text-sm">📝</span>, label: 'Assignment' },
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-md rounded-2xl p-6 overflow-y-auto max-h-[90vh]"
        style={{ background: '#111', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>

        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">Add Content {nextOrder}</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">

          {/* Type selector */}
          <div>
            <label className="text-sm font-medium text-white mb-2 block">Content Type</label>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {(['video', 'pdf', 'live', 'quiz', 'assignment'] as const).map(t => (
                <button key={t} type="button" onClick={() => setType(t)}
                  className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                  style={{
                    background: type === t ? 'rgba(var(--kurso-primary-rgb), 0.2)' : 'rgba(255,255,255,0.05)',
                    border: type === t ? '1px solid rgba(var(--kurso-primary-rgb), 0.5)' : '1px solid rgba(255,255,255,0.08)',
                    color: type === t ? 'var(--kurso-primary-light)' : '#a1a1aa',
                  }}>
                  {typeConfig[t].icon}
                  {typeConfig[t].label}
                </button>
              ))}
            </div>
          </div>

          {modules.length > 0 && (
            <div>
              <label className="text-sm font-medium text-white mb-2 block">Module (optional)</label>
              <select value={moduleId} onChange={e => setModuleId(e.target.value)}
                className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: '#050505', border: '1px solid rgba(255,255,255,0.1)' }}>
                <option value="" style={{ background: '#050505' }}>No module</option>
                {modules.map(m => (
                  <option key={m.id} value={m.id} style={{ background: '#050505' }}>{m.name}</option>
                ))}
              </select>
            </div>
          )}



          {/* Title */}
          <div>
            <label className="text-sm font-medium text-white mb-2 block">
              {type === 'live' ? 'Session Title *' : type === 'quiz' ? 'Quiz Title *' : 'Lesson Title *'}
            </label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} required
              placeholder={
                type === 'live' ? 'e.g. Live Q&A — Week 3' :
                  type === 'quiz' ? 'e.g. Week 1 Knowledge Check' :
                    'e.g. Introduction to Keyword Research'
              }
              className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
              onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
            />
          </div>

          {/* Live-specific fields */}
          {type === 'live' && (
            <>
              <div>
                <label className="text-sm font-medium text-white mb-2 block">Join URL *</label>
                <input type="url" value={url} onChange={e => setUrl(e.target.value)}
                  placeholder="https://zoom.us/j/... or meet.google.com/..."
                  className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                />
              </div>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <label className="text-sm font-medium text-white mb-2 block">Date</label>
                  <input type="date" value={liveDate}
                    onChange={e => setLiveDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', colorScheme: 'dark' }}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-white mb-2 block">Time</label>
                  <input type="time" value={liveTime}
                    onChange={e => setLiveTime(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', colorScheme: 'dark' }}
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium text-white mb-2 block">Duration (min)</label>
                <input type="number" value={liveDurationMins}
                  onChange={e => setLiveDurationMins(e.target.value)}
                  min="15" max="480"
                  className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                />
              </div>
            </>
          )}

          {/* Video/PDF source */}
          {(type === 'video' || type === 'pdf') && (
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                {type === 'video' ? 'Video Source *' : 'PDF Source *'}
              </label>
              <div className="flex flex-col gap-3">
                <div className="relative group">
                  <input type="file" accept={type === 'video' ? 'video/*' : 'application/pdf'}
                    onChange={e => { const f = e.target.files?.[0] || null; setFile(f); if (f) setUrl('') }}
                    className="hidden" id="file-upload" />
                  <label htmlFor="file-upload"
                    className="flex items-center justify-center gap-2 w-full py-4 rounded-xl border-2 border-dashed cursor-pointer"
                    style={{ background: file ? 'rgba(var(--kurso-primary-rgb), 0.1)' : 'rgba(255,255,255,0.03)', borderColor: file ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.1)', color: file ? '#fff' : '#a1a1aa' }}>
                    <Plus className="w-4 h-4" />
                    {file ? file.name : `Upload ${type === 'video' ? 'Video' : 'PDF'}`}
                  </label>
                  {file && (
                    <button type="button" onClick={() => setFile(null)}
                      className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs">✕</button>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex-1 h-px bg-white/5" />
                  <span className="text-[10px] uppercase tracking-widest text-zinc-600">OR</span>
                  <div className="flex-1 h-px bg-white/5" />
                </div>
                <input type="url" value={url} onChange={e => { setUrl(e.target.value); if (e.target.value) setFile(null) }}
                  placeholder={type === 'video' ? 'Paste video link' : 'Paste PDF link'}
                  disabled={!!file}
                  className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none disabled:opacity-50"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                  onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
                />
              </div>
            </div>
          )}

          {type === 'quiz' && (
            <div className="p-3 rounded-xl"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.06)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
              <p className="text-xs text-[var(--kurso-primary-light)]">
                A quiz lesson will be created. After adding, click <strong>Edit Quiz</strong> directly on the lesson card to add questions.
              </p>
            </div>
          )}

          {type === 'assignment' && (
            <div className="p-3 rounded-xl"
              style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <p className="text-xs" style={{ color: '#fbbf24' }}>
                An assignment lesson will be created. After adding, expand the lesson card to write the prompt and attach files.
              </p>
            </div>
          )}

          {/* Duration (for video/pdf/quiz) */}
          {type !== 'live' && (
            <div>
              <label className="text-sm font-medium text-white mb-2 block">Duration (optional)</label>
              <input type="text" value={duration} onChange={e => setDuration(e.target.value)}
                placeholder="e.g. 18 min"
                className="w-full px-4 py-3 rounded-xl text-sm text-white outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                onFocus={e => e.target.style.borderColor = 'var(--kurso-primary)'}
                onBlur={e => e.target.style.borderColor = 'rgba(255,255,255,0.1)'}
              />
            </div>
          )}



          {error && (
            <div className="p-3 rounded-xl text-sm"
              style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
              {error}
            </div>
          )}

          <div className="flex gap-3 mt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-3 rounded-xl text-sm font-medium"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 disabled:opacity-50">
              {loading ? 'Adding...' : `Add ${typeConfig[type].label}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}


// ── EXPECTED DELIVERY EDITOR ──
function ExpectedDeliveryEditor({ lesson, onRefresh }: { lesson: Lesson; onRefresh: () => void }) {
  const [text, setText] = useState(lesson.expected_delivery_text || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setText(lesson.expected_delivery_text || '')
  }, [lesson.expected_delivery_text])

  async function save() {
    const trimmed = text.trim()
    if (trimmed === (lesson.expected_delivery_text || '')) return
    setSaving(true)
    await supabase.from('lessons').update({ expected_delivery_text: trimmed || null }).eq('id', lesson.id)
    setSaving(false)
    onRefresh()
  }

  return (
    <div className="p-3 rounded-xl"
      style={{ background: 'rgba(234,179,8,0.05)', border: '1px solid rgba(234,179,8,0.2)' }}>
      <p className="text-xs font-semibold mb-2" style={{ color: '#eab308' }}>📅 Expected Delivery Date</p>
      <input
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={save}
        placeholder="e.g. Dropping this Friday at 6 PM IST"
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-yellow-500/50"
      />
      <p className="text-[10px] text-zinc-600 mt-1.5">
        {saving ? 'Saving…' : 'Students see this on their course page. Saved automatically on blur.'}
      </p>
    </div>
  )
}

// ── LIVE RECORDING EDITOR ──
function LiveRecordingEditor({ lesson, onRefresh }: { lesson: Lesson; onRefresh: () => void }) {
  const [url, setUrl] = useState(lesson.live_recording_url || '')
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const hasProtectedRecording = !!lesson.video_storage_path

  async function handleUpload(file: File) {
    const allowedExt = ['.mp4', '.mov', '.webm', '.m4v']
    const nameLower = file.name.toLowerCase()
    if (!allowedExt.some(ext => nameLower.endsWith(ext))) {
      setUploadError('Please upload an MP4, MOV, WEBM, or M4V file.')
      return
    }
    if (file.size > 3 * 1024 * 1024 * 1024) {
      setUploadError('File is larger than 3GB — please compress it first.')
      return
    }
    setUploading(true)
    setUploadError('')
    try {
      const { storagePath } = await uploadToSupabase(file, 'live-recordings', lesson.course_id)
      // Deliberately does NOT touch content_url (the join link stays intact)
      // and clears the old raw live_recording_url so nothing else in the
      // app can still surface an unprotected link for this lesson.
      await supabase.from('lessons').update({
        video_storage_path: storagePath,
        live_recording_url: null,
      }).eq('id', lesson.id)
      setUrl('')
      onRefresh()
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed.')
    } finally {
      setUploading(false)
    }
  }

  async function saveExternalLink() {
    const trimmed = url.trim()
    if (trimmed === (lesson.live_recording_url || '')) return
    setSaving(true)
    await supabase.from('lessons').update({ live_recording_url: trimmed || null }).eq('id', lesson.id)
    setSaving(false)
    onRefresh()
  }

  if (hasProtectedRecording) {
    return (
      <div className="p-3 rounded-xl"
        style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.18)' }}>
        <p className="text-xs font-semibold mb-1" style={{ color: '#22c55e' }}>
          🔒 Recording uploaded — watermarked & protected
        </p>
        <p className="text-[10px] text-zinc-500 mb-2">
          Students watch this through the same protected player as your regular lesson videos — per-student watermark, expiring links.
        </p>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="text-[11px] px-3 py-1.5 rounded-lg font-medium"
          style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa', border: '1px solid rgba(255,255,255,0.1)' }}>
          {uploading ? 'Uploading…' : 'Replace recording'}
        </button>
        <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
          onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
        {uploadError && <p className="text-[10px] mt-1.5" style={{ color: '#ef4444' }}>{uploadError}</p>}
      </div>
    )
  }

  return (
    <div className="p-3 rounded-xl"
      style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.18)' }}>
      <p className="text-xs font-semibold mb-2" style={{ color: '#22c55e' }}>🎬 Add Class Recording</p>

      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="w-full py-2.5 rounded-lg text-sm font-semibold text-white mb-2 disabled:opacity-50"
        style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }}>
        {uploading ? 'Uploading…' : 'Upload Recording (recommended)'}
      </button>
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden"
        onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
      {uploadError && <p className="text-[10px] mb-2" style={{ color: '#ef4444' }}>{uploadError}</p>}
      <p className="text-[10px] text-zinc-600 mb-3">
        Uploaded recordings get a per-student watermark and expiring links, same as your regular lesson videos.
      </p>

      <div className="flex items-center gap-2 mb-2">
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
        <span className="text-[10px]" style={{ color: '#52525b' }}>or</span>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
      </div>

      <input
        type="url"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onBlur={saveExternalLink}
        placeholder="Paste an external link (Drive, YouTube…)"
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-green-500/50"
      />
      <p className="text-[10px] text-zinc-600 mt-1.5">
        {saving ? 'Saving…' : '⚠️ External links are not watermarked or protected — anyone with the link can share it.'}
      </p>
    </div>
  )
}

// ── ASSIGNMENT EDITOR (inside lesson widget) ──
function AssignmentEditor({ lesson, onRefresh }: { lesson: Lesson; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState(lesson.assignment_prompt || '')
  const [required, setRequired] = useState(lesson.assignment_required || false)
  const [saving, setSaving] = useState(false)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [localFileUrl, setLocalFileUrl] = useState<string | null>(lesson.assignment_file_url || null)
  const [localFileName, setLocalFileName] = useState<string | null>(lesson.assignment_file_name || null)

  // Sync with lesson prop when it changes
  useEffect(() => {
    if (!editing) {
      setPrompt(lesson.assignment_prompt || '')
      setRequired(lesson.assignment_required || false)
      setLocalFileUrl(lesson.assignment_file_url || null)
      setLocalFileName(lesson.assignment_file_name || null)
    }
  }, [lesson, editing])

  async function handleFileUpload(file: File) {
    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      alert('File size must be less than 5MB.')
      return
    }

    // Validate file type
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp'
    ]
    const allowedExtensions = ['.pdf', '.txt', '.md', '.jpg', '.jpeg', '.png', '.gif', '.webp']
    const fileNameLower = file.name.toLowerCase()
    const isValidType = allowedTypes.includes(file.type) || allowedExtensions.some(ext => fileNameLower.endsWith(ext))
    if (!isValidType) {
      alert('Only PDF, TXT, MD, JPG, JPEG, PNG, GIF, or WEBP files are allowed.')
      return
    }

    setUploadingFile(true)
    try {
      const { publicUrl } = await uploadToSupabase(file, 'assignments')
      await supabase
        .from('lessons')
        .update({
          assignment_file_url: publicUrl,
          assignment_file_name: file.name
        })
        .eq('id', lesson.id)
      setLocalFileUrl(publicUrl)
      setLocalFileName(file.name)
      onRefresh()
    } catch (err: any) {
      alert(err.message || 'File upload failed.')
    } finally {
      setUploadingFile(false)
    }
  }

  async function deleteAssignmentFile() {
    try {
      await supabase
        .from('lessons')
        .update({
          assignment_file_url: null,
          assignment_file_name: null
        })
        .eq('id', lesson.id)
      setLocalFileUrl(null)
      setLocalFileName(null)
      onRefresh()
    } catch (err: any) {
      alert(err.message || 'Failed to delete file.')
    }
  }

  async function save() {
    setSaving(true)
    await supabase
      .from('lessons')
      .update({
        assignment_prompt: prompt.trim() || null,
        assignment_required: required,
      })
      .eq('id', lesson.id)
    setSaving(false)
    setEditing(false)
    onRefresh()
  }

  async function remove() {
    setSaving(true)
    await supabase
      .from('lessons')
      .update({
        assignment_prompt: null,
        assignment_required: false,
        assignment_file_url: null,
        assignment_file_name: null
      })
      .eq('id', lesson.id)
    setPrompt('')
    setRequired(false)
    setLocalFileUrl(null)
    setLocalFileName(null)
    setSaving(false)
    setEditing(false)
    onRefresh()
  }

  if (!editing) {
    const hasContent = lesson.assignment_prompt || lesson.assignment_file_url
    return (
      <div className="flex items-center gap-3 p-3 rounded-xl text-sm w-full"
        style={{ background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)', color: '#fff' }}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4" />
            <span className="font-medium">Assignment</span>
          </div>
          {hasContent && (
            <div className="flex flex-col gap-1 mt-1">
              {lesson.assignment_prompt && (
                <p className="text-xs opacity-80 line-clamp-2">{lesson.assignment_prompt}</p>
              )}
              {lesson.assignment_file_url && (
                <Link href={lesson.assignment_file_url} target="_blank" className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] truncate">
                  {lesson.assignment_file_name || 'View Assignment File'}
                </Link>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasContent && (
            <button
              onClick={remove}
              disabled={saving}
              className="w-8 h-8 flex items-center justify-center rounded-lg transition-all"
              style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => {
              setPrompt(lesson.assignment_prompt || '');
              setRequired(lesson.assignment_required || false);
              setLocalFileUrl(lesson.assignment_file_url || null);
              setLocalFileName(lesson.assignment_file_name || null);
              setEditing(true)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lighter)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)'
            }}>
            {hasContent ? 'Edit' : 'Add'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-3 rounded-xl flex flex-col gap-3"
      style={{ background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)' }}>
      <div className="flex items-center justify-between gap-3">
        <label className="text-xs font-medium text-white">Assignment Prompt</label>
      </div>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        rows={3}
        placeholder="e.g. Write a 300-word analysis of today's strategy. Upload as PDF or type your answer."
        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none resize-none focus:border-amber-500/50"
      />

      {/* OR separator */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-white/5" />
        <span className="text-[10px] uppercase tracking-widest text-zinc-600">OR</span>
        <div className="flex-1 h-px bg-white/5" />
      </div>

      {/* File Upload */}
      <div className="p-3 rounded-xl bg-white/[0.03] border border-white/10">
        <div className="flex items-center justify-between gap-3 mb-2">
          <label className="text-xs font-medium text-white">Assignment File</label>
          {localFileUrl && (
            <div className="flex items-center gap-2">
              <Link href={localFileUrl} target="_blank" className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] truncate max-w-[150px]">
                {localFileName}
              </Link>
              <button
                onClick={deleteAssignmentFile}
                className="w-8 h-8 flex items-center justify-center rounded-lg"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
        <input
          type="file"
          accept=".pdf,.txt,.md,.jpg,.jpeg,.png,.gif,.webp,application/pdf,text/plain,text/markdown,image/jpeg,image/png,image/gif,image/webp"
          className="hidden"
          id={`assignment-file-${lesson.id}`}
          onChange={e => {
            const file = e.target.files?.[0] || null
            if (file) {
              handleFileUpload(file)
            }
          }}
        />
        <label htmlFor={`assignment-file-${lesson.id}`}
          className="block w-full text-center px-3 py-2 rounded-lg text-xs font-medium cursor-pointer"
          style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lighter)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
          {uploadingFile ? 'Uploading...' : localFileUrl ? 'Replace File' : 'Upload File (PDF, TXT, MD, Images ≤5MB)'}
        </label>
      </div>

      {/* Toggle with description */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs" style={{ color: '#a1a1aa' }}>
          {required
            ? 'Students cannot proceed to next lesson before submitting assignment'
            : 'Students can proceed to next lesson without completing assignment'}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs" style={{ color: '#a1a1aa' }}>
            {required ? 'Required to proceed' : 'Optional'}
          </span>
          <button
            onClick={() => setRequired(v => !v)}
            className="relative w-9 h-5 rounded-full transition-all flex-shrink-0"
            style={{ background: required ? 'var(--kurso-accent)' : 'rgba(255,255,255,0.1)' }}>
            <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
              style={{ left: required ? '20px' : '2px' }} />
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={save} disabled={saving || (!prompt.trim() && !localFileUrl)}
          className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-white violet-gradient disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Assignment'}
        </button>
      </div>
    </div>
  )
}

// ── DELETE MODULE MODAL ──
function DeleteModuleModal({
  module,
  onConfirm,
  onClose,
}: {
  module: CourseModule
  onConfirm: () => void
  onClose: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-md rounded-2xl p-6"
        style={{ background: '#111', border: '1px solid rgba(239,68,68,0.3)' }}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">Delete Module</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-400">
            Delete module <strong className="text-white">"{module.name}"</strong>? Lessons inside will
            be unassigned (not deleted). This cannot be undone.
          </p>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-zinc-300">
              Type <span className="text-white font-semibold">{module.name}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="Type module name here"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-red-500/50"
            />
          </div>
          <div className="flex gap-3">
            <button onClick={onClose}
              className="flex-1 py-3 rounded-xl text-sm font-medium"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={confirmText.trim() !== module.name.trim()}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              style={{ background: '#ef4444' }}>
              Delete Module
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── DELETE LESSON MODAL ──
function DeleteLessonModal({
  lesson,
  onConfirm,
  onClose
}: {
  lesson: Lesson
  onConfirm: () => void
  onClose: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const requiresTyping = lesson.is_published

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: '#111', border: '1px solid rgba(239,68,68,0.3)' }}>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-white">Delete Lesson</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-400">
            This can&apos;t be undone. The lesson will not be restored after deletion.
          </p>

          {requiresTyping && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-zinc-300">
                This lesson is published. To confirm, type the lesson name: <span className="text-white">{lesson.title}</span>
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type lesson name here"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-red-500/50"
              />
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-xl text-sm font-medium"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={requiresTyping && confirmText.trim() !== lesson.title.trim()}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              style={{ background: '#ef4444' }}
            >
              Delete Lesson
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── MARK / UNMARK LAST LESSON MODAL ──
function MarkLastLessonModal({
  lesson,
  mode,
  onConfirm,
  onClose,
}: {
  lesson: Lesson
  mode: 'mark' | 'unmark'
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6"
        style={{ background: '#111', border: '1px solid rgba(234,179,8,0.3)' }}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Award className="w-4 h-4" style={{ color: '#eab308' }} />
            {mode === 'mark' ? 'Mark as last lesson' : 'Unmark as last lesson'}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {mode === 'mark' ? (
          <div className="rounded-xl p-4 mb-6" style={{ background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)' }}>
            <p className="text-sm leading-6 text-white mb-2">
              Are you sure <strong>&ldquo;{lesson.title}&rdquo;</strong> is the last lesson of your course?
            </p>
            <p className="text-xs leading-5" style={{ color: 'var(--kurso-hint)' }}>
              This means you won&apos;t upload any lessons after this one, and students will become eligible for the completion certificate (if you&apos;ve set one up) as soon as they finish it — regardless of your planned lesson count. You can unmark it anytime.
            </p>
          </div>
        ) : (
          <div className="rounded-xl p-4 mb-6" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <p className="text-sm leading-6 text-white">
              Unmark <strong>&ldquo;{lesson.title}&rdquo;</strong> as the last lesson? The certificate will go back to using your course&apos;s planned lesson count instead.
            </p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl text-sm font-medium"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 rounded-xl text-sm font-semibold text-black"
            style={{ background: '#eab308' }}
          >
            {mode === 'mark' ? 'Yes, mark as last lesson' : 'Yes, unmark'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddContentBeforePublishModal({
  lesson,
  onClose,
}: {
  lesson: Lesson
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}
    >
      <div
        className="w-full max-w-md rounded-2xl p-6"
        style={{
          background: '#111',
          border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)',
        }}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white">Add content first</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className="rounded-xl p-4 mb-5"
          style={{
            background: 'rgba(var(--kurso-primary-rgb), 0.08)',
            border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)',
          }}
        >
          <p className="text-sm leading-6" style={{ color: 'var(--kurso-primary-lightest)' }}>
            First add content. Click <strong className="text-white">Add</strong> on the right side of this lesson widget.
          </p>
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-xl text-sm font-semibold text-black transition-opacity hover:opacity-90"
          style={{ background: 'var(--kurso-primary)' }}
        >
          Close
        </button>
      </div>
    </div>
  )
}

// ── LESSON WIDGET ──
function LessonWidget({
  lesson,
  onDelete,
  onTogglePublish,
  onToggleFree,
  onToggleQA,
  onToggleLastLesson,
  onRefresh,
  onRenumber,
}: {
  lesson: Lesson
  onDelete: (id: string) => void
  onTogglePublish: (id: string, current: boolean) => void
  onToggleFree: (id: string, current: boolean) => void
  onToggleQA: (id: string, current: boolean) => void
  onToggleLastLesson: (id: string, current: boolean) => void
  onRefresh: () => void
  onRenumber: (lesson: Lesson, newNumber: string) => Promise<{ ok: boolean; error?: string }>
}) {
  const [expanded, setExpanded] = useState(false)
  const [operationError, setOperationError] = useState('')
  const [resourceSaving, setResourceSaving] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [showLastLessonModal, setShowLastLessonModal] = useState(false)
  const [editingNumber, setEditingNumber] = useState(false)
  const [numberInput, setNumberInput] = useState(String(lesson.order_num))
  const [numberSaving, setNumberSaving] = useState(false)
  const [numberError, setNumberError] = useState('')
  const [hoveringNumber, setHoveringNumber] = useState(false)

  async function handleSaveNumber() {
    setNumberSaving(true)
    setNumberError('')
    const result = await onRenumber(lesson, numberInput)
    setNumberSaving(false)
    if (!result.ok) {
      setNumberError(result.error || 'Could not update the lesson number.')
      return
    }
    setEditingNumber(false)
  }

  async function uploadNotes(file: File | null) {
    if (!file) return
    const lower = file.name.toLowerCase()
    const valid = lower.endsWith('.pdf') || lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.doc') || lower.endsWith('.docx')
    if (!valid) {
      setOperationError('Only PDF, text, markdown, or document files are allowed.')
      return
    }
    setOperationError('')
    setResourceSaving(true)
    try {
      const { publicUrl } = await uploadToSupabase(file, 'notes')
      const { error } = await supabase.from('lessons').update({ notes_url: publicUrl, notes_name: file.name }).eq('id', lesson.id)
      if (error) throw error
      onRefresh()
    } catch (err: any) {
      setOperationError(err.message || 'Notes upload failed.')
    } finally {
      setResourceSaving(false)
    }
  }

  async function deleteNotes() {
    setOperationError('')
    try {
      const { error } = await supabase.from('lessons').update({ notes_url: null, notes_name: null }).eq('id', lesson.id)
      if (error) throw error
      onRefresh()
    } catch (err: any) {
      setOperationError(err.message || 'Failed to delete notes.')
    }
  }

  const typeIcon = lesson.content_type === 'pdf'
    ? <FileText className="w-4 h-4" style={{ color: 'var(--kurso-accent)' }} />
    : lesson.content_type === 'live'
      ? <span style={{ fontSize: 14 }}>📡</span>
      : lesson.content_type === 'quiz'
        ? <span style={{ fontSize: 14 }}>🧠</span>
        : lesson.content_type === 'assignment'
          ? <span style={{ fontSize: 14 }}>📝</span>
          : <Video className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />

  return (
    <>
      {showDeleteModal && (
        <DeleteLessonModal
          lesson={lesson}
          onConfirm={() => onDelete(lesson.id)}
          onClose={() => setShowDeleteModal(false)}
        />
      )}
      {showLastLessonModal && (
        <MarkLastLessonModal
          lesson={lesson}
          mode={lesson.is_last_lesson ? 'unmark' : 'mark'}
          onConfirm={() => { onToggleLastLesson(lesson.id, lesson.is_last_lesson); setShowLastLessonModal(false) }}
          onClose={() => setShowLastLessonModal(false)}
        />
      )}
      <div className="rounded-2xl overflow-hidden transition-all"
        style={{
          border: lesson.is_published
            ? '1px solid rgba(74,222,128,0.2)'
            : '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(255,255,255,0.02)',
        }}>

        {/* Main row */}
        <div className="flex flex-wrap items-center gap-3 p-4">
          {editingNumber ? (
            <div className="flex items-center gap-1 flex-shrink-0">
              <input
                type="number"
                min={1}
                value={numberInput}
                onChange={e => setNumberInput(e.target.value)}
                autoFocus
                className="w-12 text-xs font-bold text-center rounded-lg outline-none py-1.5"
                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.4)', color: '#fff' }}
              />
              <button onClick={handleSaveNumber} disabled={numberSaving}
                title="Save lesson number"
                className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 disabled:opacity-50"
                style={{ background: 'rgba(74,222,128,0.15)', color: '#4ade80' }}>
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => { setEditingNumber(false); setNumberError(''); setNumberInput(String(lesson.order_num)) }}
                title="Cancel"
                className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setNumberInput(String(lesson.order_num)); setEditingNumber(true) }}
              onMouseEnter={() => setHoveringNumber(true)}
              onMouseLeave={() => setHoveringNumber(false)}
              title="Change lesson number"
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-light)' }}>
              {hoveringNumber ? 'Edit' : String(lesson.order_num).padStart(2, '0')}
            </button>
          )}

          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.05)' }}>
            {typeIcon}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{lesson.title}</p>
            <div className="flex items-center gap-3 mt-0.5">
              {lesson.duration && (
                <span className="text-xs" style={{ color: '#52525b' }}>{lesson.duration}</span>
              )}
              <span className="text-xs" style={{ color: lesson.is_published ? '#4ade80' : '#c1c1c3' }}>
                {lesson.is_published ? '● Published' : '○ Draft'}
              </span>
              {numberError && (
                <span className="text-xs" style={{ color: '#ef4444' }}>{numberError}</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 flex-shrink-0 w-full sm:w-auto justify-end sm:justify-start ml-auto sm:ml-0">
            <button
              onClick={() => onTogglePublish(lesson.id, lesson.is_published)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: lesson.is_published ? 'rgba(239,68,68,0.1)' : 'rgba(74,222,128,0.1)',
                color: lesson.is_published ? '#ef4444' : '#4ade80',
                border: lesson.is_published ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(74,222,128,0.2)',
              }}>
              {lesson.is_published
                ? <><EyeOff className="w-3 h-3" />Unpublish</>
                : <><Eye className="w-3 h-3" />Publish</>
              }
            </button>

            <button
              onClick={() => onToggleFree(lesson.id, lesson.is_free)}
              title={lesson.is_free ? 'Make this lesson paid' : 'Make this lesson free to preview'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: lesson.is_free ? 'rgba(56,189,248,0.1)' : 'rgba(255,255,255,0.05)',
                color: lesson.is_free ? '#38bdf8' : '#8f8f91',
                border: lesson.is_free ? '1px solid rgba(56,189,248,0.2)' : '1px solid rgba(255,255,255,0.08)',
              }}>
              <Gift className="w-3 h-3" />
              {lesson.is_free ? 'Free' : 'Paid'}
            </button>

            <button
              onClick={() => onToggleQA(lesson.id, lesson.qa_enabled)}
              title={lesson.qa_enabled ? 'Close Q&A for this lesson' : 'Open Q&A for this lesson'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: lesson.qa_enabled ? 'rgba(167,139,250,0.1)' : 'rgba(255,255,255,0.05)',
                color: lesson.qa_enabled ? '#a78bfa' : '#8f8f91',
                border: lesson.qa_enabled ? '1px solid rgba(167,139,250,0.2)' : '1px solid rgba(255,255,255,0.08)',
              }}>
              <MessageCircle className="w-3 h-3" />
              {lesson.qa_enabled ? 'Q&A On' : 'Q&A Off'}
            </button>

            <button
              onClick={() => setShowLastLessonModal(true)}
              title={lesson.is_last_lesson ? 'Unmark as the last lesson' : 'Mark as the last lesson — students get the certificate after completing it'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: lesson.is_last_lesson ? 'rgba(234,179,8,0.12)' : 'rgba(255,255,255,0.05)',
                color: lesson.is_last_lesson ? '#eab308' : '#8f8f91',
                border: lesson.is_last_lesson ? '1px solid rgba(234,179,8,0.25)' : '1px solid rgba(255,255,255,0.08)',
              }}>
              <Award className="w-3 h-3" />
              {lesson.is_last_lesson ? 'Last Lesson' : 'Mark as Last'}
            </button>

            <button onClick={() => { setExpanded(!expanded); setOperationError('') }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold flex-shrink-0"
              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-light)' }}>
              {lesson.content_type === 'assignment'
                ? (lesson.assignment_prompt || lesson.assignment_file_url ? 'Edit' : 'Add')
                : lesson.content_type === 'quiz'
                  ? (Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0 ? 'Edit' : 'Add')
                  : (expanded ? 'Close' : 'Edit')}
            </button>
          </div>
        </div>

        {/* Expanded section */}
        {expanded && (
          <div className="px-4 pb-4 border-t" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
            <div className="pt-4 flex flex-col gap-3">

              {/* Inline error */}
              {operationError && (
                <div className="p-3 rounded-xl text-xs flex items-start gap-2"
                  style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  {operationError}
                </div>
              )}

              {/* ── QUIZ: only quiz builder + delete ── */}
              {lesson.content_type === 'quiz' && (
                <>
                  <Link
                    href={`/dashboard/courses/${lesson.course_id}/lessons/${lesson.id}/quiz`}
                    className="flex items-center justify-between gap-3 p-4 rounded-xl"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-lg">🧠</span>
                      <div>
                        <p className="text-sm font-semibold text-white">Open Quiz Builder</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--kurso-primary-lighter)' }}>
                          {Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0
                            ? `${lesson.quiz_questions.length} question${lesson.quiz_questions.length !== 1 ? 's' : ''} added`
                            : 'No questions yet — click to add'}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  </Link>
                  {Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0 && (
                    <button
                      onClick={async () => {
                        if (window.confirm('Delete all quiz questions for this lesson?')) {
                          const { error } = await supabase.from('lessons').update({ quiz_questions: [] }).eq('id', lesson.id)
                          if (error) setOperationError(error.message)
                          else onRefresh()
                        }
                      }}
                      className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-fit"
                      style={{ background: 'rgba(239,68,68,0.07)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                      <Trash2 className="w-3.5 h-3.5" /> Clear All Questions
                    </button>
                  )}
                  <button onClick={() => setShowDeleteModal(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-fit"
                    style={{ background: 'rgba(239,68,68,0.07)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete Lesson
                  </button>
                </>
              )}

              {/* ── ASSIGNMENT: only assignment editor + delete ── */}
              {lesson.content_type === 'assignment' && (
                <>
                  <AssignmentEditor lesson={lesson} onRefresh={onRefresh} />
                  <button onClick={() => setShowDeleteModal(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-fit"
                    style={{ background: 'rgba(239,68,68,0.07)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete Lesson
                  </button>
                </>
              )}

              {/* ── PDF: only quiz builder + delete ── */}
              {lesson.content_type === 'pdf' && (
                <>
                  <Link
                    href={`/dashboard/courses/${lesson.course_id}/lessons/${lesson.id}/quiz`}
                    className="flex items-center justify-between gap-3 p-3 rounded-xl text-sm"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)', color: '#fff' }}>
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      <span>Quiz Builder</span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--kurso-primary-lighter)' }}>
                      {Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0
                        ? `${lesson.quiz_questions.length} questions`
                        : 'Add quiz'}
                    </span>
                  </Link>
                  <button onClick={() => setShowDeleteModal(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-fit"
                    style={{ background: 'rgba(239,68,68,0.07)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete Lesson
                  </button>
                </>
              )}

              {/* ── VIDEO + LIVE: notes, quiz, assignment, delivery, live stuff, delete ── */}
              {(lesson.content_type === 'video' || lesson.content_type === 'live') && (
                <>
                  {/* Notes */}
                  <div className="p-3 rounded-xl"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-semibold text-white">📝 Notes</p>
                        {lesson.notes_url && (
                          <button onClick={deleteNotes}
                            className="w-5 h-5 flex items-center justify-center rounded"
                            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      {lesson.notes_url && (
                        <Link href={`/resource/${lesson.id}?type=notes`} target="_blank"
                          className="text-[10px] text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)]">View</Link>
                      )}
                    </div>
                    <p className="text-[10px] truncate mb-2" style={{ color: '#52525b' }}>
                      {lesson.notes_url ? lesson.notes_name || 'Uploaded' : 'Upload a PDF, doc or text file for students'}
                    </p>
                    <input type="file"
                      accept=".pdf,.txt,.md,.doc,.docx,application/pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden" id={`notes-${lesson.id}`}
                      onChange={e => uploadNotes(e.target.files?.[0] || null)}
                    />
                    <label htmlFor={`notes-${lesson.id}`}
                      className="block w-full text-center px-3 py-2 rounded-lg text-xs font-medium cursor-pointer"
                      style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-lighter)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                      {resourceSaving ? 'Uploading...' : lesson.notes_url ? 'Replace Notes' : 'Upload Notes'}
                    </label>
                  </div>

                  {/* Quiz Builder */}
                  <div className="flex items-center justify-between gap-3 p-3 rounded-xl text-sm"
                    style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.18)', color: '#fff' }}>
                    <Link href={`/dashboard/courses/${lesson.course_id}/lessons/${lesson.id}/quiz`}
                      className="flex-1 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      <span>Quiz Builder</span>
                    </Link>
                    {Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0 && (
                      <button
                        onClick={async () => {
                          if (window.confirm('Delete this quiz?')) {
                            const { error } = await supabase.from('lessons').update({ quiz_questions: [] }).eq('id', lesson.id)
                            if (error) setOperationError(error.message)
                            else onRefresh()
                          }
                        }}
                        className="w-7 h-7 flex items-center justify-center rounded-lg"
                        style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <span className="text-xs text-[var(--kurso-primary-light)]">
                      {Array.isArray(lesson.quiz_questions) && lesson.quiz_questions.length > 0
                        ? `${lesson.quiz_questions.length} questions`
                        : 'Optional'}
                    </span>
                  </div>

                  {/* Assignment */}
                  <AssignmentEditor lesson={lesson} onRefresh={onRefresh} />

                  {/* Expected delivery (unpublished only) */}
                  {!lesson.is_published && (
                    <ExpectedDeliveryEditor lesson={lesson} onRefresh={onRefresh} />
                  )}

                  {/* Live session info */}
                  {lesson.content_type === 'live' && (
                    <div className="p-3 rounded-xl"
                      style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)' }}>
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                          <p className="text-xs font-semibold text-green-400 mb-1">📡 Live Session</p>
                          {lesson.live_scheduled_at && (
                            <p className="text-xs text-zinc-400">
                              {new Date(lesson.live_scheduled_at).toLocaleString('en-IN', {
                                day: 'numeric', month: 'short', year: 'numeric',
                                hour: 'numeric', minute: '2-digit',
                              })} · {lesson.live_duration_minutes || 60} min
                            </p>
                          )}
                          {lesson.live_recording_url && (
                            <p className="text-xs mt-1" style={{ color: '#4ade80' }}>✓ Recording available</p>
                          )}
                        </div>
                        {lesson.live_join_url && (
                          <a href={lesson.live_join_url} target="_blank" rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                            style={{ background: 'rgba(34,197,94,0.15)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.3)' }}>
                            Join Link ↗
                          </a>
                        )}
                      </div>
                      <div className="mt-3">
                        <LiveRecordingEditor lesson={lesson} onRefresh={onRefresh} />
                      </div>
                    </div>
                  )}

                  {/* Delete */}
                  <button onClick={() => setShowDeleteModal(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium w-fit"
                    style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete Lesson
                  </button>
                </>
              )}

            </div>
          </div>
        )}
      </div>
    </>
  )
}

// ── LIVE SESSIONS TAB ──
interface LiveSession {
  id: string
  title: string
  description?: string | null
  scheduled_at: string
  duration_minutes: number
  join_url: string
  recording_url?: string | null
  recording_storage_path?: string | null
  has_recording?: boolean
}

function LiveSessionsTab({ courseId, token }: { courseId: string; token: string }) {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingSession, setEditingSession] = useState<LiveSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Form state
  const [fTitle, setFTitle] = useState('')
  const [fDesc, setFDesc] = useState('')
  const [fDate, setFDate] = useState('')
  const [fTime, setFTime] = useState('')
  const [fDuration, setFDuration] = useState('60')
  const [fJoinUrl, setFJoinUrl] = useState('')
  const [fRecordingUrl, setFRecordingUrl] = useState('')
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(null)
  const [recordingUrl, setRecordingUrlState] = useState('')
  const [savingRecording, setSavingRecording] = useState(false)
  const [uploadingRecording, setUploadingRecording] = useState(false)
  const [recordingUploadError, setRecordingUploadError] = useState('')
  const recordingFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { fetchSessions() }, [courseId])

  async function fetchSessions() {
    setLoading(true)
    try {
      const res = await fetch(`/api/live-sessions?courseId=${courseId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json()
      setSessions(json.sessions || [])
    } catch { /* non-fatal */ }
    finally { setLoading(false) }
  }

  function openAddForm() {
    setEditingSession(null)
    setFTitle(''); setFDesc(''); setFDate(''); setFTime('')
    setFDuration('60'); setFJoinUrl(''); setFRecordingUrl('')
    setError('')
    setShowForm(true)
  }

  function openEditForm(s: LiveSession) {
    setEditingSession(s)
    const dt = new Date(s.scheduled_at)
    setFTitle(s.title)
    setFDesc(s.description || '')
    setFDate(dt.toISOString().slice(0, 10))
    setFTime(dt.toISOString().slice(11, 16))
    setFDuration(String(s.duration_minutes))
    setFJoinUrl(s.join_url)
    setFRecordingUrl(s.recording_url || '')
    setError('')
    setShowForm(true)
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!fTitle.trim() || !fDate || !fTime || !fJoinUrl.trim()) {
      setError('Title, date, time and join URL are required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const scheduledAt = new Date(`${fDate}T${fTime}`).toISOString()
      const body = {
        courseId,
        title: fTitle.trim(),
        description: fDesc.trim() || null,
        scheduledAt,
        durationMinutes: parseInt(fDuration) || 60,
        joinUrl: fJoinUrl.trim(),
      }

      if (editingSession) {
        const res = await fetch(`/api/live-sessions/${editingSession.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Update failed')
      } else {
        const res = await fetch('/api/live-sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Create failed')
      }

      setShowForm(false)
      await fetchSessions()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(sessionId: string) {
    if (!confirm('Delete this live session?')) return
    await fetch(`/api/live-sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    await fetchSessions()
  }

  async function handleSessionRecordingUpload(sessionId: string, file: File) {
    const allowedExt = ['.mp4', '.mov', '.webm', '.m4v']
    const nameLower = file.name.toLowerCase()
    if (!allowedExt.some(ext => nameLower.endsWith(ext))) {
      setRecordingUploadError('Please upload an MP4, MOV, WEBM, or M4V file.')
      return
    }
    if (file.size > 3 * 1024 * 1024 * 1024) {
      setRecordingUploadError('File is larger than 3GB — please compress it first.')
      return
    }
    setUploadingRecording(true)
    setRecordingUploadError('')
    try {
      const { storagePath } = await uploadToSupabase(file, 'live-session-recordings', courseId)
      await fetch(`/api/live-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ recording_storage_path: storagePath }),
      })
      setRecordingSessionId(null)
      await fetchSessions()
    } catch (err: any) {
      setRecordingUploadError(err.message || 'Upload failed.')
    } finally {
      setUploadingRecording(false)
    }
  }

  async function saveRecording(sessionId: string) {
    if (!recordingUrl.trim()) return
    setSavingRecording(true)
    try {
      await fetch(`/api/live-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ recording_url: recordingUrl.trim() }),
      })
      setRecordingSessionId(null)
      setRecordingUrlState('')
      await fetchSessions()
    } catch { /* non-fatal */ }
    finally { setSavingRecording(false) }
  }

  function formatSessionDate(iso: string) {
    const d = new Date(iso)
    return d.toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  }

  function isUpcoming(iso: string) {
    return new Date(iso) > new Date()
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-white">Live Sessions</h2>
          <p className="text-xs mt-0.5" style={{ color: '#52525b' }}>
            Schedule Zoom/Meet classes — reminders auto-sent via Telegram
          </p>
        </div>
        <button
          onClick={openAddForm}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90"
        >
          <Plus className="w-4 h-4" />
          Schedule Session
        </button>
      </div>

      {/* Add / Edit form */}
      {showForm && (
        <div className="rounded-2xl p-5 glass" style={{ border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">
              {editingSession ? 'Edit Session' : 'New Live Session'}
            </h3>
            <button onClick={() => setShowForm(false)}
              className="w-7 h-7 flex items-center justify-center rounded-lg"
              style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-2 block">Session Title *</label>
              <input value={fTitle} onChange={e => setFTitle(e.target.value)}
                placeholder="e.g. Live Q&A — Week 3"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
            </div>
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-2 block">Description (optional)</label>
              <textarea value={fDesc} onChange={e => setFDesc(e.target.value)}
                rows={2} placeholder="What will be covered in this session?"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none resize-none focus:border-[var(--kurso-primary)]" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-semibold text-zinc-300 mb-2 block">Date *</label>
                <input value={fDate} onChange={e => setFDate(e.target.value)}
                  type="date"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
              </div>
              <div>
                <label className="text-sm font-semibold text-zinc-300 mb-2 block">Time *</label>
                <input value={fTime} onChange={e => setFTime(e.target.value)}
                  type="time"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
              </div>
            </div>
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-2 block">Duration (minutes)</label>
              <input value={fDuration} onChange={e => setFDuration(e.target.value)}
                type="number" min="15" max="480"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
            </div>
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-2 block">Zoom / Meet Join URL *</label>
              <input value={fJoinUrl} onChange={e => setFJoinUrl(e.target.value)}
                type="url" placeholder="https://zoom.us/j/... or meet.google.com/..."
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
            </div>
            {error && (
              <p className="text-xs px-3 py-2 rounded-xl"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                {error}
              </p>
            )}
            <div className="flex gap-3">
              <button type="button" onClick={() => setShowForm(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving...' : editingSession ? 'Save Changes' : 'Schedule Session'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Session list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-[var(--kurso-primary)] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-2xl p-12 text-center glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
            style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
            <Calendar className="w-6 h-6" style={{ color: 'var(--kurso-primary-light)' }} />
          </div>
          <p className="text-sm font-medium text-white mb-1">No live sessions yet</p>
          <p className="text-xs" style={{ color: '#52525b' }}>
            Schedule a session — students get automatic Telegram reminders 24h and 15 min before.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sessions.map(s => {
            const upcoming = isUpcoming(s.scheduled_at)
            return (
              <div key={s.id} className="rounded-2xl p-5 glass"
                style={{ border: upcoming ? '1px solid rgba(var(--kurso-primary-rgb), 0.25)' : '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <p className="text-sm font-semibold text-white">{s.title}</p>
                      <span className="text-xs px-2 py-0.5 rounded-full"
                        style={upcoming
                          ? { background: 'rgba(var(--kurso-primary-rgb), 0.15)', color: 'var(--kurso-primary-light)' }
                          : { background: 'rgba(255,255,255,0.05)', color: '#52525b' }}>
                        {upcoming ? 'Upcoming' : 'Past'}
                      </span>
                      {s.has_recording && (
                        <span className="text-xs px-2 py-0.5 rounded-full"
                          style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                          Recording added
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p className="text-xs mb-2" style={{ color: '#a1a1aa' }}>{s.description}</p>
                    )}
                    <div className="flex flex-wrap gap-3">
                      <span className="flex items-center gap-1.5 text-xs" style={{ color: '#71717a' }}>
                        <Calendar className="w-3.5 h-3.5" />
                        {formatSessionDate(s.scheduled_at)}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs" style={{ color: '#71717a' }}>
                        <Clock className="w-3.5 h-3.5" />
                        {s.duration_minutes} min
                      </span>
                      <a href={s.join_url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs hover:underline"
                        style={{ color: 'var(--kurso-primary-light)' }}>
                        <LinkIcon className="w-3.5 h-3.5" />
                        Join link
                      </a>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => openEditForm(s)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(s.id)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Add recording (for past sessions without one) */}
                {!upcoming && !s.has_recording && recordingSessionId !== s.id && (
                  <button
                    onClick={() => { setRecordingSessionId(s.id); setRecordingUrlState(''); setRecordingUploadError('') }}
                    className="text-xs px-3 py-1.5 rounded-lg mt-1"
                    style={{ background: 'rgba(34,197,94,0.08)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}>
                    + Add Recording
                  </button>
                )}

                {recordingSessionId === s.id && (
                  <div className="mt-2 p-3 rounded-xl" style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.18)' }}>
                    <button
                      onClick={() => recordingFileInputRef.current?.click()}
                      disabled={uploadingRecording}
                      className="w-full py-2.5 rounded-lg text-sm font-semibold text-white mb-2 disabled:opacity-50"
                      style={{ background: 'linear-gradient(135deg,var(--kurso-primary),var(--kurso-secondary))' }}>
                      {uploadingRecording ? 'Uploading…' : 'Upload Recording (recommended)'}
                    </button>
                    <input ref={recordingFileInputRef} type="file" accept="video/*" className="hidden"
                      onChange={e => e.target.files?.[0] && handleSessionRecordingUpload(s.id, e.target.files[0])} />
                    {recordingUploadError && <p className="text-[10px] mb-2" style={{ color: '#ef4444' }}>{recordingUploadError}</p>}
                    <p className="text-[10px] text-zinc-600 mb-3">
                      Uploaded recordings get a per-student watermark and expiring links.
                    </p>
                    <div className="flex items-center gap-2 mb-2">
                      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
                      <span className="text-[10px]" style={{ color: '#52525b' }}>or</span>
                      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.08)' }} />
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={recordingUrl}
                        onChange={e => setRecordingUrlState(e.target.value)}
                        type="url"
                        placeholder="Or paste an external link..."
                        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                      />
                      <button onClick={() => saveRecording(s.id)} disabled={savingRecording}
                        className="px-4 py-2 rounded-xl text-sm font-medium text-white violet-gradient disabled:opacity-50">
                        {savingRecording ? '...' : 'Save'}
                      </button>
                      <button onClick={() => setRecordingSessionId(null)}
                        className="px-3 py-2 rounded-xl text-sm"
                        style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
                        Cancel
                      </button>
                    </div>
                    <p className="text-[10px] mt-1.5" style={{ color: '#71717a' }}>
                      ⚠️ External links are not watermarked or protected.
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── CERTIFICATE PREVIEW MODAL ──
function CertificatePreviewModal({
  isOpen,
  onClose,
  template,
  paletteId,
  courseName,
  creatorName,
  skills,
  courseDuration,
  logoUrl,
  signatureUrl,
  customMessage,
}: {
  isOpen: boolean
  onClose: () => void
  template: string
  paletteId?: string
  courseName: string
  creatorName: string
  skills?: string
  courseDuration?: string
  logoUrl?: string
  signatureUrl?: string
  customMessage?: string
}) {
  if (!isOpen) return null

  const palette = getCertLayoutPalette(template, paletteId)
  const isModern = template === 'modern'
  const isGold = template === 'gold'
  const isMinimal = template === 'minimal'
  const isRoyal = template === 'royal'
  const style = {
    background: palette.background,
    borderColor: isMinimal ? 'transparent' : palette.accent,
    accentColor: palette.accent,
    accentLight: palette.accentLight,
    divider: palette.divider,
    textColor: palette.textPrimary,
    mutedTextColor: palette.textMuted,
  }

  const skillsArray = skills
    ? skills.split(',').map(s => s.trim()).filter(Boolean)
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)' }}>
      <div className="w-full max-w-5xl rounded-2xl overflow-hidden flex flex-col max-h-[95vh]" style={{ background: '#111', border: '1px solid rgba(var(--kurso-primary-rgb), 0.3)' }}>
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
          <h2 className="text-lg font-semibold text-white">Certificate Preview</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg" style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preview Area */}
        <div className="p-6 flex-1 overflow-auto" style={{ background: '#0a0a0a' }}>
          <div
            className="w-full aspect-[1.414/1] rounded-xl overflow-hidden shadow-2xl p-6 md:p-8 flex flex-col items-center justify-center mx-auto relative"
            style={{
              background: style.background,
              border: isMinimal ? '0' : isGold ? `5px solid ${style.borderColor}` : isRoyal ? `3px solid ${style.borderColor}` : `4px solid ${style.borderColor}`,
              outline: isGold ? `1px solid ${palette.accentDark}` : isRoyal ? `1px solid ${palette.accentDark}` : undefined,
              outlineOffset: isGold || isRoyal ? '-12px' : undefined,
            }}
          >
            {isModern && <><span className="absolute inset-y-0 left-0 w-2" style={{ background: style.accentColor }} /><span className="absolute inset-y-0 right-0 w-2" style={{ background: style.accentColor }} /><span className="absolute inset-x-2 top-0 h-1.5" style={{ background: style.accentColor }} /><span className="absolute inset-7 border" style={{ borderColor: style.divider }} /></>}
            {isMinimal && <><span className="absolute inset-x-0 top-0 h-2" style={{ background: style.accentColor }} /><span className="absolute inset-y-2 left-0 w-1" style={{ background: style.accentColor }} /></>}
            {!isModern && !isMinimal && <span className="absolute inset-4 pointer-events-none" style={{ border: `1px solid ${isRoyal ? palette.accentDark : isGold ? palette.accentDark : style.divider}` }} />}
            {/* Logo */}
            {logoUrl && (
              <div className="mb-4 md:mb-6">
                <img src={logoUrl} alt="Brand Logo" className="h-12 md:h-16 object-contain" />
              </div>
            )}

            {/* Certificate Header */}
            <p
              className="text-xs tracking-[0.2em] uppercase mb-3 md:mb-4"
              style={{ color: isModern || isRoyal ? style.accentLight : style.accentColor }}
            >
              Certificate of Completion
            </p>

            {/* Student Name */}
            <h1
              className="text-2xl md:text-4xl font-bold mb-2"
              style={{ color: style.textColor }}
            >
              John Doe
            </h1>
            <div className="w-16 md:w-24 h-1 mb-3 md:mb-4" style={{ background: style.accentColor }} />

            {/* Course Name */}
            <p
              className="text-lg md:text-xl mb-4 md:mb-6 text-center"
              style={{ color: style.mutedTextColor }}
            >
              has successfully completed <strong>{courseName}</strong>
            </p>

            {/* Skills */}
            {skillsArray.length > 0 && (
              <div className="mb-4 md:mb-6 flex flex-wrap gap-2 justify-center">
                {skillsArray.slice(0, 4).map((skill, i) => (
                  <span
                    key={i}
                    className="px-2 md:px-3 py-1 rounded-full text-xs"
                    style={{ background: `${style.accentColor}20`, color: isModern || isRoyal ? style.accentLight : style.accentColor, border: `1px solid ${style.accentColor}40` }}
                  >
                    {skill}
                  </span>
                ))}
              </div>
            )}

            {/* Duration */}
            {courseDuration && (
              <p
                className="text-xs md:text-sm mb-4 md:mb-6"
                style={{ color: style.mutedTextColor }}
              >
                Duration: {courseDuration}
              </p>
            )}

            {/* Custom Message */}
            {customMessage && (
              <p
                className="text-xs md:text-sm mb-4 md:mb-6 italic text-center max-w-md"
                style={{ color: style.mutedTextColor }}
              >
                "{customMessage}"
              </p>
            )}

            {/* Signature */}
            <div className="flex items-center justify-between w-full max-w-md mt-auto">
              <div className="text-center">
                {signatureUrl ? (
                  <img src={signatureUrl} alt="Signature" className="h-10 md:h-16 object-contain mb-2" />
                ) : (
                  <div className="h-10 md:h-12 w-24 md:w-32 border-b mb-2" style={{ borderColor: style.textColor + '60' }} />
                )}
                <p className="text-xs md:text-sm font-semibold" style={{ color: style.textColor }}>
                  {creatorName}
                </p>
                <p className="text-xs" style={{ color: style.textColor + '80' }}>
                  Mentor
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs md:text-sm font-semibold" style={{ color: style.textColor }}>
                  {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
                <p className="text-xs" style={{ color: style.textColor + '80' }}>
                  Issue Date
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section
      className="rounded-2xl p-5 sm:p-6"
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <div className="mb-5">
        <h3 className="text-base font-semibold text-white">
          {title}
        </h3>

        {description && (
          <p
            className="text-sm mt-1.5"
            style={{ color: 'var(--kurso-hint)' }}
          >
            {description}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {children}
      </div>
    </section>
  )
}

// ── MAIN PAGE ──
export default function CourseManagePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()

  const [course, setCourse] = useState<Course | null>(null)
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [modules, setModules] = useState<CourseModule[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddModal, setShowAddModal] = useState(false)
  const [blockedPublishLesson, setBlockedPublishLesson] = useState<Lesson | null>(null)
  const [selectedModuleForLesson, setSelectedModuleForLesson] = useState('')
  const [showModuleModal, setShowModuleModal] = useState(false)

  const [addContentType, setAddContentType] = useState<'video' | 'pdf' | 'live' | 'quiz' | 'assignment'>('video')
  const [deletingModule, setDeletingModule] = useState<CourseModule | null>(null)
  const [delayMessage, setDelayMessage] = useState('')
  const [broadcastSending, setBroadcastSending] = useState(false)
  const [broadcastSent, setBroadcastSent] = useState(false)
  const [creatorId, setCreatorId] = useState('')
  const [effectivePlanId, setEffectivePlanId] = useState<SubscriptionPlanId | null>(null)
  const [hasActivePaidPlan, setHasActivePaidPlan] = useState(false)
  const [showTestModal, setShowTestModal] = useState(false)
  const [creatorTelegramBotUsername, setCreatorTelegramBotUsername] = useState<string | null>(null)
  const [settingsDelivery, setSettingsDelivery] = useState<SubscriptionPlanId>('telegram')
  const [applyDeliveryToEnrolled, setApplyDeliveryToEnrolled] = useState(false)
  const [savingDelivery, setSavingDelivery] = useState(false)
  const [deliveryError, setDeliveryError] = useState('')
  const [deliverySuccess, setDeliverySuccess] = useState('')
  const [copied, setCopied] = useState(false)
  const [copiedCheckout, setCopiedCheckout] = useState(false)
  const [copiedEmbed, setCopiedEmbed] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)
  const [activeTab, setActiveTab] = useState<'lessons' | 'settings' | 'landing'>(
    searchParams.get('tab') === 'settings' ? 'settings'
      : searchParams.get('tab') === 'landing' ? 'landing'
        : 'lessons'
  )
  const [token, setToken] = useState('')

  // Settings state
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [editOriginalPrice, setEditOriginalPrice] = useState('')
  const [editRefundWindowDays, setEditRefundWindowDays] = useState('7')
  const [editRefundPolicyPath, setEditRefundPolicyPath] = useState('')
  const [editTermsPath, setEditTermsPath] = useState('')
  const [editPrivacyPath, setEditPrivacyPath] = useState('')
  const [uploadingPolicyDoc, setUploadingPolicyDoc] = useState<PolicyDocType | null>(null)
  const [editContactDetails, setEditContactDetails] = useState<ContactDetail[]>([])
  const [editRatingsEnabledOnLanding, setEditRatingsEnabledOnLanding] = useState(false)
  const [editSocialLinks, setEditSocialLinks] = useState<SocialLink[]>([])
  const [editPromoVideoHeading, setEditPromoVideoHeading] = useState('')
  const [editHostName, setEditHostName] = useState('')
  const [editAbout, setEditAbout] = useState('')
  const [editStartDate, setEditStartDate] = useState('')
  const [editDuration, setEditDuration] = useState('')
  const [editLanguage, setEditLanguage] = useState('English')
  const [editNextLessonDate, setEditNextLessonDate] = useState('')
  const [editCourseEndDate, setEditCourseEndDate] = useState('')
  const [editStudentMessage, setEditStudentMessage] = useState('')
  const [editLearn, setEditLearn] = useState<string[]>([])
  const [editFaq, setEditFaq] = useState<{ question: string; answer: string }[]>([])
  const [editHostImage, setEditHostImage] = useState('')
  const [editIsFreeCourse, setEditIsFreeCourse] = useState(false)
  const [editCertEnabled, setEditCertEnabled] = useState(true)
  const [editCertTemplate, setEditCertTemplate] = useState<string>('classic')
  const [editCertPalette, setEditCertPalette] = useState<string>('classic-gold')
  const [editCertCustomMessage, setEditCertCustomMessage] = useState('')
  const [uploadingImage, setUploadingImage] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const settingsLoadedRef = useRef(false)
  const lastSavedSettingsRef = useRef('')

  // Deletion state
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteInput, setDeleteInput] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [editSkills, setEditSkills] = useState('') // comma-separated in the UI
  const [editCertLogoUrl, setEditCertLogoUrl] = useState('')
  const [editCertSignatureUrl, setEditCertSignatureUrl] = useState('')
  const [showCertPreview, setShowCertPreview] = useState(false)
  const [previewTemplate, setPreviewTemplate] = useState<string>('classic')
  // Shared brand logo — uploaded from the "Design Landing Page" tab, read-only here.
  const [brandLogoUrl, setBrandLogoUrl] = useState('')
  const [uploadingBrandLogo, setUploadingBrandLogo] = useState(false)
  const [editUseLogoOnCertificate, setEditUseLogoOnCertificate] = useState(false)
  const [editBrandName, setEditBrandName] = useState('')
  const [editInstructorTitle, setEditInstructorTitle] = useState('')
  const [editCoInstructors, setEditCoInstructors] = useState<CoInstructor[]>([])
  const [editPromoVideoUrls, setEditPromoVideoUrls] = useState<string[]>([])
  const [editTargetAudience, setEditTargetAudience] = useState<string[]>([])
  const [editTestimonials, setEditTestimonials] = useState<Testimonial[]>([])
  const [uploadingTestimonialIndex, setUploadingTestimonialIndex] = useState<number | null>(null)
  const [testimonialUploadError, setTestimonialUploadError] = useState('')
  const [editLevel, setEditLevel] = useState('')
  const [editRequirements, setEditRequirements] = useState<string[]>([])
  const [settingsLandingConfig, setSettingsLandingConfig] = useState<LandingConfig>(DEFAULT_LANDING_CONFIG)
  const [uploadingCustomImageId, setUploadingCustomImageId] = useState<string | null>(null)

  const isFinalCtaEnabled = settingsLandingConfig.sections.find(s => s.type === 'finalCta')?.enabled;

  useEffect(() => {
    async function load() {
      settingsLoadedRef.current = false
      lastSavedSettingsRef.current = ''

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCreatorId(user.id)
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) setToken(session.access_token)

      const { data: courseData } = await supabase
        .from('courses')
        .select('*')
        .eq('id', id)
        .eq('creator_id', user.id)
        .single()

      if (!courseData) { router.push('/dashboard/courses'); return }
      setCourse(courseData)
      setSettingsDelivery((courseData.delivery as SubscriptionPlanId) || 'telegram')

      const { data: creatorRow } = await supabase
        .from('creators')
        .select('trial_ends_at, telegram_bot_username')
        .eq('id', user.id)
        .maybeSingle()
      setCreatorTelegramBotUsername(creatorRow?.telegram_bot_username || null)
      const plan = await getEffectivePlanId(user.id, creatorRow?.trial_ends_at)
      setEffectivePlanId(plan)
      // Strict check for the "Go Live" gate — deliberately called WITHOUT
      // trialEndsAt, so a trial never counts as a real plan for publishing.
      // (effectivePlanId above still grants trial access for picking a
      // delivery method on a draft — that's fine, since drafting is free;
      // only actually going live requires a real active paid plan.)
      const strictPlan = await getEffectivePlanId(user.id)
      setHasActivePaidPlan(!!strictPlan)

      // Init settings state
      setEditName(courseData.name)
      setEditDesc(courseData.description)
      setEditPrice(courseData.price.toString())
      setEditOriginalPrice(courseData.original_price?.toString() || '')
      setEditRefundWindowDays(courseData.refund_window_days?.toString() ?? '7')
      setEditRefundPolicyPath(courseData.refund_policy_storage_path || '')
      setEditTermsPath(courseData.terms_storage_path || '')
      setEditPrivacyPath(courseData.privacy_storage_path || '')
      setEditContactDetails(parseContactDetails(courseData.contact_details))
      setEditRatingsEnabledOnLanding(!!courseData.ratings_enabled_on_landing)
      setEditSocialLinks(parseSocialLinks(courseData.social_links))
      setEditPromoVideoHeading(courseData.promo_video_heading || '')
      setEditHostName(courseData.host_name || '')
      setEditInstructorTitle(courseData.instructor_title || '')
      setEditAbout(courseData.about_creator || '')
      setEditStartDate(courseData.start_date || '')
      setEditDuration(courseData.duration || '')
      setEditLanguage(
        Array.isArray(courseData.language)
          ? courseData.language.join(', ')
          : 'English'
      )

      setEditSkills(Array.isArray(courseData.skills) ? courseData.skills.join(', ') : '')
      setEditNextLessonDate(courseData.next_lesson_date || '')
      setEditCourseEndDate(courseData.course_end_date || '')
      setEditStudentMessage(courseData.student_update_message || '')
      setEditLearn(courseData.what_you_will_learn || [''])
      setEditFaq(courseData.faq || [{ question: '', answer: '' }])
      setEditHostImage(courseData.host_image || '')
      setEditIsFreeCourse(courseData.is_free_course ?? false)
      setEditCertEnabled(courseData.cert_enabled !== false)
      setEditCertTemplate(courseData.cert_template || 'classic')
      setEditCertPalette(
        courseData.cert_palette && CERT_PALETTES.some(p => p.id === courseData.cert_palette)
          ? courseData.cert_palette
          : 'classic-gold'
      )
      setEditCertCustomMessage(courseData.cert_custom_message || '')
      setEditCertLogoUrl(courseData.cert_logo_url || '')
      setEditCertSignatureUrl(courseData.cert_signature_url || '')
      setBrandLogoUrl(courseData.brand_logo_url || '')
      setEditUseLogoOnCertificate(courseData.use_logo_on_certificate || false)
      setEditBrandName(courseData.brand_name || '')
      setEditCoInstructors(Array.isArray(courseData.co_instructors) ? courseData.co_instructors : [])
      // promo_video_urls is the new source of truth; fall back to the old
      // single-video column so a course configured before this feature
      // existed keeps showing its video instead of an empty list.
      setEditPromoVideoUrls(
        Array.isArray(courseData.promo_video_urls) && courseData.promo_video_urls.length > 0
          ? courseData.promo_video_urls
          : (courseData.promo_video_url ? [courseData.promo_video_url] : [])
      )
      setEditTargetAudience(courseData.target_audience || [''])
      setEditTestimonials(courseData.testimonials || [])
      setEditLevel(courseData.level || '')
      setEditRequirements(courseData.requirements || [''])
      setSettingsLandingConfig(normalizeLandingConfig(courseData.landing_config, courseData.landing_sections))

      await Promise.all([fetchLessons(), fetchModules()])
      setLoading(false)
    }
    load()
  }, [id])

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be 2MB or smaller.')
      return
    }

    setUploadingImage(true)
    try {
      const { publicUrl } = await uploadToSupabase(file, 'images')
      setEditHostImage(publicUrl)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setUploadingImage(false)
    }
  }

  async function handleTestimonialFileUpload(i: number, kind: 'photo' | 'screenshot', file: File) {
    if (!TESTIMONIAL_IMAGE_TYPES.includes(file.type)) {
      setTestimonialUploadError('Only JPG or PNG images are allowed.')
      return
    }
    if (file.size > MAX_TESTIMONIAL_IMAGE_BYTES) {
      setTestimonialUploadError('Image must be 5MB or smaller.')
      return
    }
    setTestimonialUploadError('')
    setUploadingTestimonialIndex(i)
    try {
      const folder = kind === 'photo' ? `testimonials/photos/${id}` : `testimonials/screenshots/${id}`
      const { publicUrl } = await uploadToSupabase(file, folder)
      const n = [...editTestimonials]
      const current = n[i]
      if (kind === 'photo' && current.type === 'written') {
        n[i] = { ...current, photo_url: publicUrl }
      } else if (kind === 'screenshot' && current.type === 'screenshot') {
        n[i] = { ...current, image_url: publicUrl }
      }
      setEditTestimonials(n)
    } catch (err: any) {
      setTestimonialUploadError(err?.message || 'Upload failed.')
    } finally {
      setUploadingTestimonialIndex(null)
    }
  }

  async function handleLegalDocUpload(e: React.ChangeEvent<HTMLInputElement>, docType: PolicyDocType) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!/\.(md|txt)$/i.test(file.name)) {
      alert('Please upload a .txt or .md file.')
      return
    }
    if (file.size > MAX_POLICY_FILE_BYTES) {
      alert(`File must be ${MAX_POLICY_FILE_BYTES / 1024}KB or smaller.`)
      return
    }
    setUploadingPolicyDoc(docType)
    try {
      const { publicUrl } = await uploadToSupabase(file, `policies/${id}`)
      if (docType === 'refund') setEditRefundPolicyPath(publicUrl)
      else if (docType === 'terms') setEditTermsPath(publicUrl)
      else setEditPrivacyPath(publicUrl)
    } catch (err: any) {
      alert(err.message)
    } finally {
      setUploadingPolicyDoc(null)
    }
  }

  async function handleRemoveLegalDoc(docType: PolicyDocType) {
    const currentPath = docType === 'refund' ? editRefundPolicyPath : docType === 'terms' ? editTermsPath : editPrivacyPath
    if (!currentPath) return
    if (!confirm(`Remove the uploaded ${POLICY_DOC_LABELS[docType]}? You can upload a new one anytime.`)) return

    try {
      const marker = '/lessons/'
      const idx = currentPath.indexOf(marker)
      if (idx !== -1) {
        await supabase.storage.from('lessons').remove([currentPath.slice(idx + marker.length)])
      }
    } catch {
      // Non-fatal — clearing the path below is what actually removes it
      // from the course page even if storage cleanup fails.
    }

    if (docType === 'refund') setEditRefundPolicyPath('')
    else if (docType === 'terms') setEditTermsPath('')
    else setEditPrivacyPath('')
  }

  function updateBonus(index: number, field: 'title' | 'description', value: string) {
    setSettingsLandingConfig(prev => ({ ...prev, bonuses: prev.bonuses.map((b, i) => i === index ? { ...b, [field]: value } : b) }))
  }
  function addBonus() {
    setSettingsLandingConfig(prev => ({ ...prev, bonuses: [...prev.bonuses, { title: '', description: '' }] }))
  }
  function removeBonus(index: number) {
    setSettingsLandingConfig(prev => ({ ...prev, bonuses: prev.bonuses.filter((_, i) => i !== index) }))
  }

  function updateDisclaimer(field: 'title' | 'text', value: string) {
    setSettingsLandingConfig(prev => ({ ...prev, disclaimer: { ...prev.disclaimer, [field]: value } }))
  }

  function updateUrgency(field: 'endAt' | 'label' | 'seatsLabel', value: string): void
  function updateUrgency(field: 'seatsAvailable', value: number | null): void
  function updateUrgency(field: any, value: any) {
    setSettingsLandingConfig(prev => ({ ...prev, urgency: { ...prev.urgency, [field]: value } }))
  }

  function addCustomSection() {
    if (settingsLandingConfig.customSections.length >= MAX_CUSTOM_SECTIONS_PER_COURSE) return
    const csId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const section: LandingCustomSection = {
      id: csId, heading: '', body: '', headingSize: 'md', bodySize: 'md', align: 'left',
      style: 'plain', background: 'theme', backgroundColor: '#000000', spacing: 'normal', images: [],
    }
    setSettingsLandingConfig(prev => {
      const finalCtaIdx = prev.sections.findIndex(s => s.type === 'finalCta')
      const entry: LandingSectionEntry = { type: 'custom', enabled: true, customId: csId }
      const sections = [...prev.sections]
      if (finalCtaIdx === -1) sections.push(entry)
      else sections.splice(finalCtaIdx, 0, entry)
      return { ...prev, sections, customSections: [...prev.customSections, section] }
    })
  }

  function updateCustomSection(csId: string, patch: Partial<LandingCustomSection>) {
    setSettingsLandingConfig(prev => ({ ...prev, customSections: prev.customSections.map(cs => cs.id === csId ? { ...cs, ...patch } : cs) }))
  }

  function removeCustomSection(csId: string) {
    setSettingsLandingConfig(prev => ({
      ...prev,
      sections: prev.sections.filter(s => s.customId !== csId),
      customSections: prev.customSections.filter(cs => cs.id !== csId),
    }))
  }

  async function addCustomSectionImages(csId: string, files: FileList) {
    const cs = settingsLandingConfig.customSections.find(c => c.id === csId)
    if (!cs) return
    const remaining = MAX_CUSTOM_SECTION_IMAGES - cs.images.length
    if (remaining <= 0) return
    const toUpload = Array.from(files).slice(0, remaining)
    setUploadingCustomImageId(csId)
    try {
      const uploaded: string[] = []
      for (const file of toUpload) {
        if (file.size > 5 * 1024 * 1024) continue
        const { publicUrl } = await uploadToSupabase(file, 'custom-section-images')
        uploaded.push(publicUrl)
      }
      updateCustomSection(csId, { images: [...cs.images, ...uploaded] })
    } catch (err: any) {
      alert(err.message || 'Image upload failed')
    } finally {
      setUploadingCustomImageId(null)
    }
  }

  function removeCustomSectionImage(csId: string, imageUrl: string) {
    const cs = settingsLandingConfig.customSections.find(c => c.id === csId)
    if (!cs) return
    updateCustomSection(csId, { images: cs.images.filter(img => img !== imageUrl) })
  }

  async function handleBrandLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { alert('Logo must be 2MB or smaller.'); return }
    setUploadingBrandLogo(true)
    try {
      const { publicUrl } = await uploadToSupabase(file, 'brand-logos')
      setBrandLogoUrl(publicUrl)
    } catch (err: any) {
      alert(err.message || 'Logo upload failed')
    } finally {
      setUploadingBrandLogo(false)
    }
  }

  async function updateSettings(): Promise<boolean> {
    setSavingSettings(true)
    // Social links are only written when every link is valid; otherwise the last
    // saved value stays in the database and the rest of the settings still save.
    const socialHasErrors = getSocialLinksErrors(editSocialLinks).hasErrors
    const cleanedSocialLinks = cleanSocialLinks(editSocialLinks)
    // Contact details are only written when every entry is valid; otherwise the
    // last saved value stays in the database and the rest of the settings still save.
    const contactHasErrors = getContactDetailsErrors(editContactDetails).hasErrors
    const cleanedContactDetails = cleanContactDetails(editContactDetails)
    const { error } = await supabase
      .from('courses')
      .update({
        name: editName,
        description: editDesc,
        host_name: editHostName,
        instructor_title: editInstructorTitle.trim() || null,
        about_creator: editAbout,
        start_date: editStartDate,
        duration: editDuration,
        language: editLanguage
          .split(',')
          .map(language => language.trim())
          .filter(Boolean),
        total_lessons: lessons.length,
        next_lesson_date: editNextLessonDate || null,
        course_end_date: editCourseEndDate || null,
        student_update_message: editStudentMessage.trim() || null,
        what_you_will_learn: editLearn.filter(l => l.trim()),
        faq: editFaq.filter(f => f.question.trim() && f.answer.trim()),
        host_image: editHostImage,
        // Server-side enforcement: if is_free_course is true, price is forced to 0
        is_free_course: editIsFreeCourse,
        price: editIsFreeCourse ? 0 : (parseInt(editPrice) || 0),
        original_price: editIsFreeCourse ? 0 : (editOriginalPrice ? parseInt(editOriginalPrice) : parseInt(editPrice) || 0),
        cert_enabled: editCertEnabled,
        cert_template: editCertTemplate,
        cert_palette: editCertPalette,
        cert_logo_url: editCertLogoUrl || null,
        cert_signature_url: editCertSignatureUrl || null,
        cert_custom_message: editCertCustomMessage.trim() || null,
        use_logo_on_certificate: editUseLogoOnCertificate,
        brand_logo_url: brandLogoUrl || null,
        skills: editSkills.trim()
          ? editSkills.split(',').map(s => s.trim()).filter(Boolean)
          : null,
        refund_window_days: editRefundWindowDays === '' ? 0 : parseInt(editRefundWindowDays),
        refund_policy_storage_path: editRefundPolicyPath || null,
        terms_storage_path: editTermsPath || null,
        privacy_storage_path: editPrivacyPath || null,
        ...(contactHasErrors ? {} : { contact_details: cleanedContactDetails }),
        ...(socialHasErrors ? {} : { social_links: cleanedSocialLinks }),
        ratings_enabled_on_landing: editRatingsEnabledOnLanding,
        brand_name: editBrandName.trim() || null,
        co_instructors: editCoInstructors
          .filter(ci => ci.name.trim())
          .map(ci => ({ name: ci.name.trim(), title: ci.title.trim(), image: ci.image, bio: ci.bio.trim() })),
        promo_video_urls: editPromoVideoUrls.map(v => v.trim()).filter(Boolean).slice(0, 3),
        // Kept in sync for anything that still reads the old single column.
        promo_video_url: editPromoVideoUrls.find(v => v.trim()) || null,
        promo_video_heading: editPromoVideoHeading.trim() || null,
        target_audience: editTargetAudience.filter(t => t.trim()),
        testimonials: editTestimonials.filter(t =>
          t.type === 'written' ? t.name.trim() && t.text.trim() : !!t.image_url
        ),
        level: editLevel || null,
        requirements: editRequirements.filter(r => r.trim()),
        landing_config: (() => {
          const cleanedBonuses = settingsLandingConfig.bonuses.map(b => ({ title: b.title.trim(), description: b.description.trim() })).filter(b => b.title.length > 0)
          const cleanedCustomSections = settingsLandingConfig.customSections
            .map(cs => ({ ...cs, heading: cs.heading.trim(), body: cs.body.trim() }))
            .filter(cs => cs.heading.length > 0 || cs.body.length > 0)
          const cleanedCustomIds = new Set(cleanedCustomSections.map(cs => cs.id))
          return {
            ...settingsLandingConfig,
            bonuses: cleanedBonuses,
            customSections: cleanedCustomSections,
            sections: settingsLandingConfig.sections.filter(s => s.type !== 'custom' || (s.customId ? cleanedCustomIds.has(s.customId) : false)),
          }
        })(),
      })
      .eq('id', id)

    if (!error) {
      setCourse({
        ...course!,
        name: editName,
        description: editDesc,
        price: parseInt(editPrice),
        original_price: editOriginalPrice ? parseInt(editOriginalPrice) : parseInt(editPrice),
        host_name: editHostName,
        instructor_title: editInstructorTitle.trim() || undefined,
        about_creator: editAbout,
        start_date: editStartDate,
        duration: editDuration,
        total_lessons: lessons.length,
        next_lesson_date: editNextLessonDate || undefined,
        course_end_date: editCourseEndDate || undefined,
        student_update_message: editStudentMessage.trim() || undefined,
        what_you_will_learn: editLearn.filter(l => l.trim()),
        faq: editFaq.filter(f => f.question.trim() && f.answer.trim()),
        host_image: editHostImage,
        is_free_course: editIsFreeCourse,
        cert_template: editCertTemplate,
        cert_palette: editCertPalette,
        refund_window_days: editRefundWindowDays === '' ? 0 : parseInt(editRefundWindowDays),
        refund_policy_storage_path: editRefundPolicyPath || undefined,
        terms_storage_path: editTermsPath || undefined,
        privacy_storage_path: editPrivacyPath || undefined,
        ...(contactHasErrors ? {} : { contact_details: cleanedContactDetails }),
        ...(socialHasErrors ? {} : { social_links: cleanedSocialLinks }),
        ratings_enabled_on_landing: editRatingsEnabledOnLanding,
        promo_video_heading: editPromoVideoHeading.trim() || undefined,
        co_instructors: editCoInstructors.filter(ci => ci.name.trim()),
      })
    }
    setSavingSettings(false)
    return !error
  }

  function LandingSectionToggle({
    type,
    customId,
    label = 'Show this on your landing page.',
  }: {
    type: LandingSectionType
    customId?: string
    label?: string
  }) {
    const entry = settingsLandingConfig.sections.find(section =>
      section.type === type &&
      (!customId || section.customId === customId)
    )

    // Hero and Final CTA remain structurally locked.
    if (!entry || type === 'hero' || type === 'finalCta') {
      return null
    }

    const enabled = entry.enabled

    return (
      <div
        className="flex items-center justify-between gap-4 mt-2 mb-4 p-4 rounded-xl"
        style={{
          background: enabled
            ? 'rgba(var(--kurso-primary-rgb), 0.06)'
            : 'rgba(255,255,255,0.03)',
          border: enabled
            ? '1px solid rgba(var(--kurso-primary-rgb), 0.25)'
            : '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div>
          <p className="text-sm font-semibold text-white">
            {label}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--kurso-hint)' }}>
            {enabled
              ? 'This section is shown on your landing page.'
              : 'This section is hidden from your landing page.'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setSettingsLandingConfig(previous => ({
              ...previous,
              sections: previous.sections.map(section =>
                section.type === type &&
                  (!customId || section.customId === customId)
                  ? { ...section, enabled: !enabled }
                  : section
              ),
            }))
          }}
          className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
          style={{
            background: enabled
              ? 'var(--kurso-primary)'
              : 'rgba(255,255,255,0.12)',
          }}
          aria-label={enabled ? 'Hide this section' : 'Show this section'}
          aria-pressed={enabled}
        >
          <span
            className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
            style={{
              transform: enabled
                ? 'translateX(20px)'
                : 'translateX(0)',
            }}
          />
        </button>
      </div>
    )
  }
  /**
   * Delivery method has its own explicit save (not the settings autosave):
   * changing it can cost real money (picking above-plan triggers inline
   * payment in the picker itself) and the "apply to enrolled students"
   * toggle needs a deliberate confirm, not a silent debounce.
   */
  function getDeliveryLabel(method: string): string {
    if (method === 'whatsapp') return 'WhatsApp'
    if (method === 'telegram') return 'Telegram'
    if (method === 'both') return 'WhatsApp + Telegram'
    return 'the selected channel'
  }


  async function saveDeliveryMethod() {
    if (!course) return
    setDeliveryError('')
    setDeliverySuccess('')
    // Exact-match coverage check, not price comparison — telegram and
    // whatsapp are separate channels, not tiers of each other.
    if (!planCoversDeliveryMethod(effectivePlanId, settingsDelivery)) {
      setDeliveryError(
        `Your current plan does not cover ${getDeliveryLabel(settingsDelivery)}. Please select a covered delivery method.`
      )
      return
    }
    setSavingDelivery(true)
    const { error: courseErr } = await supabase
      .from('courses')
      .update({ delivery: settingsDelivery })
      .eq('id', id)

    if (courseErr) {
      setDeliveryError('Could not save — please try again.')
      setSavingDelivery(false)
      return
    }

    setCourse({ ...course, delivery: settingsDelivery })

    // IMPORTANT:
    // Existing students must retain their enrollment.delivery_method snapshot.
    // This branch is intentionally kept for a future admin-controlled migration
    // feature, but there its UI toggle is commented out whcih can't be uncommented until Nivan/nancy approve.

    if (applyDeliveryToEnrolled) {
      const { error: enrollErr } = await supabase
        .from('enrollments')
        .update({ delivery_method: settingsDelivery })
        .eq('course_uuid', id)
      if (enrollErr) {
        setDeliveryError(
          `${getDeliveryLabel(settingsDelivery)} was saved for new students, but updating existing students failed — please try the toggle again.`
        )
        setSavingDelivery(false)
        return
      }
      setDeliverySuccess(
        `Saved — ${getDeliveryLabel(settingsDelivery)} now applies to new enrollments and existing students.`
      )
      setApplyDeliveryToEnrolled(false)
    } else {
      setDeliverySuccess(
        `Saved — ${getDeliveryLabel(settingsDelivery)} applies to new enrollments. Existing students keep their current access.`
      )
    }
    setSavingDelivery(false)
  }

  const settingsSnapshot = JSON.stringify({
    editName, editDesc, editPrice, editOriginalPrice, editRefundWindowDays,
    editRefundPolicyPath,
    editTermsPath,
    editPrivacyPath,
    editContactDetails,
    editRatingsEnabledOnLanding,
    editSocialLinks,
    editHostName,
    editInstructorTitle,
    editAbout,
    editStartDate,
    editDuration,
    editNextLessonDate, editCourseEndDate, editStudentMessage, editLearn, editFaq, editHostImage,
    editLanguage,
    editIsFreeCourse, editCertEnabled, editCertTemplate, editCertPalette, editCertCustomMessage,
    editSkills, editCertLogoUrl, editCertSignatureUrl, editUseLogoOnCertificate, editBrandName,
    editCoInstructors, editPromoVideoUrls, editPromoVideoHeading, editTargetAudience, editTestimonials,
    editLevel, editRequirements, settingsLandingConfig,
  })

  useEffect(() => {
    if (!course) return
    if (!settingsLoadedRef.current) {
      settingsLoadedRef.current = true
      lastSavedSettingsRef.current = settingsSnapshot
      return
    }
    if (settingsSnapshot === lastSavedSettingsRef.current) return

    const timer = window.setTimeout(async () => {
      const saved = await updateSettings()
      if (saved) lastSavedSettingsRef.current = settingsSnapshot
    }, 1000)

    return () => window.clearTimeout(timer)
    // The snapshot deliberately groups every settings control into one debounced save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsSnapshot, course])

  async function handleDeleteCourse() {
    if (deleteInput !== course?.name) return
    setIsDeleting(true)
    try {
      // 1. Get lesson IDs first — needed for lesson_access_logs cleanup
      const { data: lessonRows } = await supabase
        .from('lessons')
        .select('id')
        .eq('course_id', id)

      const lessonIds = (lessonRows || []).map((l: any) => l.id)

      // 2. Delete lesson_access_logs (no FK cascade, must be manual)
      if (lessonIds.length > 0) {
        await supabase
          .from('lesson_access_logs')
          .delete()
          .in('lesson_id', lessonIds)
      }

      // 3. Delete payments (no CASCADE on course_id FK)
      await supabase
        .from('payments')
        .delete()
        .eq('course_id', id)

      // 4. Delete enrollments
      await supabase
        .from('enrollments')
        .delete()
        .eq('course_uuid', id)

      // 5. Delete lessons
      await supabase
        .from('lessons')
        .delete()
        .eq('course_id', id)

      // 6. Delete course_modules
      await supabase
        .from('course_modules')
        .delete()
        .eq('course_id', id)

      // 7. Delete course — telegram_tokens, coupons, email_logs
      //    handled automatically by DB CASCADE / SET NULL
      const { error } = await supabase
        .from('courses')
        .delete()
        .eq('id', id)

      if (error) throw error

      router.push('/dashboard/courses')
    } catch (err: any) {
      alert('Error deleting course: ' + err.message)
    }
    setIsDeleting(false)
  }

  async function sendDelayBroadcast() {
    if (!delayMessage.trim() || broadcastSending) return
    setBroadcastSending(true)
    try {
      const res = await fetch('/api/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ courseId: id, message: delayMessage.trim() }),
      })
      if (res.ok) {
        setBroadcastSent(true)
        setDelayMessage('')
        setTimeout(() => setBroadcastSent(false), 4000)
      }
    } catch { /* non-fatal */ }
    setBroadcastSending(false)
  }


  async function fetchLessons() {
    const { data } = await supabase
      .from('lessons')
      .select('*')
      .eq('course_id', id)
      .order('order_num', { ascending: true })
    setLessons(data || [])
  }

  async function fetchModules() {
    const { data } = await supabase
      .from('course_modules')
      .select('*')
      .eq('course_id', id)
      .order('order_num', { ascending: true })
    setModules(data || [])
  }

  async function deleteLesson(lessonId: string) {
    await supabase.from('lessons').delete().eq('id', lessonId)

    // Renumber remaining lessons to fill gap
    await renumberLessons(supabase, id)

    await fetchLessons()
  }

  function lessonNeedsContent(lesson: Lesson) {
    if (lesson.content_type === 'quiz') {
      return !Array.isArray(lesson.quiz_questions) || lesson.quiz_questions.length === 0
    }

    if (lesson.content_type === 'assignment') {
      return !lesson.assignment_prompt?.trim() && !lesson.assignment_file_url?.trim()
    }

    return false
  }

  async function toggleLessonPublish(lessonId: string, current: boolean) {
    const lesson = lessons.find(item => item.id === lessonId)

    if (!lesson) return

    if (!current && lessonNeedsContent(lesson)) {
      setBlockedPublishLesson(lesson)
      return
    }

    await supabase
      .from('lessons')
      .update({ is_published: !current })
      .eq('id', lessonId)

    await fetchLessons()
  }

  async function publishAllLessons() {
    if (publishingRef.current) return

    const lessonWithoutContent = lessons.find(
      lesson => !lesson.is_published && lessonNeedsContent(lesson)
    )

    if (lessonWithoutContent) {
      setBlockedPublishLesson(lessonWithoutContent)
      return
    }

    publishingRef.current = true
    setPublishing(true)

    try {
      const { error: lessonsError } = await supabase
        .from('lessons')
        .update({ is_published: true })
        .eq('course_id', id)

      if (lessonsError) throw lessonsError

      await fetchLessons()
    } catch (err: any) {
      console.error('Failed to publish all lessons:', err)
      alert(err?.message || 'Failed to publish all lessons. Please try again.')
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }

  async function toggleLessonFree(lessonId: string, current: boolean) {
    await supabase
      .from('lessons')
      .update({ is_free: !current })
      .eq('id', lessonId)
    await fetchLessons()
  }

  async function toggleLessonQA(lessonId: string, current: boolean) {
    await supabase
      .from('lessons')
      .update({ qa_enabled: !current })
      .eq('id', lessonId)
    await fetchLessons()
  }

  async function toggleLessonLastLesson(lessonId: string, current: boolean) {
    if (current) {
      // Unmarking — just clear it. Certificate gate falls back to the
      // course's planned-lessons total, same as before this feature existed.
      await supabase.from('lessons').update({ is_last_lesson: false }).eq('id', lessonId)
    } else {
      // Marking — only one lesson per course can hold this flag, so clear
      // any existing one first (DB has a matching unique index as a backstop).
      await supabase.from('lessons').update({ is_last_lesson: false }).eq('course_id', id).eq('is_last_lesson', true)
      await supabase.from('lessons').update({ is_last_lesson: true }).eq('id', lessonId)
    }
    await fetchLessons()
  }



  async function deleteModule(moduleId: string) {
    await supabase.from('lessons').update({ module_id: null }).eq('module_id', moduleId)
    await supabase.from('course_modules').delete().eq('id', moduleId)
    await fetchModules()
    await fetchLessons()
    setDeletingModule(null)
  }

  async function toggleCoursePublish() {
    if (!course) return
    const newState = !course.is_published
    // Only going draft → live needs an active plan; taking a live course
    // back to draft is always allowed, no gate needed. No alert()/forced
    // redirect here — the card above the toggle already explains this
    // and links to /upgrade before the creator even tries to click.
    if (newState && !hasActivePaidPlan) {
      return
    }
    await supabase
      .from('courses')
      .update({ is_published: newState })
      .eq('id', id)
    setCourse({ ...course, is_published: newState })
  }

  async function toggleUsesExternalLandingPage() {
    if (!course) return
    const newState = !course.uses_external_landing_page
    await supabase
      .from('courses')
      .update({ uses_external_landing_page: newState })
      .eq('id', id)
    setCourse({ ...course, uses_external_landing_page: newState })
  }

  // Moving a lesson between modules by dragging was removed — it left
  // order_num out of sync with what students actually received. Instead,
  // creators change a lesson's number directly, and the whole course gets
  // renumbered around it (see below). A lesson's module is now entirely
  // determined by which module's number-range it falls into.
  async function moveLessonToNumber(lesson: Lesson, rawNewNumber: string): Promise<{ ok: boolean; error?: string }> {
    const parsed = parseInt(rawNewNumber, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      return { ok: false, error: 'Enter a valid lesson number (1 or higher).' }
    }

    // Fetch a fresh, authoritative snapshot — not React state — so this is
    // correct even if the page has been open a while or another tab changed it.
    const { data: allLessons, error: fetchError } = await supabase
      .from('lessons')
      .select('id, order_num, module_id')
      .eq('course_id', id)
      .order('order_num', { ascending: true })

    if (fetchError || !allLessons) return { ok: false, error: 'Could not load lessons to reorder.' }

    const total = allLessons.length
    const newPos = Math.min(Math.max(parsed, 1), total)
    const oldIndex = allLessons.findIndex(l => l.id === lesson.id)
    if (oldIndex === -1) return { ok: false, error: 'Lesson not found.' }
    if (newPos === oldIndex + 1) return { ok: true } // already at that position

    const moved = allLessons[oldIndex]
    const withoutMoved = allLessons.filter(l => l.id !== lesson.id)
    const insertIndex = Math.min(newPos - 1, withoutMoved.length)

    // The lesson takes on whichever module its new neighbors belong to —
    // modules are just contiguous ranges over this same ordered list.
    const neighborBefore = withoutMoved[insertIndex - 1]
    const neighborAfter = withoutMoved[insertIndex]
    const newModuleId = neighborBefore?.module_id ?? neighborAfter?.module_id ?? moved.module_id ?? null

    const finalOrder = [...withoutMoved]
    finalOrder.splice(insertIndex, 0, { ...moved, module_id: newModuleId })

    const updates = finalOrder
      .map((l, idx) => ({
        id: l.id,
        order_num: idx + 1,
        module_id: l.id === lesson.id ? newModuleId : l.module_id,
      }))
      .filter(u => {
        const original = allLessons.find(l => l.id === u.id)!
        return original.order_num !== u.order_num || original.module_id !== u.module_id
      })

    if (updates.length === 0) return { ok: true }

    const { error } = await applyLessonReorder(supabase, updates)
    if (error) return { ok: false, error }

    await fetchLessons()
    return { ok: true }
  }

  function copyCourseLink() {
    if (!course) return
    const url = `${window.location.origin}/about-course/${slugify(course.host_name || 'instructor')}/${slugify(course.name)}/${course.id}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  function copyCheckoutLink() {
    if (!course) return
    const url = `${window.location.origin}/enroll/${course.id}`
    navigator.clipboard.writeText(url)
    setCopiedCheckout(true)
    setTimeout(() => setCopiedCheckout(false), 2500)
  }

  function embedSnippet() {
    if (!course) return ''
    const label = course.is_free_course ? 'Enroll Free' : `Enroll Now — ₹${Number(course.price).toLocaleString('en-IN')}`
    return `<button data-kurso-course="${course.id}" style="background:#f79514;color:#fff;border:none;padding:14px 28px;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;">
  ${label}
</button>
<script src="${window.location.origin}/kurso-embed.js" defer></script>`
  }

  function copyEmbedSnippet() {
    if (!course) return
    navigator.clipboard.writeText(embedSnippet())
    setCopiedEmbed(true)
    setTimeout(() => setCopiedEmbed(false), 2500)
  }

  const publishedCount = lessons.filter(l => l.is_published).length
  const allPublished = lessons.length > 0 && publishedCount === lessons.length
  const plannedTotal = Math.max(course?.total_lessons || 0, lessons.length)
  const remainingLessons = Math.max(plannedTotal - publishedCount, 0)
  const courseUrl = course ? `${window.location.origin}/about-course/${slugify(course.host_name || 'instructor')}/${slugify(course.name)}/${course.id}` : ''
  const checkoutUrl = course ? `${window.location.origin}/enroll/${course.id}` : ''

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-8 h-8 violet-gradient rounded-lg animate-pulse-glow" />
      </div>
    )
  }

  if (!course) return null

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />

      {showAddModal && (
        <AddLessonModal
          onClose={() => {
            setShowAddModal(false)
            setSelectedModuleForLesson('')
          }}
          onAdd={fetchLessons}
          courseId={id}
          creatorId={creatorId}
          nextOrder={lessons.length + 1}
          modules={modules}

          initialModuleId={selectedModuleForLesson}
          initialType={addContentType}
        />
      )}


      {showModuleModal && (
        <AddModuleModal
          onClose={() => setShowModuleModal(false)}
          onAdd={fetchModules}
          courseId={id}
          nextOrder={modules.length + 1}
        />
      )}
      {deletingModule && (
        <DeleteModuleModal
          module={deletingModule}
          onConfirm={() => deleteModule(deletingModule.id)}
          onClose={() => setDeletingModule(null)}
        />
      )}
      {blockedPublishLesson && (
        <AddContentBeforePublishModal
          lesson={blockedPublishLesson}
          onClose={() => setBlockedPublishLesson(null)}
        />
      )}

      <main className="md:ml-56 p-6 md:p-8 pt-20 md:pt-8">


        {/* Deletion Modal */}
        {showDeleteModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(12px)' }}>
            <div className="w-full max-w-md rounded-2xl p-8"
              style={{ background: '#0a0a0a', border: '1px solid rgba(239,68,68,0.3)' }}>
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
                style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <Trash2 className="w-8 h-8 text-red-500" />
              </div>
              <h2 className="text-2xl font-bold text-white text-center mb-2">Delete Course Permanently?</h2>
              <p className="text-sm text-zinc-400 text-center mb-6">
                This will permanently delete the course <strong className="text-white">"{course.name}"</strong> and all its data. This action cannot be undone.
              </p>

              <div className="mb-6">
                <p className="text-xs text-zinc-500 mb-2 uppercase font-bold tracking-widest">Type course name to confirm:</p>
                <input
                  type="text"
                  value={deleteInput}
                  onChange={e => setDeleteInput(e.target.value)}
                  placeholder={course.name}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white outline-none focus:border-red-500/50"
                />
              </div>

              <div className="flex gap-3">
                <button onClick={() => { setShowDeleteModal(false); setDeleteInput('') }}
                  className="flex-1 py-3 rounded-xl text-sm font-bold text-zinc-400 bg-white/5 hover:bg-white/10 transition-all">
                  Cancel
                </button>
                <button onClick={handleDeleteCourse}
                  disabled={deleteInput !== course.name || isDeleting}
                  className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-red-500 hover:bg-red-600 disabled:opacity-30 transition-all">
                  {isDeleting ? 'Deleting...' : 'Delete Permanently'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-start gap-4 mb-8">
          <button onClick={() => router.push('/dashboard/courses')}
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
            style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa' }}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-white truncate">{course.name}</h1>
              <span className="text-xs px-2.5 py-1 rounded-full font-medium"
                style={{
                  background: course.is_published ? 'rgba(74,222,128,0.1)' : 'rgba(51, 50, 50, 0.05)',
                  color: course.is_published ? '#4ade80' : '#f1f1f4',
                  border: course.is_published ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(167, 166, 166, 0.08)',
                }}>
                {course.uses_external_landing_page
                  ? (course.is_published ? '● Checkout On' : '○ Checkout Off')
                  : (course.is_published ? '● Live' : '○ Draft')}
              </span>
            </div>
            <div className="flex items-center gap-4 mt-4 border-b border-white/5 overflow-x-auto">
              {([
                { id: 'lessons' as const, label: 'Lessons' },
                { id: 'settings' as const, label: 'Settings' },
                { id: 'landing' as const, label: 'Landing Page' },

              ]).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="px-4 py-2 text-sm font-medium transition-all relative flex-shrink-0 whitespace-nowrap"
                  style={{ color: activeTab === tab.id ? 'var(--kurso-primary-light)' : '#b8b8bb' }}
                >
                  {tab.label}
                  {activeTab === tab.id && (
                    <div className="absolute bottom-0 left-0 w-full h-0.5 bg-[var(--kurso-primary-light)]" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* ── LEFT: Content ── */}
          <div className="lg:col-span-2">
            {activeTab === 'lessons' ? (
              <>
                {/* Content header */}
                <div className="mb-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h2 className="font-semibold text-white">Course Content</h2>
                      <p className="text-xs mt-0.5" style={{ color: '#9c9c9f' }}>
                        {lessons.length} lesson{lessons.length !== 1 ? 's' : ''} · {publishedCount} published
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Add Module */}
                    <button
                      onClick={() => setShowModuleModal(true)}
                      className="flex flex-col items-start p-4 rounded-2xl text-left transition-all hover:opacity-90"
                      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.1)' }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-base">📁</span>
                        <span className="text-sm font-bold text-white">Add Module</span>
                        <Plus className="w-3.5 h-3.5 ml-auto flex-shrink-0" style={{ color: 'var(--kurso-primary-light)' }} />
                      </div>
                      <p className="text-xs mb-3" style={{ color: '#71717a' }}>Group lessons into weeks or topics</p>
                      <div className="flex flex-col gap-1 w-full text-[10px]">
                        <div className="px-2 py-1 rounded font-semibold" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.18)', color: 'var(--kurso-primary-lighter)' }}>📁 Module 1</div>
                        <div className="ml-3 px-2 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: '#52525b' }}>↳ Lesson · Lesson · ···</div>
                        <div className="px-2 py-1 rounded font-semibold mt-0.5" style={{ background: 'rgba(var(--kurso-primary-rgb), 0.08)', color: '#52525b' }}>📁 Module 2</div>
                        <div className="ml-3 px-2 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.03)', color: '#3f3f46' }}>↳ Lesson · ···</div>
                      </div>
                    </button>

                    {/* Add Lesson */}
                    <div className="flex flex-col gap-1.5">
                      <p className="text-[12px] font-bold uppercase tracking-wider px-1" style={{ color: '#a7a7ab' }}>Add Lesson</p>
                      {([
                        { label: 'Video', icon: '🎬', type: 'video' as const },
                        { label: 'PDF', icon: '📄', type: 'pdf' as const },
                        { label: 'Live Session', icon: '📡', type: 'live' as const },
                        { label: 'Quiz', icon: '🧠', type: 'quiz' as const },
                        { label: 'Assignment', icon: '📝', type: 'assignment' as const },
                      ]).map((btn, i) => (
                        <button key={i}
                          onClick={() => { setAddContentType(btn.type); setShowAddModal(true) }}
                          className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 text-left w-full"
                          style={{ background: 'rgba(255,255,255,0.04)', color: '#e4e4e7', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <span>{btn.icon}</span> {btn.label}
                        </button>
                      ))}
                    </div>

                  </div>
                </div>


                <LandingSectionToggle
                  type="curriculum"
                  label="Show lesson names, module names & module details on your landing page."
                />

                {/* Keep students engaged while you're still uploading */}
                <p className="text-sm mb-6" style={{ color: '#fff' }}>
                  Haven&apos;t uploaded or published all your lessons yet?{' '}
                  <span style={{ color: 'var(--kurso-hint)' }}>
                    Set a message for when the next lesson will be available, so students aren&apos;t left guessing and stay engaged. For example, if you&apos;ve published lessons 1–5 and are still working on more, go set an availability message for Lesson 6. If some of 1–5 aren&apos;t published yet instead, add a note for the first unpublished one telling students when it&apos;ll be ready.
                  </span>{' '}
                  <Link href="/dashboard/broadcast" className="underline" style={{ color: 'var(--kurso-hint)' }}>
                    Go to Broadcast to set it up →
                  </Link>
                </p>

                {/* Release schedule (drip) */}
                {course && (
                  <ReleaseScheduleCard
                    courseId={id}
                    mode={normalizeDeliveryMode(course.delivery_mode)}
                    unlockTime={normalizeUnlockTime(course.delivery_unlock_time)}
                    onChange={next => setCourse(prev => (prev ? { ...prev, ...next } : prev))}
                  />
                )}

                {/* Release calendar: shared month grid (fixed dates) or per-student timeline (drip) */}
                {course && (
                  <ReleaseCalendar
                    mode={normalizeDeliveryMode(course.delivery_mode)}
                    unlockTime={normalizeUnlockTime(course.delivery_unlock_time)}
                    modules={modules}
                    onSaved={fetchModules}
                    onJumpToModule={moduleId => {
                      const el = document.getElementById(`module-${moduleId}`)
                      if (!el) return
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      el.style.outline = '2px solid var(--kurso-primary)'
                      setTimeout(() => { el.style.outline = '' }, 1600)
                    }}
                  />
                )}

                {/* Lesson list */}
                {lessons.length === 0 && modules.length === 0 ? (
                  <div className="rounded-2xl p-12 text-center glass"
                    style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                    <Video className="w-10 h-10 mx-auto mb-3" style={{ color: '#3f3f46' }} />
                    <p className="text-sm font-medium text-white mb-1">No lessons yet</p>
                    <p className="text-xs mb-4" style={{ color: '#52525b' }}>
                      Add your first lesson to get started
                    </p>
                    <button onClick={() => setShowAddModal(true)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white violet-gradient hover:opacity-90">
                      <Plus className="w-4 h-4" />Add Lesson 1
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {modules.map(module => {
                      const moduleLessons = lessons.filter(lesson => lesson.module_id === module.id)
                      return (
                        <div key={module.id} id={`module-${module.id}`} className="rounded-2xl p-4 transition-all"
                          style={{ background: 'rgba(255,255,255,0.015)', border: '1px solid rgba(255,255,255,0.06)' }}>
                          <div className="flex items-center justify-between mb-3 gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-white truncate">{module.name}</h3>
                                <button
                                  onClick={() => setDeletingModule(module)}
                                  className="w-6 h-6 flex items-center justify-center rounded flex-shrink-0"
                                  style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}
                                  title="Delete module">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              <p className="text-xs mt-0.5" style={{ color: '#a6a6ab' }}>
                                {moduleLessons.length} lesson{moduleLessons.length !== 1 ? 's' : ''}
                              </p>
                            </div>
                            <button onClick={() => {
                              setSelectedModuleForLesson(module.id)
                              setShowAddModal(true)
                            }}
                              className="text-xs px-3 py-1.5 rounded-lg flex-shrink-0"
                              style={{ background: 'rgba(var(--kurso-primary-rgb), 0.12)', color: 'var(--kurso-primary-light)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                              + Lesson
                            </button>
                          </div>

                          <ModuleDetailsEditor mod={module} onSaved={fetchModules} />

                          <ModuleReleaseControl
                            moduleId={module.id}
                            mode={normalizeDeliveryMode(course?.delivery_mode)}
                            unlockDate={module.unlock_date}
                            unlockAfterDays={module.unlock_after_days}
                            defaultTime={normalizeUnlockTime(course?.delivery_unlock_time)}
                            onSaved={fetchModules}
                          />

                          <div className="flex flex-col gap-3">
                            {moduleLessons.length === 0 ? (
                              <p className="text-xs py-3" style={{ color: '#52525b' }}>No lessons in this module yet.</p>
                            ) : moduleLessons.map(lesson => (
                              <LessonWidget
                                key={lesson.id}
                                lesson={lesson}
                                onDelete={deleteLesson}
                                onTogglePublish={toggleLessonPublish}
                                onToggleFree={toggleLessonFree}
                                onToggleQA={toggleLessonQA}
                                onToggleLastLesson={toggleLessonLastLesson}
                                onRefresh={fetchLessons}
                                onRenumber={moveLessonToNumber}
                              />
                            ))}
                          </div>
                        </div>
                      )
                    })}

                    <div className="flex flex-col gap-3 min-h-[50px]">
                      {lessons.filter(lesson => !lesson.module_id).map(lesson => (
                        <LessonWidget
                          key={lesson.id}
                          lesson={lesson}
                          onDelete={deleteLesson}
                          onTogglePublish={toggleLessonPublish}
                          onToggleFree={toggleLessonFree}
                          onToggleQA={toggleLessonQA}
                          onToggleLastLesson={toggleLessonLastLesson}
                          onRefresh={fetchLessons}
                          onRenumber={moveLessonToNumber}
                        />
                      ))}
                    </div>

                    {/* Add next lesson */}
                    <button onClick={() => setShowAddModal(true)}
                      className="flex items-center justify-center gap-2 py-3 rounded-2xl text-sm transition-all"
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px dashed rgba(255,255,255,0.1)',
                        color: '#52525b',
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.borderColor = 'rgba(var(--kurso-primary-rgb), 0.4)'
                        e.currentTarget.style.color = 'var(--kurso-primary-light)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                        e.currentTarget.style.color = '#a9a9ae'
                      }}>
                      <Plus className="w-4 h-4" />
                      Add Lesson {lessons.length + 1}
                    </button>

                    {/* Publish all */}
                    {!allPublished && lessons.length > 0 && (
                      <button onClick={publishAllLessons} disabled={publishing}
                        className="flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-medium transition-all disabled:opacity-50"
                        style={{
                          background: 'rgba(74,222,128,0.08)',
                          border: '1px solid rgba(74,222,128,0.2)',
                          color: '#4ade80',
                        }}>
                        <CheckCircle className="w-4 h-4" />
                        {publishing ? 'Publishing...' : `Publish All ${lessons.length} Lessons`}
                      </button>
                    )}

                    {allPublished && (
                      <div className="flex items-center gap-2 p-3 rounded-xl"
                        style={{ background: 'rgba(74,222,128,0.06)', border: '1px solid rgba(74,222,128,0.15)' }}>
                        <CheckCircle className="w-4 h-4" style={{ color: '#4ade80' }} />
                        <p className="text-sm" style={{ color: '#4ade80' }}>
                          All lessons published
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </>

            ) : activeTab === 'settings' ? (
              <div className="flex flex-col gap-5">
                <div className="rounded-2xl p-6 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between gap-4 mb-5">
                    <h2 className="font-semibold text-white">Delivery Method</h2>
                    {savingDelivery && <span className="text-xs" style={{ color: 'var(--kurso-primary-light)' }}>Saving…</span>}
                  </div>
                  <DeliveryMethodPicker
                    value={settingsDelivery}
                    onChange={setSettingsDelivery}
                    currentPlanId={effectivePlanId}
                    onUpgraded={(newPlanId) => setEffectivePlanId(newPlanId)}
                    disabled={savingDelivery}
                  />

                  {/* this is the toggle for applying the delivery method to existing students. It is currently commented out, but you can uncomment it if you want to allow users to apply the delivery method to existing students.
                  this is my (Nivan/Nancy) decision to keep it commented out for now.   */}
                  {/* <label
                    className="flex items-start gap-3 mt-5 p-4 rounded-xl cursor-pointer"
                    style={{
                      background: 'rgba(250,204,21,0.06)',
                      border: '1px solid rgba(250,204,21,0.2)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={applyDeliveryToEnrolled}
                      onChange={e => setApplyDeliveryToEnrolled(e.target.checked)}
                      className="mt-0.5"
                    />

                    <span className="text-xs" style={{ color: '#fde68a' }}>
                      <span className="font-semibold block mb-1">
                        Also apply to existing students
                      </span>

                      <span className="block">
                        Existing students keep their current access either way.
                      </span>
                    </span>
                  </label> */}

                  {deliveryError && (
                    <p className="text-xs mt-3 px-3 py-2 rounded-lg" style={{ color: '#f87171', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>{deliveryError}</p>
                  )}
                  {deliverySuccess && (
                    <p className="text-xs mt-3 px-3 py-2 rounded-lg" style={{ color: '#4ade80', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.2)' }}>{deliverySuccess}</p>
                  )}



                  <button onClick={saveDeliveryMethod} disabled={savingDelivery}
                    className="mt-4 px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg, var(--kurso-primary), var(--kurso-primary-light))' }}>
                    {savingDelivery ? 'Saving…' : 'Save Delivery Method'}
                  </button>
                </div>

                <div className="rounded-2xl p-6 glass" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className="mt-3 mb-3 text-sm">You can click course preview in right side and see live how your course landing page is looking and side by side update the information and reload the tab to see your changes.</p>
                  <div className="flex items-center justify-between gap-4 mb-5">
                    <h2 className="font-semibold text-white">Course Settings</h2>
                    <span className="text-xs" style={{ color: savingSettings ? 'var(--kurso-primary-light)' : '#71717a' }}>
                      {savingSettings ? 'Saving changes…' : 'Changes save automatically'}
                    </span>
                  </div>

                  <div className="flex flex-col gap-6">
                    <SettingsGroup
                      title="Course name"
                      description="Shown on the landing page."
                    >
                      <div>

                        <input value={editName} onChange={e => setEditName(e.target.value)}
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
                      </div>
                    </SettingsGroup>

                    {!course.uses_external_landing_page && (
                      <>
                        <SettingsGroup
                          title="Course Description"
                          description="Shown below the course title."
                        >
                          <div>

                            <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={5}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)] resize-none" />
                            <AiFieldAssist
                              field="description" entityType="course"
                              context={{ name: course?.name, description: editDesc, about_creator: editAbout, what_you_will_learn: editLearn.filter(Boolean), target_audience: editTargetAudience?.filter(Boolean) }}
                              currentValue={editDesc}
                              onResult={v => typeof v === 'string' && setEditDesc(v)}
                              className="mt-2"
                            />
                          </div>
                        </SettingsGroup>


                        <SettingsGroup
                          title="Brand / Business Name *"
                          description="Shown in your landing page. Use your registered business name if you have one, otherwise your own name works fine."
                        >
                          <div className="mt-6">

                            <input
                              value={editBrandName}
                              onChange={e => setEditBrandName(e.target.value)}
                              placeholder="Your brand name"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                            />

                          </div>
                        </SettingsGroup>


                      </>
                    )}

                    {!course.uses_external_landing_page && (
                      <>
                        <SettingsGroup
                          title="Quick Stats"
                          description="These values appear together as the Quick Stats section on your landing page."
                        >

                          <div
                            className="rounded-2xl p-5"
                            style={{
                              background: 'rgba(255,255,255,0.02)',
                              border: '1px solid rgba(255,255,255,0.06)',
                            }}
                          >


                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                              <div>
                                <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                                  Duration
                                </label>
                                <input
                                  value={editDuration}
                                  onChange={e => setEditDuration(e.target.value)}
                                  placeholder="4 Weeks"
                                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                                />
                              </div>

                              <div>
                                <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                                  Language
                                </label>
                                <input
                                  value={editLanguage}
                                  onChange={e => setEditLanguage(e.target.value)}
                                  placeholder="English"
                                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                                />
                                <p className="text-xs mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                                  Separate multiple languages with commas.
                                </p>
                              </div>

                              <div>
                                <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                                  Difficulty Level
                                </label>

                                <select
                                  value={editLevel}
                                  onChange={e => setEditLevel(e.target.value)}
                                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none appearance-none cursor-pointer"
                                  style={{
                                    background: '#050505',
                                    color: editLevel ? '#fff' : '#a9a9ae',
                                  }}
                                >
                                  <option value="" style={{ background: '#050505', color: '#52525b' }}>
                                    Select level…
                                  </option>

                                  {['Beginner', 'Intermediate', 'Advanced', 'All Levels'].map(level => (
                                    <option
                                      key={level}
                                      value={level}
                                      style={{ background: '#050505', color: '#fff' }}
                                    >
                                      {level}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <LandingSectionToggle
                              type="stats"
                              label="Show these on your landing page."
                            />
                          </div>
                        </SettingsGroup>
                      </>
                    )}



                    <SettingsGroup
                      title="Course Price"
                      description="Set the amount students pay to enroll in this course."
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-semibold text-zinc-300 mb-2 block">Price (₹)</label>
                          <input
                            value={editIsFreeCourse ? '0' : editPrice}
                            onChange={e => { if (!editIsFreeCourse) setEditPrice(e.target.value) }}
                            type="number"
                            disabled={editIsFreeCourse}
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                          />
                          {editIsFreeCourse && (
                            <p className="text-xs mt-1.5" style={{ color: '#f2bc96' }}>
                              Turn off "Make this course free" below to set a price.
                            </p>
                          )}
                        </div>
                        {!course.uses_external_landing_page && (
                          <>
                            <div>
                              <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                                Original Price (₹)
                                <span className="text-zinc-400 text-sm font-normal ml-2">
                                  — To show discount(like 50% off)
                                </span>
                              </label>
                              <input
                                value={editIsFreeCourse ? '' : editOriginalPrice}
                                onChange={e => { if (!editIsFreeCourse) setEditOriginalPrice(e.target.value) }}
                                type="number"
                                disabled={editIsFreeCourse}
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)] disabled:opacity-40 disabled:cursor-not-allowed"
                              />
                            </div>
                          </>
                        )}

                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-semibold text-zinc-300 mb-2 block">Refund Window (days)</label>
                          <input value={editRefundWindowDays} onChange={e => setEditRefundWindowDays(e.target.value)} type="number"
                            placeholder="7"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
                          <p className="text-base mt-1" style={{ color: 'var(--kurso-hint)' }}>
                            {Number(editRefundWindowDays) > 0
                              ? `Students can request a refund within ${editRefundWindowDays} day${editRefundWindowDays === '1' ? '' : 's'} of enrolling.`
                              : '0 = no refunds accepted'}
                          </p>
                        </div>
                      </div>
                      {/* Make this entire course free toggle */}
                      <div
                        className="flex items-center justify-between gap-4 p-4 rounded-xl"
                        style={{
                          background: editIsFreeCourse ? 'rgba(74,222,128,0.06)' : 'rgba(255,255,255,0.03)',
                          border: editIsFreeCourse ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <div>
                          <p className="text-sm font-semibold text-white">Make this entire course free</p>
                          <p className="text-xs mt-0.5" style={{ color: '#71717a' }}>
                            All lessons accessible without payment. Price is forced to ₹0 on save.
                          </p>
                          {editIsFreeCourse && (
                            <p className="text-xs mt-1" style={{ color: '#f97316' }}>
                              Turn this off to re-enable pricing.
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const next = !editIsFreeCourse
                            setEditIsFreeCourse(next)
                            if (next) {
                              setEditPrice('0')
                              setEditOriginalPrice('')
                            }
                          }}
                          className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
                          style={{ background: editIsFreeCourse ? '#4ade80' : 'rgba(255,255,255,0.12)' }}
                          aria-pressed={editIsFreeCourse}
                        >
                          <span
                            className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                            style={{ transform: editIsFreeCourse ? 'translateX(20px)' : 'translateX(0)' }}
                          />
                        </button>
                      </div>
                    </SettingsGroup>



                    {!course.uses_external_landing_page && (
                      <>
                        <SettingsGroup
                          title="Legal Pages"
                          description="Upload a Refund Policy, Terms &amp; Conditions, and Privacy Policy as a .txt or .md file (max 20KB each).
                        Don't paste one long paragraph — write it as a heading, then a short paragraph, then another heading, and so on. For example:"
                        >
                          <div>

                            <pre className="text-xs mb-4 p-3 rounded-xl whitespace-pre-wrap" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#a5a5a8' }}>
                              {`## Eligibility
Refunds are accepted within 7 days of purchase if you have not accessed more than 2 lessons.

## How to request a refund
Message us on WhatsApp with your order email and we'll process it within 5 business days.`}
                            </pre>

                            <div className="flex flex-col gap-4">
                              {([
                                { type: 'refund' as PolicyDocType, label: 'Refund Policy', path: editRefundPolicyPath },
                                { type: 'terms' as PolicyDocType, label: 'Terms & Conditions', path: editTermsPath },
                                { type: 'privacy' as PolicyDocType, label: 'Privacy Policy', path: editPrivacyPath },
                              ]).map(doc => (
                                <div key={doc.type} className="flex items-center justify-between gap-3 p-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                  <div>
                                    <p className="text-sm font-semibold text-white">{doc.label}</p>
                                    {doc.path ? (
                                      <a href={doc.path} target="_blank" rel="noreferrer" className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)]">View uploaded file</a>
                                    ) : (
                                      <p className="text-xs" style={{ color: '#71717a' }}>No file uploaded yet</p>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <label className="text-xs font-semibold px-3 py-2 rounded-lg cursor-pointer text-white" style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)' }}>
                                      {uploadingPolicyDoc === doc.type ? 'Uploading...' : doc.path ? 'Replace' : 'Upload'}
                                      <input type="file" accept=".txt,.md" className="hidden"
                                        disabled={uploadingPolicyDoc !== null}
                                        onChange={e => handleLegalDocUpload(e, doc.type)} />
                                    </label>
                                    {doc.path && (
                                      <button type="button" onClick={() => handleRemoveLegalDoc(doc.type)}
                                        disabled={uploadingPolicyDoc !== null}
                                        className="text-xs font-semibold px-3 py-2 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-500/10 transition-colors">
                                        Remove
                                      </button>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        </SettingsGroup>
                      </>
                    )}


                    {!course.uses_external_landing_page && (
                      <SettingsGroup
                        title="Enroll button text"
                        description="The words on the Enroll button at the top of your page and in the sticky bar. The big price button ('Enroll for ₹…') and free-course buttons ('Enroll Free') keep their own wording.">
                        <div>
                          <label className="text-sm font-semibold text-zinc-300 mb-2 block">Button text</label>
                          <input
                            value={settingsLandingConfig.enrollButtonText}
                            maxLength={MAX_ENROLL_BUTTON_CHARS}
                            onChange={e => {
                              const value = e.target.value
                              const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0
                              if (wordCount <= MAX_ENROLL_BUTTON_WORDS) {
                                setSettingsLandingConfig(prev => ({ ...prev, enrollButtonText: value }))
                              }
                            }}
                            placeholder={DEFAULT_ENROLL_BUTTON_TEXT}
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
                          <p className="text-xs mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                            Up to {MAX_ENROLL_BUTTON_WORDS} words and {MAX_ENROLL_BUTTON_CHARS} characters ({settingsLandingConfig.enrollButtonText.length}/{MAX_ENROLL_BUTTON_CHARS}). Leave blank to use: "{DEFAULT_ENROLL_BUTTON_TEXT}"
                          </p>
                          {editIsFreeCourse && (
                            <p className="text-xs mt-1.5" style={{ color: 'rgb(237, 152, 128)' }}>
                              This course is free, so its buttons keep saying "Enroll Free" whatever you type here.
                            </p>
                          )}
                        </div>
                      </SettingsGroup>
                    )}

                    {/* Sticky Enroll Bar (Final CTA) toggle — only relevant
                         on Kurso's own hosted landing page; a creator using
                         their own external landing page never sees this
                         page at all, so the toggle would do nothing there. */}

                    {!course.uses_external_landing_page && (
                      <SettingsGroup
                        title="Sticky enroll bar"
                        description="Keeps the price and an Enroll button visible at the bottom of the screen the whole time a student scrolls your landing page."
                      >
                        <div
                          className="flex items-center justify-between gap-4 p-4 rounded-xl"
                          style={{
                            background: isFinalCtaEnabled
                              ? 'rgba(var(--kurso-primary-rgb), 0.06)'
                              : 'rgba(255,255,255,0.03)',
                            border: isFinalCtaEnabled
                              ? '1px solid rgba(var(--kurso-primary-rgb), 0.25)'
                              : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div>
                            <p className="text-sm font-semibold text-white">Sticky enroll bar</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setSettingsLandingConfig(prev => ({
                                ...prev,
                                sections: prev.sections.map(s =>
                                  s.type === 'finalCta' ? { ...s, enabled: !s.enabled } : s
                                ),
                              }))
                            }}
                            className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
                            style={{
                              background: isFinalCtaEnabled
                                ? 'var(--kurso-primary)'
                                : 'rgba(255,255,255,0.12)',
                            }}
                            aria-pressed={!!isFinalCtaEnabled}
                          >
                            <span
                              className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                              style={{
                                transform: isFinalCtaEnabled ? 'translateX(20px)' : 'translateX(0)',
                              }}
                            />
                          </button>
                        </div>

                        {isFinalCtaEnabled && (
                          <div className="mt-3">
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">What should the bar show?</label>
                            <div className="grid grid-cols-2 gap-2">
                              {([
                                { value: 'text', label: 'Static message' },
                                { value: 'countdown', label: 'Countdown timer' },
                              ] as const).map(opt => {
                                const active = settingsLandingConfig.finalCtaMode === opt.value
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => setSettingsLandingConfig(prev => ({ ...prev, finalCtaMode: opt.value }))}
                                    className="py-2.5 rounded-xl text-sm font-medium transition-all"
                                    style={{
                                      background: active ? 'rgba(var(--kurso-primary-rgb), 0.12)' : 'rgba(255,255,255,0.04)',
                                      border: active ? '1px solid rgba(var(--kurso-primary-rgb), 0.35)' : '1px solid rgba(255,255,255,0.1)',
                                      color: active ? 'var(--kurso-primary-light)' : '#a1a1aa',
                                    }}
                                  >
                                    {opt.label}
                                  </button>
                                )
                              })}
                            </div>
                            <p className="text-xs mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                              Static message shows your own text next to the Enroll button. Countdown timer shows a live countdown (and, if you want, how many seats are left) instead.
                            </p>
                          </div>
                        )}

                        {isFinalCtaEnabled && settingsLandingConfig.finalCtaMode === 'text' && (
                          <div className="mt-3">
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">Sticky bar message</label>
                            <input
                              value={settingsLandingConfig.finalCtaText}
                              onChange={e => {
                                const value = e.target.value
                                const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0

                                if (wordCount <= MAX_FINAL_CTA_WORDS) {
                                  setSettingsLandingConfig(prev => ({ ...prev, finalCtaText: value }))
                                }
                              }}
                              placeholder={DEFAULT_FINAL_CTA_TEXT}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                            />
                            <p className="text-xs mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                              Up to 50 words. Shown next to the price on the sticky bar. Leave blank to use: "{DEFAULT_FINAL_CTA_TEXT}"
                            </p>
                          </div>
                        )}

                        {isFinalCtaEnabled && settingsLandingConfig.finalCtaMode === 'countdown' && (
                          <div className="mt-3 flex flex-col gap-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div className="sm:col-span-2">
                                <CountdownEndPicker
                                  value={settingsLandingConfig.urgency.endAt}
                                  onChange={value => updateUrgency('endAt', value)} />
                              </div>
                              <div>
                                <label className="text-[13px] block mb-1.5" style={{ color: '#a1a1aa' }}>Seats available</label>
                                <input type="number" min={0} value={settingsLandingConfig.urgency.seatsAvailable ?? ''}
                                  onChange={e => updateUrgency('seatsAvailable', e.target.value === '' ? null : Math.max(0, parseInt(e.target.value, 10)))}
                                  placeholder="Leave blank to hide"
                                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-600" />
                              </div>
                              <div>
                                <label className="text-[13px] block mb-1.5" style={{ color: '#a1a1aa' }}>Seats label</label>
                                <input value={settingsLandingConfig.urgency.seatsLabel} onChange={e => updateUrgency('seatsLabel', e.target.value)}
                                  placeholder="seats left at this price" maxLength={30}
                                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-600" />
                              </div>
                            </div>
                            <p className="text-xs" style={{ color: 'var(--kurso-hint)' }}>
                              Fill in an end time, a seats number, or both. Leave seats blank to hide it. When the countdown ends (or nothing is filled in), the bar goes back to your static message.
                            </p>
                            {settingsLandingConfig.urgency.endAt && new Date(settingsLandingConfig.urgency.endAt).getTime() <= Date.now() && (
                              <p className="text-sm" style={{ color: 'rgb(237, 152, 128)' }}>
                                ⚠ This date is the past date — the countdown won't show on the live page until you set a future date.
                              </p>
                            )}
                          </div>
                        )}

                        {isFinalCtaEnabled && (
                          <div className="mt-3">
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">Sticky bar button text</label>
                            <input
                              value={settingsLandingConfig.finalCtaButtonText}
                              maxLength={MAX_ENROLL_BUTTON_CHARS}
                              onChange={e => {
                                const value = e.target.value
                                const wordCount = value.trim() ? value.trim().split(/\s+/).length : 0
                                if (wordCount <= MAX_ENROLL_BUTTON_WORDS) {
                                  setSettingsLandingConfig(prev => ({ ...prev, finalCtaButtonText: value }))
                                }
                              }}
                              placeholder={settingsLandingConfig.enrollButtonText || DEFAULT_ENROLL_BUTTON_TEXT}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
                            <p className="text-xs mt-1.5" style={{ color: 'var(--kurso-hint)' }}>
                              Only for the button in this bar ({settingsLandingConfig.finalCtaButtonText.length}/{MAX_ENROLL_BUTTON_CHARS}). Leave blank to use your button text above.
                            </p>
                          </div>
                        )}
                      </SettingsGroup>
                    )}


                    {!course.uses_external_landing_page && (
                      <>
                        <SettingsGroup
                          title="Course Launch Date"
                          description="Just shown on the landing page. If you are not sure leave it blank."
                        >
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>

                              <input value={editStartDate} onChange={e => setEditStartDate(e.target.value)}
                                placeholder="15th May 2026"
                                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />

                            </div>
                          </div>
                        </SettingsGroup>


                        <SettingsGroup
                          title="Certificate Skills"
                          description="Shown on the certificate."
                        >
                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">Seperate skills by comma.</label>
                            <input value={editSkills} onChange={e => setEditSkills(e.target.value)}
                              placeholder="e.g. SEO, Content Marketing, Keyword Research"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)] " />
                          </div>
                        </SettingsGroup>

                        <SettingsGroup
                          title="What You'll Walk Away With"
                          description="Add points summarizing what students will gain from the course."
                        >
                          <LandingSectionToggle type="learn" />
                          <div>

                            <div className="flex flex-col gap-2">
                              {editLearn.map((item, i) => (
                                <div key={i} className="flex gap-2">
                                  <input value={item} onChange={e => {
                                    const next = [...editLearn]; next[i] = e.target.value; setEditLearn(next)
                                  }} className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white outline-none" />
                                  <button onClick={() => setEditLearn(editLearn.filter((_, idx) => idx !== i))}
                                    className="p-2 text-zinc-500 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                                </div>
                              ))}
                              <button onClick={() => setEditLearn([...editLearn, ''])}
                                className="text-sm text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add Point</button>
                              <AiFieldAssist
                                field="what_you_will_learn" entityType="course"
                                context={{ name: course?.name, description: editDesc, what_you_will_learn: editLearn.filter(Boolean) }}
                                currentValue={editLearn.filter(Boolean)}
                                onResult={v => Array.isArray(v) && setEditLearn(v as string[])}
                                className="mt-1"
                              />
                            </div>
                          </div>
                        </SettingsGroup>



                        <SettingsGroup
                          title="Requirements / Prerequisites"
                          description="What students need to know or have before taking this course."
                        >
                          <LandingSectionToggle type="requirements" />


                          <div className="flex flex-col gap-2">
                            {editRequirements.map((item, i) => (
                              <div key={i} className="flex gap-2">
                                <input
                                  value={item}
                                  onChange={e => { const n = [...editRequirements]; n[i] = e.target.value; setEditRequirements(n) }}
                                  placeholder="e.g. Basic computer skills"
                                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white outline-none"
                                />
                                <button onClick={() => setEditRequirements(editRequirements.filter((_, idx) => idx !== i))}
                                  className="p-2 text-zinc-500 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            ))}
                            <button onClick={() => setEditRequirements([...editRequirements, ''])}
                              className="text-sm text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add Requirement</button>
                          </div>
                        </SettingsGroup>

                        <SettingsGroup
                          title="Mentor/Coach"
                          description="The person/people who will be teaching this course."
                        >

                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">Mentor Photo</label>
                            <div className="flex items-center gap-4">
                              <div className="w-16 h-16 rounded-xl overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center">
                                {editHostImage ? (
                                  <img src={editHostImage} alt="Mentor" className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-2xl font-bold text-zinc-700">
                                    {editHostName ? editHostName.charAt(0).toUpperCase() : '?'}
                                  </span>
                                )}
                              </div>
                              <div className="flex-1">
                                <input
                                  type="file"
                                  id="host-image"
                                  className="hidden"
                                  accept="image/*"
                                  onChange={handleImageUpload}
                                  disabled={uploadingImage}
                                />
                                <label
                                  htmlFor="host-image"
                                  className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10 transition-all"
                                >
                                  {uploadingImage ? 'Uploading...' : editHostImage ? 'Change Photo' : 'Upload Photo'}
                                </label>
                                {editHostImage && (
                                  <button
                                    type="button"
                                    onClick={() => setEditHostImage('')}
                                    className="ml-2 text-xs text-zinc-400 hover:text-red-500"
                                  >
                                    Remove
                                  </button>
                                )}
                                <p className="text-[14px] text-zinc-400 mt-1.5"> JPG/PNG (max 2MB)</p>
                              </div>
                            </div>
                          </div>

                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block" >About Mentor</label>
                            <input value={editHostName} onChange={e => setEditHostName(e.target.value)} placeholder="Name"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none mb-2" />
                            <input
                              value={editInstructorTitle}
                              onChange={e => setEditInstructorTitle(e.target.value)}
                              placeholder="Mentor title, e.g. Senior Data Scientist"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none mb-2"
                            />
                            <textarea value={editAbout} onChange={e => setEditAbout(e.target.value)} rows={5} placeholder="Bio"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none resize-none" />
                            <AiFieldAssist
                              field="about_creator" entityType="course"
                              context={{ name: course?.name, description: editDesc, hostName: editHostName, instructor_title: editInstructorTitle, about_creator: editAbout }}
                              currentValue={editAbout}
                              onResult={v => typeof v === 'string' && setEditAbout(v)}
                              className="mt-2"
                            />
                          </div>

                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                              Mentor card layout
                            </label>

                            <p className="text-xs mb-3" style={{ color: 'var(--kurso-hint)' }}>
                              Choose how mentor cards appear on your landing page.
                            </p>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {([
                                {
                                  value: 'square' as const,
                                  title: 'Square cards',
                                  description: 'Compact cards displayed side by side.',
                                },
                                {
                                  value: 'rectangle' as const,
                                  title: 'Rectangle cards',
                                  description: 'Wide cards with more room for the biography.',
                                },
                              ]).map(option => {
                                const selected =
                                  settingsLandingConfig.instructorLayout === option.value

                                return (
                                  <button
                                    key={option.value}
                                    type="button"
                                    onClick={() =>
                                      setSettingsLandingConfig(previous => ({
                                        ...previous,
                                        instructorLayout: option.value,
                                      }))
                                    }
                                    className="p-4 rounded-xl text-left transition-all"
                                    style={{
                                      background: selected
                                        ? 'rgba(var(--kurso-primary-rgb), 0.1)'
                                        : 'rgba(255,255,255,0.03)',
                                      border: selected
                                        ? '1px solid rgba(var(--kurso-primary-rgb), 0.35)'
                                        : '1px solid rgba(255,255,255,0.08)',
                                    }}
                                  >
                                    <p className="text-sm font-semibold text-white">
                                      {option.title}
                                    </p>
                                    <p
                                      className="text-xs mt-1"
                                      style={{ color: 'var(--kurso-hint)' }}
                                    >
                                      {option.description}
                                    </p>
                                  </button>
                                )
                              })}
                            </div>
                          </div>

                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                              Additional Mentors
                              <span className="text-zinc-400 font-normal ml-1 ">— optional, for co-taught courses</span>
                            </label>
                            <CoInstructorsEditor
                              value={editCoInstructors}
                              onChange={setEditCoInstructors}
                              onUpload={async file => {
                                const { publicUrl } = await uploadToSupabase(file, 'images')
                                return publicUrl
                              }}
                            />
                          </div>
                        </SettingsGroup>

                        {/* Promo videos */}
                        <SettingsGroup
                          title="Promo / Preview Videos"
                          description="Shown on your landing page. You can add up to 3 videos from YouTube or Vimeo."
                        >
                          <LandingSectionToggle type="videos" />
                          <div>
                            <label className="text-sm font-semibold text-zinc-300 mb-2 block">
                              Section Heading
                              <span
                                className="font-normal ml-1"
                                style={{ color: 'var(--kurso-hint)' }}
                              >— shown above the videos on your landing page (optional)</span>

                            </label>
                            <input value={editPromoVideoHeading} onChange={e => setEditPromoVideoHeading(e.target.value)}
                              placeholder="e.g. See what you'll be learning"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)] mb-4" />

                            <div className="flex flex-col gap-2">
                              {editPromoVideoUrls.map((url, i) => (
                                <div key={i} className="flex gap-2">
                                  <input value={url}
                                    onChange={e => { const n = [...editPromoVideoUrls]; n[i] = e.target.value; setEditPromoVideoUrls(n) }}
                                    placeholder="https://youtube.com/watch?v=... or https://vimeo.com/..."
                                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]" />
                                  <button onClick={() => setEditPromoVideoUrls(editPromoVideoUrls.filter((_, idx) => idx !== i))}
                                    className="p-2 text-zinc-500 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                                </div>
                              ))}
                              {editPromoVideoUrls.length < 3 && (
                                <button onClick={() => setEditPromoVideoUrls([...editPromoVideoUrls, ''])}
                                  className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add video</button>
                              )}
                            </div>
                          </div>
                        </SettingsGroup>


                        {/* Target audience */}
                        <SettingsGroup
                          title="Who Is This Course For?"
                          description="Specify the ideal student profile for this course."
                        >
                          <LandingSectionToggle type="target" />


                          <div className="flex flex-col gap-2">
                            {editTargetAudience.map((item, i) => (
                              <div key={i} className="flex gap-2">
                                <input value={item}
                                  onChange={e => { const n = [...editTargetAudience]; n[i] = e.target.value; setEditTargetAudience(n) }}
                                  placeholder="e.g. Beginners who want to start with digital marketing"
                                  className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white outline-none" />
                                <button onClick={() => setEditTargetAudience(editTargetAudience.filter((_, idx) => idx !== i))}
                                  className="p-2 text-zinc-500 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
                              </div>
                            ))}
                            <button onClick={() => setEditTargetAudience([...editTargetAudience, ''])}
                              className="text-sm text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add Audience</button>
                          </div>

                        </SettingsGroup>

                        {/* Testimonials */}
                        <SettingsGroup
                          title="Student Testimonials"
                          description="Showcase what students are saying about your course."
                        >
                          <LandingSectionToggle type="testimonials" />
                          <div>

                            <p className="text-sm text-zinc-400 mb-5" style={{ color: 'var(--kurso-hint)' }}>Click the previous star to remove next star rating. e.g. if all  stars are filled then click 4th star to remove 5th star rating and for 4th star click 3rd star and so on.</p>

                            <div className="flex flex-col gap-3">
                              {editTestimonials.map((t, i) => (
                                <div key={i} className="p-4 rounded-xl relative flex flex-col gap-2"
                                  style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                                  <button onClick={() => setEditTestimonials(editTestimonials.filter((_, idx) => idx !== i))}
                                    className="absolute top-4 right-4 text-zinc-600 hover:text-red-500 transition-colors">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>

                                  <div className="flex gap-2 mb-1">
                                    <button type="button"
                                      onClick={() => { const n = [...editTestimonials]; n[i] = { type: 'written', name: '', text: '', rating: 5 }; setEditTestimonials(n) }}
                                      className="text-xs px-2.5 py-1 rounded-lg font-medium"
                                      style={{ background: t.type === 'written' ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.05)', color: t.type === 'written' ? '#fff' : 'var(--kurso-hint)' }}>
                                      Written
                                    </button>
                                    <button type="button"
                                      onClick={() => { const n = [...editTestimonials]; n[i] = { type: 'screenshot', image_url: '' }; setEditTestimonials(n) }}
                                      className="text-xs px-2.5 py-1 rounded-lg font-medium"
                                      style={{ background: t.type === 'screenshot' ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.05)', color: t.type === 'screenshot' ? '#fff' : 'var(--kurso-hint)' }}>
                                      Screenshot
                                    </button>
                                  </div>

                                  {t.type === 'written' ? (
                                    <>
                                      <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-full overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                                          {t.photo_url ? (
                                            <img src={t.photo_url} alt={t.name || 'Student'} className="w-full h-full object-cover" />
                                          ) : (
                                            <span className="text-sm font-bold text-zinc-700">{t.name ? t.name.charAt(0).toUpperCase() : '?'}</span>
                                          )}
                                        </div>
                                        <input
                                          type="file"
                                          id={`testimonial-photo-${i}`}
                                          className="hidden"
                                          accept="image/jpeg,image/png"
                                          onChange={e => { const file = e.target.files?.[0]; if (file) handleTestimonialFileUpload(i, 'photo', file); e.target.value = '' }}
                                          disabled={uploadingTestimonialIndex === i}
                                        />
                                        <label htmlFor={`testimonial-photo-${i}`}
                                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10 transition-all">
                                          {uploadingTestimonialIndex === i ? 'Uploading...' : 'Upload student photo (optional)'}
                                        </label>
                                      </div>
                                      <input value={t.name}
                                        onChange={e => { const n = [...editTestimonials]; n[i] = { ...n[i], name: e.target.value } as Testimonial; setEditTestimonials(n) }}
                                        placeholder="Student name"
                                        className="w-full bg-transparent text-sm text-white font-medium outline-none pr-8" />
                                      <textarea value={t.text}
                                        onChange={e => { const n = [...editTestimonials]; n[i] = { ...n[i], text: e.target.value } as Testimonial; setEditTestimonials(n) }}
                                        placeholder="What they said about the course..."
                                        rows={2}
                                        className="w-full bg-transparent text-sm text-zinc-300 outline-none resize-none" />
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm text-zinc-300">Rating:</span>
                                        {[1, 2, 3, 4, 5].map(star => (
                                          <button key={star} type="button"
                                            onClick={() => { const n = [...editTestimonials]; n[i] = { ...n[i], rating: star } as Testimonial; setEditTestimonials(n) }}
                                            style={{ color: star <= (t.rating || 5) ? 'var(--kurso-accent)' : '#3f3f46', fontSize: 18, background: 'none', border: 'none', cursor: 'pointer', padding: '0 1px' }}>★</button>
                                        ))}
                                        <span className="text-sm text-zinc-400 ml-2">({t.rating || 5}/5)</span>
                                      </div>
                                    </>
                                  ) : (
                                    <div className="flex flex-col gap-2">
                                      {t.image_url ? (
                                        <img src={t.image_url} alt="Testimonial screenshot" className="w-full max-w-xs rounded-lg border border-white/10" />
                                      ) : null}
                                      <input
                                        type="file"
                                        id={`testimonial-screenshot-${i}`}
                                        className="hidden"
                                        accept="image/jpeg,image/png"
                                        onChange={e => { const file = e.target.files?.[0]; if (file) handleTestimonialFileUpload(i, 'screenshot', file); e.target.value = '' }}
                                        disabled={uploadingTestimonialIndex === i}
                                      />
                                      <label htmlFor={`testimonial-screenshot-${i}`}
                                        className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10 transition-all w-fit">
                                        {uploadingTestimonialIndex === i ? 'Uploading...' : t.image_url ? 'Replace screenshot' : 'Upload screenshot'}
                                      </label>
                                    </div>
                                  )}
                                </div>
                              ))}
                              {testimonialUploadError && <p className="text-xs text-red-500">{testimonialUploadError}</p>}
                              {editTestimonials.length < MAX_TESTIMONIALS ? (
                                <button onClick={() => setEditTestimonials([...editTestimonials, { type: 'written', name: '', text: '', rating: 5 }])}
                                  className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add Testimonial</button>
                              ) : (
                                <p className="text-xs text-zinc-500">Maximum of {MAX_TESTIMONIALS} testimonials reached (written + screenshot combined).</p>
                              )}
                            </div>
                          </div>
                        </SettingsGroup>


                        <SettingsGroup
                          title="Ratings & Reviews"
                          description="Students can rate your course after completing it (once their certificate is issued). Manage replies and flag reviews from the Ratings & Reviews page in your dashboard sidebar."
                        >
                          <div
                            className="flex items-center justify-between gap-4 p-4 rounded-xl"
                            style={{
                              background: editRatingsEnabledOnLanding
                                ? 'rgba(var(--kurso-primary-rgb), 0.06)'
                                : 'rgba(255,255,255,0.03)',
                              border: editRatingsEnabledOnLanding
                                ? '1px solid rgba(var(--kurso-primary-rgb), 0.25)'
                                : '1px solid rgba(255,255,255,0.08)',
                            }}
                          >
                            <div>
                              <p className="text-sm font-semibold text-white">
                                Show average rating on my landing page
                              </p>
                              <p className="text-xs mt-0.5" style={{ color: '#71717a' }}>
                                {editRatingsEnabledOnLanding
                                  ? 'Students will see your average rating and review count near your course title.'
                                  : 'Your average rating is hidden from your landing page. Ratings are still collected either way.'}
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => setEditRatingsEnabledOnLanding(previous => !previous)}
                              className="relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200"
                              style={{
                                background: editRatingsEnabledOnLanding
                                  ? 'var(--kurso-primary)'
                                  : 'rgba(255,255,255,0.12)',
                              }}
                              aria-label={
                                editRatingsEnabledOnLanding
                                  ? 'Hide average rating from landing page'
                                  : 'Show average rating on landing page'
                              }
                              aria-pressed={editRatingsEnabledOnLanding}
                            >
                              <span
                                className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
                                style={{
                                  transform: editRatingsEnabledOnLanding
                                    ? 'translateX(20px)'
                                    : 'translateX(0)',
                                }}
                              />
                            </button>
                          </div>
                        </SettingsGroup>


                        <SettingsGroup
                          title="Frequently Asked Questions"
                          description="Add questions and answers that students may ask about your course."
                        >
                          <LandingSectionToggle type="faq" />


                          <div className="flex flex-col gap-3">
                            {editFaq.map((faq, i) => (
                              <div key={i} className="p-4 rounded-xl relative flex flex-col gap-2"
                                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                                <button onClick={() => setEditFaq(editFaq.filter((_, idx) => idx !== i))}
                                  className="absolute top-4 right-4 text-zinc-600 hover:text-red-500 transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                                <input
                                  value={faq.question}
                                  onChange={e => {
                                    const next = [...editFaq]; next[i].question = e.target.value; setEditFaq(next)
                                  }}
                                  placeholder="Question"
                                  className="w-full bg-transparent text-sm text-white font-medium outline-none pr-8"
                                />
                                <textarea
                                  value={faq.answer}
                                  onChange={e => {
                                    const next = [...editFaq]; next[i].answer = e.target.value; setEditFaq(next)
                                  }}
                                  placeholder="Answer"
                                  rows={2}
                                  className="w-full bg-transparent text-sm text-zinc-400 outline-none resize-none"
                                />
                              </div>
                            ))}
                            <button onClick={() => setEditFaq([...editFaq, { question: '', answer: '' }])}
                              className="text-xs text-[var(--kurso-primary-light)] hover:text-[var(--kurso-primary)] w-fit font-medium">+ Add FAQ</button>
                            <AiFieldAssist
                              field="faq" entityType="course"
                              context={{ name: course?.name, description: editDesc, what_you_will_learn: editLearn.filter(Boolean), target_audience: editTargetAudience?.filter(Boolean) }}
                              currentValue={editFaq.map(f => f.question).filter(Boolean)}
                              onResult={v => {
                                if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && 'question' in v[0]) {
                                  setEditFaq(v as { question: string; answer: string }[])
                                }
                              }}
                              className="mt-1"
                            />
                          </div>

                        </SettingsGroup>

                        <SettingsGroup
                          title="What's Included (Bonuses)"
                          description="Add any bonus materials or perks that come with the course, such as downloadable resources, templates, or exclusive access to additional content."
                        >

                          <LandingSectionToggle type="bonuses" />
                          <div className="flex flex-col gap-3">
                            {settingsLandingConfig.bonuses.map((bonus, i) => (
                              <div key={i} className="flex gap-2 items-start p-3 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <div className="flex-1 flex flex-col gap-2">
                                  <input value={bonus.title} onChange={e => updateBonus(i, 'title', e.target.value)}
                                    placeholder="Bonus title (e.g. Private community access)"
                                    className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-400" />
                                  <input value={bonus.description} onChange={e => updateBonus(i, 'description', e.target.value)}
                                    placeholder="Short description (optional)"
                                    className="w-full px-3 py-2 rounded-lg text-xs bg-white/5 border border-white/10 text-white placeholder:text-zinc-400" />
                                </div>
                                <button type="button" onClick={() => removeBonus(i)}
                                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                                  style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}>
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))}
                            <button type="button" onClick={addBonus}
                              className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium"
                              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px dashed rgba(255,255,255,0.15)' }}>
                              <Plus className="w-3.5 h-3.5" /> Add bonus
                            </button>
                          </div>
                        </SettingsGroup>

                        <SettingsGroup
                          title="Contact details"
                          description="Add up to 2 phone numbers and 2 email addresses. Choose where each one appears on your landing page."
                        >
                          <ContactDetailsEditor value={editContactDetails} onChange={setEditContactDetails} />
                        </SettingsGroup>

                        <SettingsGroup
                          title="Social links"
                          description="Add your social media pages. Each one shows up as a logo button in your landing page footer — one link per platform."
                        >
                          <SocialLinksEditor value={editSocialLinks} onChange={setEditSocialLinks} />
                        </SettingsGroup>

                        <SettingsGroup
                          title="Disclaimer"
                          description="Add a disclaimer to your landing page to inform students about any important information or legal notices. (You can skip this if not needed)"
                        >

                          <LandingSectionToggle type="disclaimer" />
                          <div className="flex flex-col gap-2">
                            <input value={settingsLandingConfig.disclaimer.title} onChange={e => updateDisclaimer('title', e.target.value)}
                              placeholder="Title (e.g. Important information)"
                              className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-600" />
                            <textarea value={settingsLandingConfig.disclaimer.text} onChange={e => updateDisclaimer('text', e.target.value)}
                              placeholder="Disclaimer text shown on the live page..." rows={4}
                              className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-400 resize-none" />
                          </div>
                        </SettingsGroup>

                        <SettingsGroup
                          title="Custom Sections (highly optional)"
                          description="Create section according to your needs. Each section can have a heading, body text, and images. You can also customize the heading size, body text size, alignment, box style, and spacing."
                        >

                          <div className="flex flex-col gap-4">
                            {settingsLandingConfig.customSections.map((cs) => (
                              <div key={cs.id} className="p-4 rounded-xl flex flex-col gap-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                <LandingSectionToggle type="custom" customId={cs.id} />
                                <input value={cs.heading} onChange={e => updateCustomSection(cs.id, { heading: e.target.value })}
                                  maxLength={MAX_CUSTOM_HEADING_LENGTH} placeholder="Heading"
                                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-600" />
                                <textarea value={cs.body} onChange={e => updateCustomSection(cs.id, { body: e.target.value })}
                                  maxLength={MAX_CUSTOM_BODY_LENGTH} placeholder="Body text..." rows={4}
                                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-white placeholder:text-zinc-600 resize-none" />
                                <p className="text-[12px] -mt-1" style={{ color: '#8d8d91' }}>{cs.body.length} / {MAX_CUSTOM_BODY_LENGTH} characters</p>

                                <div className="flex flex-col gap-2">
                                  <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Images ({cs.images.length} / {MAX_CUSTOM_SECTION_IMAGES})</span>
                                  {cs.images.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                      {cs.images.map((img, imgI) => (
                                        <div key={imgI} className="relative w-16 h-16 rounded-lg overflow-hidden flex-shrink-0" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                                          <img src={img} alt="" className="w-full h-full object-cover" />
                                          <button type="button" onClick={() => removeCustomSectionImage(cs.id, img)}
                                            className="absolute top-0.5 right-0.5 w-5 h-5 rounded flex items-center justify-center"
                                            style={{ background: 'rgba(0,0,0,0.7)', color: '#fff' }}>
                                            <XIcon className="w-3 h-3" />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {cs.images.length < MAX_CUSTOM_SECTION_IMAGES && (
                                    <label className="flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium cursor-pointer"
                                      style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px dashed rgba(255,255,255,0.15)' }}>
                                      <ImageIconLucide className="w-3.5 h-3.5" />
                                      {uploadingCustomImageId === cs.id ? 'Uploading...' : '1 image = full width · 2 side by side · 3+ scrolls — add images'}
                                      <input type="file" accept="image/*" multiple hidden disabled={uploadingCustomImageId === cs.id}
                                        onChange={e => { if (e.target.files?.length) addCustomSectionImages(cs.id, e.target.files); e.target.value = '' }} />
                                    </label>
                                  )}
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Heading size</span>
                                    <select value={cs.headingSize} onChange={e => updateCustomSection(cs.id, { headingSize: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="sm" style={{ background: '#27272a', color: '#fff' }}>Small</option>
                                      <option value="md" style={{ background: '#27272a', color: '#fff' }}>Medium</option>
                                      <option value="lg" style={{ background: '#27272a', color: '#fff' }}>Large</option>
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Body text size</span>
                                    <select value={cs.bodySize} onChange={e => updateCustomSection(cs.id, { bodySize: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="sm" style={{ background: '#27272a', color: '#fff' }}>Small</option>
                                      <option value="md" style={{ background: '#27272a', color: '#fff' }}>Medium</option>
                                      <option value="lg" style={{ background: '#27272a', color: '#fff' }}>Large</option>
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Alignment</span>
                                    <select value={cs.align} onChange={e => updateCustomSection(cs.id, { align: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="left" style={{ background: '#27272a', color: '#fff' }}>Left</option>
                                      <option value="center" style={{ background: '#27272a', color: '#fff' }}>Center</option>
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Box style</span>
                                    <select value={cs.style} onChange={e => updateCustomSection(cs.id, { style: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="plain" style={{ background: '#27272a', color: '#fff' }}>Plain</option>
                                      <option value="card" style={{ background: '#27272a', color: '#fff' }}>Card</option>
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Spacing</span>
                                    <select value={cs.spacing} onChange={e => updateCustomSection(cs.id, { spacing: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="compact" style={{ background: '#27272a', color: '#fff' }}>Compact</option>
                                      <option value="normal" style={{ background: '#27272a', color: '#fff' }}>Normal</option>
                                      <option value="roomy" style={{ background: '#27272a', color: '#fff' }}>Roomy</option>
                                    </select>
                                  </label>
                                  <label className="flex flex-col gap-1">
                                    <span className="text-[12px] font-medium" style={{ color: '#88888d' }}>Background</span>
                                    <select value={cs.background} onChange={e => updateCustomSection(cs.id, { background: e.target.value as any })}
                                      className="px-2 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10 text-white" style={{ colorScheme: 'dark' }}>
                                      <option value="theme" style={{ background: '#27272a', color: '#fff' }}>Match theme (recommended)</option>
                                      <option value="custom" style={{ background: '#27272a', color: '#fff' }}>Custom color</option>
                                    </select>
                                  </label>
                                </div>

                                {cs.background === 'custom' && (
                                  <label className="flex items-center gap-2">
                                    <span className="text-[10px] font-medium" style={{ color: '#71717a' }}>Background color</span>
                                    <input type="color" value={cs.backgroundColor} onChange={e => updateCustomSection(cs.id, { backgroundColor: e.target.value })}
                                      className="w-8 h-8 rounded border border-white/10 bg-transparent" />
                                  </label>
                                )}

                                <div className="flex justify-end">
                                  <button type="button" onClick={() => removeCustomSection(cs.id)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
                                    style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444' }}>
                                    <Trash2 className="w-3.5 h-3.5" /> Remove section
                                  </button>
                                </div>
                              </div>
                            ))}
                            <button type="button" onClick={addCustomSection}
                              disabled={settingsLandingConfig.customSections.length >= MAX_CUSTOM_SECTIONS_PER_COURSE}
                              className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
                              style={{ background: 'rgba(255,255,255,0.05)', color: '#a1a1aa', border: '1px dashed rgba(255,255,255,0.15)' }}>
                              <Plus className="w-3.5 h-3.5" />
                              {settingsLandingConfig.customSections.length >= MAX_CUSTOM_SECTIONS_PER_COURSE ? `Limit of ${MAX_CUSTOM_SECTIONS_PER_COURSE} reached` : 'Add custom section'}
                            </button>
                          </div>
                        </SettingsGroup>


                      </>
                    )}

                    <SettingsGroup
                      title="Completion Certificates"
                      description="Auto-issued as PDF when a student completes all lessons"
                    >
                      <div className="flex items-center justify-between mb-4">
                        <p className="text-sm mb-2" style={{ color: 'rgb(240, 233, 231)' }}>Enable / Disable Certificate</p>

                        <button
                          onClick={() => setEditCertEnabled(v => !v)}
                          className="relative w-11 h-6 rounded-full transition-all flex-shrink-0"
                          style={{ background: editCertEnabled ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.1)' }}
                        >
                          <div
                            className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all"
                            style={{ left: editCertEnabled ? '24px' : '4px' }}
                          />
                        </button>
                      </div>

                      {editCertEnabled && (
                        <div className="flex flex-col gap-4 mt-2">
                          <div>
                            <label className="text-sm font-medium text-zinc-300 mb-2 block">Choose a Color Palette</label>
                            <p className="text-sm mb-2" style={{ color: 'var(--kurso-hint)' }}>
                              Choose any color palette, then select any layout you like below. And Then click preview option next to layout.You can try any color palette and layout, after selecting layout you can change the palette too.
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {CERT_PALETTES.map(palette => (
                                <button
                                  key={palette.id}
                                  type="button"
                                  onClick={() => setEditCertPalette(palette.id)}
                                  className="flex items-center gap-3 p-3 rounded-xl text-left transition-all"
                                  style={{
                                    background: editCertPalette === palette.id ? 'rgba(var(--kurso-primary-rgb), 0.15)' : 'rgba(255,255,255,0.03)',
                                    border: editCertPalette === palette.id ? '1px solid rgba(var(--kurso-primary-rgb), 0.45)' : '1px solid rgba(255,255,255,0.08)',
                                  }}
                                >
                                  <span className="w-8 h-8 rounded-lg flex-shrink-0" style={{ background: `linear-gradient(135deg, ${palette.background}, ${palette.accent})`, border: `1px solid ${palette.divider}` }} />
                                  <span className="text-sm font-semibold text-white">{palette.label}</span>
                                  {editCertPalette === palette.id && <span className="ml-auto w-2 h-2 rounded-full" style={{ background: 'var(--kurso-primary)' }} />}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <label className="text-sm font-medium text-zinc-300 mb-2 block">Choose a Layout</label>
                            <p className="text-sm mb-2" style={{ color: 'var(--kurso-hint)' }}>
                              Preview palette and layout and at last select which combo you liked.
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {([
                                { id: 'classic', label: 'Classic', desc: 'White · Navy border · Gold accents' },
                                { id: 'modern', label: 'Modern', desc: 'Dark · Violet accents · Clean' },
                                { id: 'gold', label: 'Gold', desc: 'Ivory · Ornate gold borders' },
                                { id: 'minimal', label: 'Minimal', desc: 'Pure white · Ultra clean' },
                                { id: 'royal', label: 'Royal', desc: 'Deep navy · Gold typography' },
                              ] as const).map(t => (
                                <div
                                  key={t.id}
                                  className="flex items-center gap-2"
                                >
                                  <button
                                    type="button"
                                    onClick={() => setEditCertTemplate(t.id)}
                                    className="flex-1 flex items-start gap-3 p-3 rounded-xl text-left transition-all"
                                    style={{
                                      background: editCertTemplate === t.id ? 'rgba(var(--kurso-primary-rgb), 0.15)' : 'rgba(255,255,255,0.03)',
                                      border: editCertTemplate === t.id
                                        ? '1px solid rgba(var(--kurso-primary-rgb), 0.45)'
                                        : '1px solid rgba(255,255,255,0.08)',
                                    }}
                                  >
                                    <div
                                      className="w-8 h-8 rounded-lg flex-shrink-0 mt-0.5"
                                      style={{
                                        background:
                                          t.id === 'classic' ? 'linear-gradient(135deg,#1a2744,#c9a227)' :
                                            t.id === 'modern' ? 'linear-gradient(135deg,#0f0f1a,var(--kurso-primary))' :
                                              t.id === 'gold' ? 'linear-gradient(135deg,#fdf8ed,#c9a227)' :
                                                t.id === 'minimal' ? 'linear-gradient(135deg,#ffffff,var(--kurso-primary))' :
                                                  'linear-gradient(135deg,#060d2e,#d4af37)',
                                      }}
                                    />
                                    <div className="min-w-0">
                                      <p className="text-sm font-semibold text-white">{t.label}</p>
                                      <p className="text-xs mt-0.5" style={{ color: '#71717a' }}>{t.desc}</p>
                                    </div>
                                    {editCertTemplate === t.id && (
                                      <div
                                        className="ml-auto flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
                                        style={{ background: 'var(--kurso-primary)', marginTop: 2 }}
                                      >
                                        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                          <path d="M1 4l2 2 4-4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                      </div>
                                    )}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setPreviewTemplate(t.id)
                                      setShowCertPreview(true)
                                    }}
                                    className="px-3 h-9 rounded-xl flex items-center justify-center flex-shrink-0 transition-all hover:bg-white/10 text-xs font-medium"
                                    style={{
                                      background: 'rgba(255,255,255,0.03)',
                                      border: '1px solid rgba(255,255,255,0.08)',
                                      color: '#a1a1aa',
                                    }}
                                    title={`Preview ${t.label} template`}
                                  >
                                    Preview
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <div className="flex items-center justify-between mb-4 mt-3">
                                <label className="text-sm font-medium text-zinc-200">Use Brand Logo on Certificate</label>
                                <button
                                  type="button"
                                  onClick={() => setEditUseLogoOnCertificate(v => !v)}
                                  className="relative w-9 h-5 rounded-full transition-all flex-shrink-0"
                                  style={{ background: editUseLogoOnCertificate ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.1)' }}
                                >
                                  <div
                                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                                    style={{ left: editUseLogoOnCertificate ? '18px' : '2px' }}
                                  />
                                </button>
                              </div>

                              {editUseLogoOnCertificate && (
                                <div className="flex items-center gap-3 mt-1">
                                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                                    {brandLogoUrl
                                      ? <img src={brandLogoUrl} alt="Brand Logo" className="w-full h-full object-contain" />
                                      : <ImageIconLucide className="w-4 h-4 text-zinc-600" />}
                                  </div>
                                  <div className="flex-1">
                                    <input type="file" accept="image/png,image/jpeg,image/webp" id="cert-brand-logo"
                                      className="hidden" onChange={handleBrandLogoUpload} disabled={uploadingBrandLogo} />
                                    <label htmlFor="cert-brand-logo"
                                      className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10 transition-all">
                                      {uploadingBrandLogo ? 'Uploading...' : brandLogoUrl ? 'Replace Logo' : 'Upload Logo'}
                                    </label>
                                    {brandLogoUrl && (
                                      <button onClick={() => setBrandLogoUrl('')}
                                        className="ml-2 text-xs text-zinc-400 hover:text-red-500 inline-flex items-center gap-1">
                                        <XIcon className="w-3 h-3" /> Remove
                                      </button>
                                    )}
                                    <p className="text-[11px] text-zinc-400 mt-1">PNG/JPG/WebP · max 2 MB · will print on the certificate</p>
                                  </div>
                                </div>
                              )}

                              {!editUseLogoOnCertificate && (
                                <p className="text-xs mt-1" style={{ color: '#8a8a8f' }}>
                                  Uses the same logo set in Design Landing Page.
                                </p>
                              )}
                            </div>

                            <div>
                              <label className="text-sm font-semibold text-zinc-300 mb-3 block">Mentor Signature (optional)</label>
                              <input type="file" accept="image/png,image/jpeg" id="cert-sig"
                                className="hidden"
                                onChange={async e => {
                                  const file = e.target.files?.[0]
                                  if (!file) return
                                  const { publicUrl } = await uploadToSupabase(file, 'cert-assets')
                                  setEditCertSignatureUrl(publicUrl)
                                }} />
                              <label htmlFor="cert-sig" className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-medium bg-white/5 border border-white/10 text-white cursor-pointer hover:bg-white/10">
                                {editCertSignatureUrl ? 'Replace Signature' : 'Upload Signature'}
                              </label>
                              {editCertSignatureUrl && <span className="text-xs text-zinc-400 ml-2">Uploaded</span>}
                            </div>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <label className="text-sm font-medium text-zinc-300">Custom Message on Certificate</label>
                              <span className="text-xs" style={{ color: '#52525b' }}>{editCertCustomMessage.length}/120</span>
                            </div>
                            <input
                              type="text"
                              value={editCertCustomMessage}
                              onChange={e => setEditCertCustomMessage(e.target.value.slice(0, 120))}
                              placeholder="e.g. Keep building, keep shipping. — Your Name"
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[var(--kurso-primary)]"
                            />
                            <p className="text-sm mt-4" style={{ color: 'var(--kurso-hint)' }}>
                              Appears as a small line on the certificate. You can leave it blank no trouble.
                            </p>
                          </div>
                        </div>
                      )}

                    </SettingsGroup>

                    {course.uses_external_landing_page && (
                      <>
                        <SectionDivider label="Embed Button" />
                        <div>
                          <p className="text-sm mb-3" style={{ color: '#a5a5a8', lineHeight: 1.6 }}>
                            Paste this code anywhere on your own website to add a working "Buy Now" button — it opens Kurso checkout in a popup, everything else on your page stays untouched. You can freely change its color, size, font, and anything else in your own CSS to match your site; the only thing that must stay exactly as-is is the <code className="text-xs px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.08)', color: '#e4e4e7' }}>data-kurso-course</code> attribute.
                          </p>
                          <pre className="text-xs mb-3 p-3 rounded-xl whitespace-pre-wrap break-all" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#a5a5a8' }}>
                            {embedSnippet()}
                          </pre>
                          <button onClick={copyEmbedSnippet}
                            className="flex items-center justify-center gap-2 py-2.5 px-5 rounded-xl text-sm font-medium transition-all"
                            style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}>
                            {copiedEmbed
                              ? <><Check className="w-4 h-4" style={{ color: '#4ade80' }} />Copied!</>
                              : <><Copy className="w-4 h-4" />Copy Embed Code</>
                            }
                          </button>
                          <p className="text-[13px] mt-2" style={{ color: 'var(--kurso-hint)' }}>
                            Note: the price shown is baked in at copy time — if you change your course price later, re-copy and re-paste this snippet.
                          </p>
                        </div>
                      </>
                    )}

                    {/* Danger Zone */}
                    <div className="order-20 mt-12 pt-8 border-t border-red-500/20">
                      <div className="flex items-center gap-2 mb-4">
                        <AlertTriangle className="w-4 h-4 text-red-500" />
                        <h3 className="text-sm font-bold text-red-500 uppercase tracking-widest">Danger Zone</h3>
                      </div>
                      <div className="p-5 rounded-2xl bg-red-500/5 border border-red-500/10 flex flex-col sm:flex-row items-center justify-between gap-4">
                        <div>
                          <p className="text-sm font-bold text-white mb-1">Delete Course</p>
                          <p className="text-sm text-zinc-300 ">
                            Permanently delete this course and all its data. This cannot be undone.
                          </p>
                        </div>
                        <button onClick={() => setShowDeleteModal(true)}
                          className="px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest bg-red-500/10 text-red-500 hover:bg-red-500 border border-red-500/20 hover:text-white transition-all whitespace-nowrap">
                          Delete Course
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : activeTab === 'landing' ? (
              course.uses_external_landing_page ? (
                <div className="rounded-2xl p-8 glass text-center" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className="text-sm font-semibold text-white mb-2">You're using your own landing page</p>
                  <p className="text-sm mb-5" style={{ color: '#a1a1aa' }}>
                    Nobody will see this Kurso page, so there's nothing to design here — use the Embed Button in Settings instead. Price, refund policy, and other course details are still edited from the Settings tab.
                  </p>
                  <button onClick={toggleUsesExternalLandingPage}
                    className="text-xs underline" style={{ color: '#71717a' }}>
                    Want to use Kurso's course page after all? Switch mode
                  </button>
                </div>
              ) : (
                <LandingPageDesigner courseId={course.id} />
              )
            ) : null}
          </div>

          {/* ── RIGHT: Course Info + Share ── */}
          <div className="flex flex-col gap-4">


            {/* Publish toggle */}
            <div className="rounded-2xl p-5"
              style={{
                background: course.is_published ? 'rgba(74,222,128,0.06)' : 'rgba(255,255,255,0.02)',
                border: course.is_published ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(255,255,255,0.06)',
              }}>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-semibold text-white">
                    {course.uses_external_landing_page
                      ? (course.is_published ? 'Checkout is Enabled' : 'Checkout is Disabled')
                      : (course.is_published ? 'Course is Live' : 'Course is Draft')}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#cfcfd4' }}>
                    {course.uses_external_landing_page
                      ? (course.is_published
                        ? 'Your Embed Button will accept payments. Your Kurso course page stays hidden either way.'
                        : 'Your Embed Button will not accept payments until this is turned on.')
                      : (course.is_published
                        ? 'Students can find and enroll'
                        : 'Course page hidden · enrollment blocked · enrolled students unaffected')}
                  </p>
                </div>
                <button onClick={toggleCoursePublish}
                  className="relative w-12 h-6 rounded-full transition-all"
                  style={{ background: course.is_published ? 'var(--kurso-primary)' : 'rgba(255,255,255,0.1)' }}>
                  <div className="absolute top-1 w-4 h-4 rounded-full bg-white transition-all"
                    style={{ left: course.is_published ? '28px' : '4px' }} />
                </button>
              </div>
              {!hasActivePaidPlan && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg mb-2"
                  style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--kurso-accent)' }} />
                  <p className="text-xs" style={{ color: 'var(--kurso-accent)' }}>
                    You need to pay for a Kurso plan before this can be turned on — this is separate from your Razorpay/Stripe/Cashfree account, which is what actually collects payment from students. <Link href="/upgrade" className="underline font-semibold text-xs">Go to upgrade page</Link>
                  </p>
                </div>
              )}
              {!course.is_published && lessons.length === 0 && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg"
                  style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--kurso-accent)' }} />
                  <p className="text-xs" style={{ color: 'var(--kurso-accent)' }}>
                    Add at least one lesson before publishing
                  </p>
                </div>
              )}
              <button onClick={toggleUsesExternalLandingPage}
                className="text-[12px] mt-2 underline"
                style={{ color: 'var(--kurso-hint)' }}>
                {course.uses_external_landing_page
                  ? "Using Kurso's course page instead? Switch mode"
                  : 'Using your own landing page instead? Switch mode'}
              </button>
            </div>

            {/* Course page preview */}
            {course.uses_external_landing_page ? (
              <div className="rounded-2xl p-5 glass"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                  <FlaskConical className="w-4 h-4" style={{ color: 'var(--kurso-accent)' }} />
                  Test This Course
                </h3>
                <p className="text-sm mb-3" style={{ color: 'var(--kurso-hint)' }}>

                  This enrolls you as a real student on both platforms so you can test the almost same
                  lesson-delivery experience your students receive.
                </p>
                <button onClick={() => setShowTestModal(true)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium w-full transition-all"
                  style={{ background: 'rgba(250,204,21,0.08)', color: 'var(--kurso-accent)', border: '1px solid rgba(250,204,21,0.2)' }}>
                  <FlaskConical className="w-4 h-4" />
                  Test This Course
                </button>
              </div>
            ) : (
              <div className="rounded-2xl p-5 glass"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
                <h3 className="font-semibold text-white mb-3 flex items-center gap-2">
                  <span className="text-xs font-semibold" style={{ color: 'var(--kurso-primary-light)' }}>
                    Preview
                  </span>
                  Course Page
                </h3>
                <p className="text-sm mb-3" style={{ color: 'var(--kurso-hint)' }}>
                  This is what students see when they visit your course link.
                </p>
                <Link href={`/about-course/${slugify(course.host_name || 'instructor')}/${slugify(course.name)}/${course.id}`} target="_blank"
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium w-full transition-all mb-2"
                  style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)', color: 'var(--kurso-primary-light)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>
                  <ExternalLink className="w-4 h-4" />
                  Preview Course Page
                </Link>
                <p className="text-sm mb-3 mt-3" style={{ color: 'var(--kurso-hint)' }}>
                  This enrolls you as a real student on both platforms so you can test the almost same
                  lesson-delivery experience your students receive.
                </p>
                <button onClick={() => setShowTestModal(true)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium w-full transition-all"
                  style={{ background: 'rgba(250,204,21,0.08)', color: 'var(--kurso-accent)', border: '1px solid rgba(250,204,21,0.2)' }}>
                  <FlaskConical className="w-4 h-4" />
                  Test This Course
                </button>
              </div>
            )}

            {showTestModal && (
              <TestCourseModal
                courseId={id}
                creatorId={creatorId}
                telegramBotUsername={creatorTelegramBotUsername}
                courseUrl={`/course/${slugify(course.host_name || 'instructor')}/${slugify(course.name)}/${course.id}`}
                onClose={() => setShowTestModal(false)}
              />
            )}

            {/* Share section — the Kurso course page link, irrelevant if the creator uses their own page instead */}
            {!course.uses_external_landing_page && (
              <div className="rounded-2xl p-5"
                style={{ background: 'rgba(var(--kurso-primary-rgb), 0.06)', border: '1px solid rgba(var(--kurso-primary-rgb), 0.2)' }}>

                <h3 className="font-semibold text-white mb-1 flex items-center gap-2">
                  <Share2 className="w-4 h-4" style={{ color: 'var(--kurso-primary-light)' }} />
                  Share Course
                </h3>
                <p className="text-xs mb-4" style={{ color: 'var(--kurso-hint)' }}>
                  Share this link with your students to enroll.
                </p>

                {/* Copy link */}
                <button onClick={copyCourseLink}
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium transition-all mb-2"
                  style={{ background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)' }}>
                  {copied
                    ? <><Check className="w-4 h-4" style={{ color: '#4ade80' }} />Copied!</>
                    : <><Copy className="w-4 h-4" />Copy Course Link</>
                  }
                </button>

                {/* Share on WhatsApp */}
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(`Hey! Enroll in my course "${course.name}" here: ${courseUrl}`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-90"
                  style={{ background: '#25d366', color: '#fff' }}>
                  <MessageCircle className="w-4 h-4" />
                  Share on WhatsApp
                </a>
              </div>
            )}

          </div>
        </div>
      </main>

      {/* Certificate Preview Modal */}
      {course && (
        <CertificatePreviewModal
          isOpen={showCertPreview}
          onClose={() => setShowCertPreview(false)}
          template={previewTemplate}
          paletteId={editCertPalette}
          courseName={course.name}
          creatorName={course.host_name || 'Instructor'}
          skills={editSkills}
          courseDuration={editDuration}
          logoUrl={editUseLogoOnCertificate ? brandLogoUrl : editCertLogoUrl}
          signatureUrl={editCertSignatureUrl}
          customMessage={editCertCustomMessage}
        />
      )}
    </div>
  )
}