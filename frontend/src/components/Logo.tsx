export function LogoMark({ className = 'h-9 w-9' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-label="Banco Andino">
      <rect width="64" height="64" rx="14" fill="#0B1F3A" />
      <circle cx="45" cy="19" r="6" fill="#E39A2D" />
      <path d="M6 50 24 22l9 13 6-8 19 23z" fill="#fff" />
      <path d="M24 22l-5.5 8.4 5.5 3.6 4-4.4z" fill="#BFD3EC" />
    </svg>
  );
}

export function Logo({ claro = false }: { claro?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <LogoMark />
      <div className="leading-none">
        <div className={`text-lg font-bold tracking-tight ${claro ? 'text-white' : 'text-andino-900'}`}>Banco Andino</div>
        <div className={`mt-1 text-[10px] font-semibold uppercase tracking-[0.28em] ${claro ? 'text-cobre-400' : 'text-cobre-600'}`}>
          Colombia
        </div>
      </div>
    </div>
  );
}
