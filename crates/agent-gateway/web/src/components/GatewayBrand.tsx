export function GatewayBrand() {
  return (
    <div data-app-sidebar-brand="" className="flex min-w-0 -translate-y-0.5 items-center gap-2">
      <img
        src="/zeroagent-logo.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="size-8 shrink-0 select-none rounded-xl object-contain"
      />
      <div className="truncate font-semibold tracking-tight">ZeroAgent</div>
    </div>
  );
}
