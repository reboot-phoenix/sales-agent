import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, LayoutDashboard, Users, Building2, Contact, GitMerge, TrendingUp,
  Settings, LogOut, Zap, CornerDownLeft, Command, Trophy, GraduationCap, ServerCog,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/components/ui/toast';
import { searchAll } from '@/lib/api';
import { cn } from '@/components/ui/cn';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
  group: string;
}

// A Linear/Raycast-grade ⌘K palette: global navigation + quick actions.
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { user, logout, revokeCurrentToken } = useAuthStore();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // Open on ⌘K / Ctrl+K; Escape closes (handled below via window keydown).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('hiregen:open-palette', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('hiregen:open-palette', onOpen); };
  }, []);

  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 20); } }, [open]);

  const go = (path: string) => { navigate(path); setOpen(false); };
  const isAdmin = user?.role === 'admin';

  const commands = useMemo<Cmd[]>(() => {
    const nav: Cmd[] = [
      { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard />, group: 'Navigate', run: () => go('/dashboard') },
      { id: 'leads', label: 'Job Leads', hint: 'g', icon: <Users />, group: 'Navigate', run: () => go('/leads') },
      { id: 'hackathons', label: 'Hackathon Leads', icon: <Trophy />, group: 'Navigate', run: () => go('/hackathons') },
      { id: 'colleges', label: 'College Intelligence', icon: <GraduationCap />, group: 'Navigate', run: () => go('/colleges') },
      { id: 'my-leads', label: 'My Leads', icon: <Users />, group: 'Navigate', run: () => go('/my-leads') },
      { id: 'companies', label: 'Companies', icon: <Building2 />, group: 'Navigate', run: () => go('/companies') },
      { id: 'contacts', label: 'HR Contacts', icon: <Contact />, group: 'Navigate', run: () => go('/contacts') },
      { id: 'duplicates', label: 'Duplicates', icon: <GitMerge />, group: 'Navigate', run: () => go('/duplicates') },
      { id: 'analytics', label: 'Analytics', icon: <TrendingUp />, group: 'Navigate', run: () => go('/analytics') },
    ];
    if (isAdmin) nav.push({ id: 'armies', label: 'Scraper Armies', hint: 'ops', icon: <ServerCog />, group: 'Navigate', run: () => go('/armies') });
    if (isAdmin) nav.push({ id: 'settings', label: 'Settings', icon: <Settings />, group: 'Navigate', run: () => go('/settings') });
    const actions: Cmd[] = [
      { id: 'army', label: 'Run Full Army', hint: 'scrape + enrich all', icon: <Zap />, group: 'Actions', run: () => {
        if (!isAdmin) { toast({ title: 'Admin only', variant: 'warning' }); return; }
        // Never fire the army blind: hand off to the Dashboard/Leads confirm
        // dialog (they listen for this event). A direct runArmy() here was the
        // one path with no confirmation and no visible running state.
        setOpen(false);
        go('/dashboard');
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('hiregen:confirm-army')), 150);
      } },
      { id: 'logout', label: 'Sign out', icon: <LogOut />, group: 'Account', run: () => { revokeCurrentToken().then(() => logout()).then(() => go('/login')); } },
    ];
    return [...nav, ...actions];
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Entity search: the palette searches records (jobs, hackathons, colleges),
  // not just pages. Results stay grouped by domain — a college never looks like a
  // job lead — and each result navigates to its own detail page. The server
  // applies the same RBAC as the domain pages, so the palette cannot surface a
  // lead the corresponding page would hide.
  const needle = q.trim();
  const { data: searchData, isFetching: searching } = useQuery({
  queryKey: ['palette-search', needle],
  queryFn: () => searchAll.query(needle, ['jobs', 'hackathons', 'colleges']),
  enabled: needle.length >= 2, staleTime: 15000, placeholderData: keepPreviousData,
});

  const entityResults = useMemo<Cmd[]>(() => {
    const results = (searchData as any)?.results;
    if (!results) return [];
    const out: Cmd[] = [];
    for (const job of results.jobs || []) {
      out.push({
        id: `job-${job.id}`,
        label: job.company_name || 'Unknown company',
        hint: [job.job_title, job.city].filter(Boolean).join(' · ') || 'job lead',
        icon: <Users />,
        group: 'Job leads',
        run: () => go(`/leads/${job.id}`),
      });
    }
    for (const h of results.hackathons || []) {
      out.push({
        id: `hackathon-${h.id}`,
        label: h.name,
        hint: [h.organizer_name, h.status?.replace(/_/g, ' ')].filter(Boolean).join(' · '),
        icon: <Trophy />,
        group: 'Hackathons',
        run: () => go(`/hackathons/${h.id}`),
      });
    }
    for (const c of results.colleges || []) {
      out.push({
        id: `college-${c.id}`,
        label: c.name,
        hint: [c.city, c.state].filter(Boolean).join(', '),
        icon: <GraduationCap />,
        group: 'Colleges',
        run: () => go(`/colleges/${c.id}`),
      });
    }
    return out;
  }, [searchData]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const lower = needle.toLowerCase();
    if (!lower) return commands;
    const matched = commands.filter((c) => c.label.toLowerCase().includes(lower) || c.group.toLowerCase().includes(lower));
    return [...matched, ...entityResults];
  }, [needle, commands, entityResults]);

  // group into render slices while keeping a flat active index
  const groups = useMemo(() => {
    const map = new Map<string, { cmd: Cmd; flat: number }[]>();
    filtered.forEach((cmd, flat) => {
      if (!map.has(cmd.group)) map.set(cmd.group, []);
      map.get(cmd.group)!.push({ cmd, flat });
    });
    return [...map.entries()];
  }, [filtered]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-palette" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
              className="glass-strong relative mx-auto mt-[12vh] w-[92%] max-w-lg overflow-hidden rounded-2xl border border-border/70 shadow-float"
              onKeyDown={onKey}
            >
              <div className="flex items-center gap-3 border-b border-border px-4">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search commands & pages…" className="h-14 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground" />
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">esc</kbd>
              </div>
              <div className="max-h-[52vh] overflow-y-auto p-2">
                {filtered.length === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {searching ? 'Searching records…' : 'No results.'}
                  </p>
                )}
                {groups.map(([group, items]) => (
                  <div key={group} className="mb-1">
                    <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</p>
                    {items.map(({ cmd, flat }) => (
                      <button key={cmd.id} onMouseEnter={() => setActive(flat)} onClick={cmd.run} className={cn('flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-sm transition-colors', active === flat ? 'bg-primary-soft text-primary-hover' : 'text-foreground hover:bg-accent')}>
                        <span className="grid h-7 w-7 place-items-center rounded-lg bg-muted [&_svg]:h-4 [&_svg]:w-4">{cmd.icon}</span>
                        <span className="flex-1 font-medium">{cmd.label}</span>
                        {cmd.hint && <span className="text-[11px] text-muted-foreground">{cmd.hint}</span>}
                        {active === flat && <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
