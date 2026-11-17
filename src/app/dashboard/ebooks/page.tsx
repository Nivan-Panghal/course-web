'use client'
import { useEffect, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { supabase } from '@/lib/supabase'
import { slugify } from '@/lib/utils'
import { BookOpen, Upload, Users, IndianRupee, Download, Copy, Eye, EyeOff, Trash2, FileText, Image as ImageIcon, RotateCcw, X, Check } from 'lucide-react'

type Ebook = {
  id: string; title: string; description: string | null; price: number
  cover_image_url: string | null; is_published: boolean; refund_window_days: number
}

type Buyer = {
  id: string; student_name: string | null; student_email: string | null
  amount: number; status: string; created_at: string
  ebook_download_count: number; ebook_download_limit: number
}

export default function EbooksPage() {
  const [tab, setTab] = useState<'dashboard' | 'create'>('dashboard')
  const [ebooks, setEbooks] = useState<Ebook[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [stats, setStats] = useState({ buyers: 0, totalRevenue: 0, thisMonthRevenue: 0, totalDownloads: 0 })
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Ebook | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [publishError, setPublishError] = useState('')

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createSuccess, setCreateSuccess] = useState('')

  useEffect(() => { init() }, [])
  useEffect(() => { if (token) { fetchStats(); fetchBuyers() } }, [selectedId, token])

  async function init() {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) setToken(session.access_token)
    await fetchEbooks()
    setLoading(false)
  }

  async function fetchEbooks() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    const { data } = await supabase.from('ebooks').select('*').eq('creator_id', user.id).order('created_at', { ascending: false })
    setEbooks(data || [])
  }

  async function fetchStats() {
    const url = selectedId ? `/api/creator/ebook-stats?ebookId=${selectedId}` : '/api/creator/ebook-stats'
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) setStats(await res.json())
  }

  async function fetchBuyers() {
    if (!selectedId) { setBuyers([]); return }
    const res = await fetch(`/api/creator/ebook-buyers?ebookId=${selectedId}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) { const d = await res.json(); setBuyers(d.buyers || []) }
  }

  async function resetDownloads(purchaseId: string) {
    setResettingId(purchaseId)
    try {
      await fetch('/api/creator/ebook-reset-downloads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ purchaseId }),
      })
      await fetchBuyers()
    } finally {
      setResettingId(null)
    }
  }

  async function togglePublish(ebook: Ebook) {
    setPublishError('')
    const { error } = await supabase.from('ebooks').update({ is_published: !ebook.is_published }).eq('id', ebook.id)
    // e.g. "Your Kurso invoice is overdue. Pay it to publish again."
    if (error) setPublishError(error.message)
    fetchEbooks()
  }

  async function deleteEbook(ebookId: string) {
    await supabase.from('ebooks').delete().eq('id', ebookId)
    if (selectedId === ebookId) setSelectedId('')
    fetchEbooks()
    setDeleteTarget(null)
  }

  function copyEbookLink(eb: Ebook) {
    navigator.clipboard.writeText(`${window.location.origin}/ebook/${eb.id}`)
    setCopiedId(eb.id)
    setTimeout(() => setCopiedId(prev => (prev === eb.id ? null : prev)), 2000)
  }


  async function handleCreate(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreateError(''); setCreateSuccess('')
    if (!title.trim() || !price || !pdfFile) { setCreateError('Title, price, and a PDF file are required.'); return }
    setUploading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Please log in again.')

      const { data: { session } } = await supabase.auth.getSession()
      const authToken = session?.access_token
      if (!authToken) throw new Error('Please log in again.')

      const signRes = await fetch('/api/upload/r2-sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ fileName: pdfFile.name, contentType: pdfFile.type, folder: 'ebooks' }),
      })
      if (!signRes.ok) {
        const body = await signRes.json().catch(() => ({}))
        throw new Error(body.error || 'Could not get an upload URL for the PDF')
      }
      const { uploadUrl, key: pdfPath } = await signRes.json()

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': pdfFile.type },
        body: pdfFile,
      })
      if (!putRes.ok) throw new Error('Could not upload the PDF')

      let coverUrl: string | null = null
      if (coverFile) {
        const coverPath = `${user.id}/${crypto.randomUUID()}-${coverFile.name}`
        const { error: coverUploadError } = await supabase.storage.from('ebook-covers').upload(coverPath, coverFile)
        if (coverUploadError) throw new Error('Could not upload the cover: ' + coverUploadError.message)
        coverUrl = supabase.storage.from('ebook-covers').getPublicUrl(coverPath).data.publicUrl
      }

      const { error: insertError } = await supabase.from('ebooks').insert({
        creator_id: user.id, title: title.trim(), slug: slugify(title.trim()),
        description: description.trim() || null, price: parseFloat(price),
        cover_image_url: coverUrl, pdf_storage_path: pdfPath, is_published: false,
      })
      if (insertError) throw insertError

      setCreateSuccess('Ebook created! Publish it from the Dashboard tab when ready.')
      setTitle(''); setDescription(''); setPrice(''); setCoverFile(null); setPdfFile(null)
      await fetchEbooks()
      setTab('dashboard')
    } catch (err: any) {
      setCreateError(err.message || 'Something went wrong.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="min-h-screen flex" style={{ background: '#050505' }}>
      <Sidebar />
      {deleteTarget && (
        <DeleteEbookModal
          ebook={deleteTarget}
          onConfirm={() => deleteEbook(deleteTarget.id)}
          onClose={() => setDeleteTarget(null)}
        />
      )}
      <main className="md:ml-56 p-5 md:p-8 pt-20 md:pt-8 font-sans w-full flex flex-col items-center">
        <div className="w-full max-w-3xl">
          <div className="text-center mb-10 mt-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-white mb-2">Ebooks</h1>
            <p className="text-base" style={{ color: 'var(--kurso-text-secondary)' }}>
              Sell PDF ebooks separately from your courses.
            </p>
          </div>

          {/* Tabs */}
          <div className="flex items-center justify-center gap-2 mb-10">
            {(['dashboard', 'create'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className="px-6 py-3 rounded-xl text-sm font-bold capitalize transition-all"
                style={{
                  background: tab === t ? 'rgba(var(--kurso-primary-rgb), 0.15)' : 'rgba(255,255,255,0.03)',
                  color: tab === t ? 'var(--kurso-primary-light)' : 'var(--kurso-text-muted)',
                  border: tab === t ? '1px solid rgba(var(--kurso-primary-rgb), 0.3)' : '1px solid rgba(255,255,255,0.06)',
                }}>
                {t}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex justify-center"><div className="w-6 h-6 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" /></div>
          ) : tab === 'dashboard' ? (
            ebooks.length === 0 ? (
              <div className="mx-auto max-w-md text-center rounded-2xl py-16 px-8"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
                  style={{ background: 'rgba(var(--kurso-primary-rgb), 0.1)' }}>
                  <BookOpen className="w-7 h-7" style={{ color: 'var(--kurso-primary-light)' }} />
                </div>
                <p className="text-base mb-6" style={{ color: 'var(--kurso-text-muted)' }}>You haven't added any ebooks yet.</p>
                <button onClick={() => setTab('create')} className="px-6 py-3 rounded-xl text-sm font-bold text-white violet-gradient">
                  Add your first ebook
                </button>
              </div>
            ) : (
              <>
                {/* Ebook selector */}
                <div className="flex gap-2 mb-8 flex-wrap justify-center">
                  <button onClick={() => setSelectedId('')}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
                    style={{ background: selectedId === '' ? 'rgba(var(--kurso-primary-rgb),0.15)' : 'rgba(255,255,255,0.04)', color: selectedId === '' ? 'var(--kurso-primary-light)' : 'var(--kurso-text-muted)', border: selectedId === '' ? '1px solid rgba(var(--kurso-primary-rgb), 0.3)' : '1px solid rgba(255,255,255,0.06)' }}>
                    All ebooks
                  </button>
                  {ebooks.map(eb => (
                    <button key={eb.id} onClick={() => setSelectedId(eb.id)}
                      className="px-4 py-2.5 rounded-xl text-sm font-semibold truncate max-w-[200px] transition-all"
                      style={{ background: selectedId === eb.id ? 'rgba(var(--kurso-primary-rgb),0.15)' : 'rgba(255,255,255,0.04)', color: selectedId === eb.id ? 'var(--kurso-primary-light)' : 'var(--kurso-text-muted)', border: selectedId === eb.id ? '1px solid rgba(var(--kurso-primary-rgb), 0.3)' : '1px solid rgba(255,255,255,0.06)' }}>
                      {eb.title}
                    </button>
                  ))}
                </div>

                {/* Stats — centered, bigger */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
                  <StatCard icon={Users} label="Buyers" value={stats.buyers} color="var(--kurso-info)" />
                  <StatCard icon={IndianRupee} label="Revenue" value={`₹${stats.totalRevenue.toLocaleString('en-IN')}`} color="var(--kurso-success)" />
                  <StatCard icon={IndianRupee} label="This month" value={`₹${stats.thisMonthRevenue.toLocaleString('en-IN')}`} color="var(--kurso-success)" />
                  <StatCard icon={Download} label="Downloads" value={stats.totalDownloads} color="var(--kurso-purple)" />
                </div>

                {/* Buyers + reset — only when one ebook is selected */}
                {selectedId && buyers.length > 0 && (
                  <div className="mb-10">
                    <p className="text-base font-bold text-white mb-4 text-center">Buyers</p>
                    <div className="flex flex-col gap-3 max-w-2xl mx-auto">
                      {buyers.map(b => (
                        <div key={b.id} className="flex items-center gap-4 p-4 rounded-xl"
                          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{b.student_name || b.student_email || 'Reader'}</p>
                            <p className="text-xs mt-0.5" style={{ color: 'var(--kurso-text-muted)' }}>
                              ₹{Number(b.amount).toLocaleString('en-IN')} · {b.status === 'refunded' ? 'Refunded' : `${b.ebook_download_count}/${b.ebook_download_limit} downloads used`}
                            </p>
                          </div>
                          {b.status !== 'refunded' && b.ebook_download_count >= b.ebook_download_limit && (
                            <button onClick={() => resetDownloads(b.id)} disabled={resettingId === b.id}
                              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold flex-shrink-0 disabled:opacity-50"
                              style={{ background: 'rgba(var(--kurso-info),0.1)', color: 'var(--kurso-info)', border: '1px solid rgba(56,189,248,0.2)' }}>
                              <RotateCcw className="w-3 h-3" /> {resettingId === b.id ? 'Resetting...' : 'Reset downloads'}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ebook list */}
                <p className="text-base font-bold text-white mb-4 text-center">Your ebooks</p>
                {publishError && <p className="text-sm text-center mb-3" style={{ color: '#ef4444' }}>{publishError}</p>}
                <div className="flex flex-col gap-3 max-w-2xl mx-auto">
                  {ebooks.map(eb => (
                    <div key={eb.id} className="flex items-center gap-4 p-4 rounded-xl" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <div className="w-12 h-14 rounded-lg flex-shrink-0 flex items-center justify-center overflow-hidden" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        {eb.cover_image_url ? <img src={eb.cover_image_url} alt="" className="w-full h-full object-cover" /> : <BookOpen className="w-5 h-5" style={{ color: '#3f3f46' }} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-white truncate">{eb.title}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--kurso-text-muted)' }}>
                          ₹{Number(eb.price).toLocaleString('en-IN')} · {eb.is_published ? 'Live' : 'Draft'}
                        </p>
                      </div>
                      <button onClick={() => copyEbookLink(eb)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0"
                        style={{
                          background: copiedId === eb.id ? 'rgba(74,222,128,0.1)' : 'rgba(255,255,255,0.05)',
                          color: copiedId === eb.id ? '#4ade80' : '#a1a1aa',
                          border: copiedId === eb.id ? '1px solid rgba(74,222,128,0.3)' : '1px solid rgba(255,255,255,0.08)',
                        }}>
                        {copiedId === eb.id ? <><Check className="w-3 h-3" />Copied!</> : <><Copy className="w-3 h-3" />Copy link</>}
                      </button>
                      <button onClick={() => togglePublish(eb)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0"
                        style={{
                          background: eb.is_published ? 'rgba(239,68,68,0.1)' : 'rgba(74,222,128,0.1)',
                          color: eb.is_published ? '#ef4444' : '#4ade80',
                          border: eb.is_published ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(74,222,128,0.2)',
                        }}>
                        {eb.is_published
                          ? <><EyeOff className="w-3 h-3" />Unpublish</>
                          : <><Eye className="w-3 h-3" />Publish</>
                        }
                      </button>
                      <button onClick={() => setDeleteTarget(eb)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex-shrink-0"
                        style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                        <Trash2 className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )
          ) : (
            <form onSubmit={handleCreate} className="flex flex-col gap-5 max-w-lg mx-auto">
              <div>
                <label className="text-sm font-semibold text-white mb-2 block">Title</label>
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. The Freelancer's Pricing Guide"
                  className="w-full px-4 py-3.5 rounded-xl text-base text-white outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
              </div>
              <div>
                <label className="text-sm font-semibold text-white mb-2 block">Description <span style={{ color: 'var(--kurso-text-muted)', fontWeight: 400 }}>(optional)</span></label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                  className="w-full px-4 py-3.5 rounded-xl text-base text-white outline-none resize-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
              </div>
              <div>
                <label className="text-sm font-semibold text-white mb-2 block">Price (₹)</label>
                <input value={price} onChange={e => setPrice(e.target.value)} type="number" min="1" placeholder="299"
                  className="w-full px-4 py-3.5 rounded-xl text-base text-white outline-none" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }} />
              </div>

              <FileUploadField label="Cover image" accept="image/*" file={coverFile} onChange={setCoverFile} icon={ImageIcon}
                hint="Optional — shown on the storefront page." />

              <FileUploadField label="PDF file" accept="application/pdf" file={pdfFile} onChange={setPdfFile} icon={FileText}
                hint="Every download gets your buyer's name stamped into it automatically — nothing extra for you to do." />

              {createError && <p className="text-sm text-center" style={{ color: '#ef4444' }}>{createError}</p>}
              {createSuccess && <p className="text-sm text-center" style={{ color: 'var(--kurso-success)' }}>{createSuccess}</p>}

              <button type="submit" disabled={uploading}
                className="py-4 rounded-xl text-base font-bold text-white violet-gradient disabled:opacity-50 flex items-center justify-center gap-2">
                <Upload className="w-5 h-5" />
                {uploading ? 'Uploading...' : 'Add Ebook'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}

function DeleteEbookModal({
  ebook,
  onConfirm,
  onClose,
}: {
  ebook: Ebook
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
          <h2 className="text-lg font-semibold text-white">Delete Ebook</h2>
          <button onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg"
            style={{ background: 'rgba(255,255,255,0.06)', color: '#a1a1aa' }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-zinc-400">
            Delete <strong className="text-white">"{ebook.title}"</strong>? Buyers will lose access to
            downloads. This cannot be undone.
          </p>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-zinc-300">
              Type <span className="text-white font-semibold">{ebook.title}</span> to confirm
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder="Type ebook title here"
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
              disabled={confirmText.trim() !== ebook.title.trim()}
              className="flex-1 py-3 rounded-xl text-sm font-medium text-white disabled:opacity-50"
              style={{ background: '#ef4444' }}>
              Delete Ebook
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div className="p-5 rounded-2xl text-center" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center mx-auto mb-3" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
        <Icon className="w-4 h-4" style={{ color }} />
      </div>
      <p className="text-2xl font-black text-white">{value}</p>
      <p className="text-xs mt-1" style={{ color: 'var(--kurso-text-muted)' }}>{label}</p>
    </div>
  )
}

function FileUploadField({ label, accept, file, onChange, icon: Icon, hint }: {
  label: string; accept: string; file: File | null; onChange: (f: File | null) => void; icon: any; hint?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <label className="text-sm font-semibold text-white mb-2 block">{label}</label>
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={e => onChange(e.target.files?.[0] || null)} />
      {file ? (
        <div className="flex items-center justify-between gap-3 px-4 py-4 rounded-xl" style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.25)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--kurso-success)' }} />
            <span className="text-sm truncate" style={{ color: 'var(--kurso-success)' }}>{file.name}</span>
          </div>
          <button type="button" onClick={() => onChange(null)} className="text-xs font-semibold flex-shrink-0" style={{ color: '#a1a1aa' }}>
            Remove
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => inputRef.current?.click()}
          className="w-full flex items-center justify-center gap-2 px-4 py-5 rounded-xl text-sm font-bold transition-all"
          style={{ background: 'rgba(var(--kurso-primary-rgb),0.08)', border: '1.5px dashed rgba(var(--kurso-primary-rgb),0.35)', color: 'var(--kurso-primary-light)' }}>
          <Icon className="w-4 h-4" /> Upload {label}
        </button>
      )}
      {hint && <p className="text-xs mt-2" style={{ color: 'var(--kurso-text-muted)' }}>{hint}</p>}
    </div>
  )
}