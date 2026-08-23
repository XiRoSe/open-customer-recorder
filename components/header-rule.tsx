// The signature "half line": a short brass rule fading out beneath each
// page header — same accent as the cluster map's instrument face.
export function HeaderRule() {
  return (
    <div aria-hidden className="flex items-center gap-1.5 w-3/4">
      <div className="h-0.5 w-24 shrink-0 rounded-full bg-gradient-to-r from-[#B08D57] to-[#B08D57]/0" />
      <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
    </div>
  );
}
