'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { LayoutDashboard, BookOpen, Users, Settings, LogOut, Menu, X, Zap, IndianRupee, Ticket, Megaphone, BarChart3, ClipboardList, Undo, Library, MessageSquareWarning, Star, Calendar } from 'lucide-react'
import Logo from './Logo'
import { supabase } from '@/lib/supabase'

const navItems = [
  { label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Courses', href: '/dashboard/courses', icon: BookOpen },
  { label: 'Ebooks', href: '/dashboard/ebooks', icon: Library },
  { label: 'Students', href: '/dashboard/students', icon: Users },
  { label: 'Assignments', href: '/dashboard/assignments', icon: ClipboardList }, 
  { label: 'Workshops', href: '/dashboard/workshops', icon: Calendar }, 
  { label: 'Q&A Moderation', href: '/dashboard/moderation', icon: MessageSquareWarning },
  { label: 'Revenue', href: '/dashboard/revenue', icon: IndianRupee },
  { label: 'Refunds', href: '/dashboard/refunds', icon: Undo },
  { label: 'Ratings & Reviews', href: '/dashboard/ratings', icon: Star },
  { label: 'Coupons', href: '/dashboard/coupons', icon: Ticket },
  { label: 'Broadcast', href: '/dashboard/broadcast', icon: Megaphone },
  { label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3 },
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [mobileOpen, setMobileOpen] = useState(false)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const SidebarContent = () => (
    <div className="flex flex-col h-full relative">
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-6 border-b" style={{borderColor:'rgba(255,255,255,0.06)'}}>
        
          <Logo className="w-20 h-16" />
        
        
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-6 flex flex-col gap-1">
        {navItems.map(({ label, href, icon: Icon }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
              style={{
                background: active ? 'rgba(var(--kurso-primary-rgb), 0.15)' : 'transparent',
                color: active ? 'var(--kurso-primary-light)' : '#a1a1aa',
                border: active ? '1px solid rgba(var(--kurso-primary-rgb), 0.2)' : '1px solid transparent',
              }}
            >
              <Icon className="w-4 h-4" />
              {label}
            </Link>
          )
        })}
      </nav>

     {/* Billing button */}
      <div className="px-3 pb-2">
        <Link href="/upgrade"
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all w-full"
          style={{background:'rgba(var(--kurso-primary-rgb), 0.1)', color:'var(--kurso-primary-light)', border:'1px solid rgba(var(--kurso-primary-rgb), 0.2)'}}>
      <Zap className="w-4 h-4" />
      Billing
    </Link>
      </div>

      {/* Logout */}
      <div className="px-3 py-4 border-t" style={{borderColor:'rgba(255,255,255,0.06)'}}>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all"
          style={{color:'#a1a1aa'}}
          onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
          onMouseLeave={e => (e.currentTarget.style.color = '#a1a1aa')}
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-56 overflow-y-auto fixed left-0 z-40"
        style={{background:'#0a0a0a', borderRight:'1px solid rgba(255,255,255,0.06)', top:'var(--kurso-banner-offset, 0px)', height:'calc(100vh - var(--kurso-banner-offset, 0px))'}}>
        <SidebarContent />
      </aside>

      {/* Mobile toggle */}
      <button
        className="md:hidden fixed left-4 z-50 w-10 h-10 rounded-xl flex items-center justify-center"
        style={{background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.1)', top:'calc(1rem + var(--kurso-banner-offset, 0px))'}}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="w-5 h-5 text-white" /> : <Menu className="w-5 h-5 text-white" />}
      </button>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed left-0 right-0 bottom-0 z-40" style={{top:'var(--kurso-banner-offset, 0px)'}}>
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-56 flex flex-col overflow-y-auto"
            style={{background:'#0a0a0a', borderRight:'1px solid rgba(255,255,255,0.06)'}}>
            <SidebarContent />
          </aside>
        </div>
      )}
    </>
  )
}