export function Logo({ className = "", size = "md" }: { className?: string, size?: "sm" | "md" | "lg" }) {
  const sizeClasses = {
    sm: "w-8 h-8 text-sm",
    md: "w-10 h-10 text-base",
    lg: "w-14 h-14 text-xl"
  };

  return (
    <div 
      className={`flex items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary font-bold tracking-tighter shadow-[0_0_15px_rgba(0,212,164,0.2)] ${sizeClasses[size]} ${className}`}
    >
      TU
    </div>
  );
}
